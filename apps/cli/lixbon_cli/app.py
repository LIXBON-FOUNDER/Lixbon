"""ChatApp: loop principal del CLI interactivo (transcript inline estilo Claude Code)."""
import os
import subprocess
import time
import uuid
from pathlib import Path

from lixbon_cli.agent import run_agent_turn, strip_tool_calls
from lixbon_cli.api import ApiClient, ApiError
from lixbon_cli.commands import (
    COMMAND_SPECS,
    encode_image,
    fmt_size,
    make_completer,
    parse_attachments,
)
from lixbon_cli.config import (
    CLI_VERSION,
    HISTORY_FILE,
    load_config,
    mask_key,
    save_config,
)
from lixbon_cli.term import g, is_interactive, setup_terminal
from lixbon_cli.theme import make_console, pt_style
from lixbon_cli.ui import (
    Option,
    StatusBar,
    esc,
    fmt_tokens,
    print_error,
    print_note,
    print_ok,
    render_header,
    render_welcome_box,
    select,
    spinner,
)

TOKENS_PER_IMAGE = 800  # estimación para la barra de contexto


class ChatApp:
    def __init__(self, model_override: str = "", client_id: str = "", title: str = ""):
        setup_terminal()
        self.console = make_console()
        self.cfg = load_config()
        self.api = ApiClient(self.cfg["base_url"], self.cfg.get("api_key", ""))
        self.model = self.cfg.get("key_model") or model_override or self.cfg.get("model", "")
        self.client_id = client_id or os.getenv("HOSTNAME", "cli-client")
        self.title = title or "Sesión CLI"
        self.mode = self.cfg.get("mode", "ask")
        self.workspace = Path(self.cfg.get("workspace") or Path.cwd()).resolve()
        if not self.workspace.is_dir():
            self.workspace = Path.cwd().resolve()
        self.session = {"auto_approve": bool(self.cfg.get("auto_approve_tools", False))}
        self.history: list[dict] = []
        self.conversation_id = str(uuid.uuid4())
        self.models_cache: list[str] = []
        self.pending_images: list[Path] = []
        self.session_tokens = 0
        self.chars_per_token = 4.0
        self.status = StatusBar(
            model=self.model or "sin modelo",
            session_label=self._session_label(),
            mode=self.mode,
        )
        self._interrupt_hint_at = 0.0

    # ── etiquetas y estado ───────────────────────────────────────────────

    def _session_label(self) -> str:
        if not self.cfg.get("api_key"):
            return "sin sesión"
        return self.cfg.get("account_email") or "API key"

    def _refresh_status(self) -> None:
        self.status.model = self.model or "sin modelo"
        self.status.session_label = self._session_label()
        self.status.mode = self.mode
        tokens, pct = self._estimate_context()
        self.status.tokens = self.session_tokens or tokens
        self.status.ctx_pct = pct

    def _estimate_context(self) -> tuple[int, float]:
        chars = sum(len(m.get("content", "")) for m in self.history)
        tokens = int(chars / max(self.chars_per_token, 1.0))
        tokens += TOKENS_PER_IMAGE * sum(len(m.get("images") or []) for m in self.history)
        window = max(int(self.cfg.get("context_window", 8192)), 1)
        return tokens, min(100.0, tokens * 100.0 / window)

    def _register_usage(self, usage: dict) -> None:
        prompt_tokens = int(usage.get("prompt_tokens") or 0)
        total = int(usage.get("total_tokens") or 0)
        if total:
            self.session_tokens += total
        # Recalibra la estimación chars/token con datos reales del server
        chars = sum(len(m.get("content", "")) for m in self.history)
        if prompt_tokens > 50 and chars > 200:
            self.chars_per_token = max(1.5, min(8.0, chars / prompt_tokens))

    # ── arranque ─────────────────────────────────────────────────────────

    def run(self, once: str = "") -> int:
        render_header(self.console, CLI_VERSION)

        if not self.cfg.get("api_key"):
            if not is_interactive():
                print_error("No hay sesión. Ejecuta el CLI en una terminal interactiva para iniciar sesión.")
                return 1
            render_welcome_box(self.console)
            if not self.onboarding_flow():
                return 1
        elif not once:
            render_welcome_box(self.console)

        self._load_models_quietly()
        if not self.model:
            if not self.pick_model():
                return 1

        self._refresh_status()

        if once:
            self.send_message(once)
            return 0

        if not is_interactive():
            print_error("Terminal no interactiva. Usa `lixbon chat --once \"mensaje\"` o una terminal real.")
            return 1

        print_note(f"Escribe un mensaje, o / para ver los comandos. Modo: {self.mode} {g('sep')} {self.workspace}")
        self.console.print()
        return self._prompt_loop()

    def _load_models_quietly(self) -> None:
        try:
            self.models_cache = self.api.models()
        except ApiError:
            self.models_cache = []

    def onboarding_flow(self) -> bool:
        print_note("No hay una sesión activa. Inicia sesión para continuar.")
        self.console.print()
        method = select("Método de acceso", [
            Option("Credenciales", "creds", "correo y contraseña"),
            Option("Crear cuenta", "register", "registrarse con correo"),
            Option("Clave de API", "key", "lixbon_sk_…"),
        ])
        if method is None:
            return False
        if method == "key":
            return self._login_with_key()
        return self._login_with_credentials(register=(method == "register"))

    def _prompt_text(self, label: str, password: bool = False) -> str | None:
        from prompt_toolkit import prompt as pt_prompt

        try:
            value = pt_prompt([("class:prompt", f"{label}: ")], is_password=password, style=pt_style())
            return value.strip()
        except (KeyboardInterrupt, EOFError):
            return None

    def _login_with_credentials(self, register: bool = False) -> bool:
        while True:
            email = self._prompt_text("Correo")
            if not email:
                return False
            password = self._prompt_text("Contraseña", password=True)
            if password is None:
                return False
            extra: dict = {}
            if register:
                extra["first_name"] = self._prompt_text("Nombre") or ""
                extra["last_name"] = self._prompt_text("Apellido") or ""
            try:
                with spinner("verificando credenciales…"):
                    if register:
                        self.api.register(email, password, extra["first_name"], extra["last_name"])
                        resp = self.api.login(email, password)
                    else:
                        resp = self.api.login(email, password)
            except ApiError as exc:
                print_error(str(exc))
                continue
            api_key = resp.get("api_key", "")
            if not api_key:
                print_error("El servidor no entregó una API key. Intenta de nuevo.")
                continue
            self.cfg["api_key"] = api_key
            self.cfg["key_model"] = ""
            self.cfg["account_email"] = email
            self.api.api_key = api_key
            save_config(self.cfg)
            print_ok(f"Sesión iniciada como {email}")
            return True

    def _login_with_key(self) -> bool:
        while True:
            raw = self._prompt_text("Pega tu clave (lixbon_sk_…)", password=True)
            if not raw:
                return False
            self.api.api_key = raw
            key_model = ""
            try:
                with spinner("verificando la clave…"):
                    try:
                        info = self.api.key_info()
                        key_model = info.get("key_model") or ""
                    except ApiError:
                        self.api.models()  # fallback: si lista modelos, la key sirve
            except ApiError as exc:
                print_error(f"Clave inválida: {exc}")
                self.api.api_key = self.cfg.get("api_key", "")
                continue
            self.cfg["api_key"] = raw
            self.cfg["key_model"] = key_model
            self.cfg["account_email"] = ""
            if key_model:
                self.model = key_model
                self.cfg["model"] = key_model
                print_ok(f"Clave vinculada al modelo {key_model} (modelo fijo)")
            else:
                print_ok("Clave de API verificada")
            save_config(self.cfg)
            return True

    def pick_model(self) -> bool:
        if self.cfg.get("key_model"):
            self.model = self.cfg["key_model"]
            return True
        if not self.models_cache:
            self._load_models_quietly()
        if not self.models_cache:
            print_error("No hay modelos disponibles en el servidor ahora mismo.")
            return False
        options = [Option(m, m) for m in self.models_cache]
        default = self.models_cache.index(self.model) if self.model in self.models_cache else 0
        chosen = select("Modelo", options, default=default)
        if chosen is None:
            return bool(self.model)
        self.model = chosen
        self.cfg["model"] = chosen
        save_config(self.cfg)
        return True

    # ── loop de entrada ──────────────────────────────────────────────────

    def _prompt_loop(self) -> int:
        from prompt_toolkit import PromptSession
        from prompt_toolkit.history import FileHistory

        HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
        session = PromptSession(
            message=[("class:prompt", f"{g('prompt')} ")],
            style=pt_style(),
            completer=make_completer(self),
            complete_while_typing=True,
            history=FileHistory(str(HISTORY_FILE)),
            bottom_toolbar=lambda: self.status.pt_toolbar(),
            mouse_support=False,  # el mouse queda libre para scroll/selección en el transcript
        )

        while True:
            self._refresh_status()
            try:
                text = session.prompt().strip()
            except KeyboardInterrupt:
                now = time.monotonic()
                if now - self._interrupt_hint_at < 2.5:
                    print_note("Hasta pronto.")
                    return 0
                self._interrupt_hint_at = now
                print_note("(Ctrl+C otra vez para salir)")
                continue
            except EOFError:
                print_note("Hasta pronto.")
                return 0

            if not text:
                continue
            if text.startswith("/"):
                if self._dispatch_command(text) is False:
                    return 0
                continue
            try:
                self.send_message(text)
            except ApiError as exc:
                print_error(str(exc))

    def _dispatch_command(self, text: str):
        parts = text[1:].split(" ", 1)
        name = parts[0].strip().lower()
        arg = parts[1].strip() if len(parts) > 1 else ""
        handler = getattr(self, f"cmd_{name.replace('-', '_')}", None)
        if handler is None:
            print_error(f"Comando no reconocido: /{name} — escribe / para ver el menú")
            return True
        try:
            return handler(arg)
        except ApiError as exc:
            print_error(str(exc))
            return True

    # ── envío de mensajes ────────────────────────────────────────────────

    def send_message(self, text: str) -> None:
        clean, at_images, errors = parse_attachments(text, self.workspace)
        for err in errors:
            print_error(err)
        if errors and not clean:
            return
        images = self.pending_images + at_images
        self.pending_images = []

        encoded: list[str] = []
        for path in images:
            try:
                encoded.append(encode_image(path))
                self.console.print(
                    f"[lx.dim]{g('image')} {esc(path.name)} ({fmt_size(path.stat().st_size)})[/]"
                )
            except ValueError as exc:
                print_error(str(exc))

        user_msg: dict = {"role": "user", "content": clean or text}
        if encoded:
            user_msg["images"] = encoded
        self.history.append(user_msg)

        try:
            if self.mode == "delegate":
                self._delegate_turn(clean or text)
            elif self.mode == "agent":
                assistant, self.history = run_agent_turn(
                    self.history, self.workspace, self.session, self._stream_assistant
                )
            else:
                assistant = self._stream_assistant(self._context_messages())
                self.history.append({"role": "assistant", "content": assistant})
        except ApiError:
            self.history.pop()
            raise
        self._refresh_status()

    def _context_messages(self) -> list[dict]:
        max_msgs = int(self.cfg.get("max_context_messages", 12))
        return self.history[-max_msgs:]

    def _stream_assistant(self, messages: list[dict]) -> str:
        """Streamea una respuesta con Live: thinking en gris, contenido en Markdown."""
        from rich.console import Group
        from rich.markdown import Markdown
        from rich.text import Text

        stream = self.api.chat_stream(
            model=self.model,
            messages=messages,
            conversation_id=self.conversation_id,
            client_id=self.client_id,
            title=self.title,
        )

        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        sources: list[dict] = []
        usage: dict = {}
        reasoning_started = 0.0
        reasoning_seconds = 0.0
        interrupted = False

        def _live_view():
            blocks = []
            if reasoning_parts:
                tail = "".join(reasoning_parts).strip().splitlines()[-3:]
                head = Text(f"{g('spark_alt')} pensando…", style="lx.dim")
                blocks.append(head)
                for line in tail:
                    blocks.append(Text(f"  {line}", style="lx.thinking"))
            if content_parts:
                blocks.append(Markdown("".join(content_parts)))
            if not blocks:
                blocks.append(Text(f"{g('spark_alt')} …", style="lx.dim"))
            blocks.append(self.status.rich_line())
            return Group(*blocks)

        def _final_view():
            blocks = []
            if reasoning_seconds > 0.5:
                blocks.append(Text(f"{g('spark_alt')} Pensó durante {reasoning_seconds:.1f}s", style="lx.dim2"))
            text = "".join(content_parts).strip()
            if self.mode == "agent":
                text = strip_tool_calls(text).strip() or f"[herramientas solicitadas {g('ellipsis')}]"
            blocks.append(Markdown(text) if text else Text("(sin respuesta)", style="lx.dim"))
            if interrupted:
                blocks.append(Text(f"{g('sep')} interrumpido {g('sep')}", style="lx.dim"))
            return Group(*blocks)

        from rich.live import Live

        self.console.print()
        with Live(_live_view(), console=self.console, refresh_per_second=8, transient=True) as live:
            try:
                for kind, payload in stream:
                    if kind == "reasoning":
                        if not reasoning_parts:
                            reasoning_started = time.monotonic()
                        reasoning_parts.append(payload)
                        reasoning_seconds = time.monotonic() - reasoning_started
                    elif kind == "content":
                        if reasoning_parts and not content_parts and reasoning_started:
                            reasoning_seconds = time.monotonic() - reasoning_started
                        content_parts.append(payload)
                    elif kind == "sources":
                        sources = payload
                    elif kind == "usage":
                        usage = payload
                    live.update(_live_view())
            except KeyboardInterrupt:
                interrupted = True
                stream.close()

        self.console.print(_final_view())
        if sources:
            self.console.print(f"[lx.dim]Fuentes web: " + "; ".join(
                str(s.get("url") or s.get("title") or "?") for s in sources[:5]) + "[/]")
        self.console.print()

        if usage:
            self._register_usage(usage)
        text = "".join(content_parts).strip()
        if interrupted:
            text += "\n[respuesta interrumpida por el usuario]"
        return text

    def _delegate_turn(self, text: str) -> None:
        with spinner("delegando al router…"):
            result = self.api.delegate(text)
        routing = result.get("routing", {})
        classification = result.get("classification", {})
        self.console.print()
        self.console.print(
            f"[lx.accent2]{g('spark')}[/] [bold lx.primary]Delegación[/] "
            f"[lx.beige]\\[{esc(routing.get('type', 'PLAN'))}][/] "
            f"[lx.dim]modelo {esc(routing.get('model', '?'))} {g('sep')} {result.get('execution_time_ms', 0)}ms[/]"
        )
        tags = "  ".join(
            f"{k}:{classification.get(v, '?')}"
            for k, v in (("intent", "intent"), ("complejidad", "complexity"),
                         ("dominio", "domain"), ("riesgo", "riskLevel"))
        )
        self.console.print(f"[lx.dim2]{tags}[/]")
        from rich.markdown import Markdown

        self.console.print(Markdown(result.get("response", "(sin respuesta)")))
        self.console.print()
        self.history.append({"role": "assistant", "content": result.get("response", "")})

    # ── comandos ─────────────────────────────────────────────────────────

    def cmd_help(self, arg: str):
        self.console.print()
        for name, args, desc in COMMAND_SPECS:
            cmd = f"/{name} {args}".strip()
            self.console.print(f"  [lx.accent2]{esc(f'{cmd:<26}')}[/] [lx.dim]{esc(desc)}[/]")
        self.console.print()
        return True

    def cmd_model(self, arg: str):
        if self.cfg.get("key_model"):
            print_error(f"Modelo fijo por la API key: {self.cfg['key_model']}")
            return True
        if not arg:
            self.pick_model()
            return True
        matches = [m for m in self.models_cache if arg.lower() in m.lower()]
        if len(matches) == 1:
            self.model = matches[0]
        elif len(matches) > 1:
            chosen = select("Coincidencias", [Option(m, m) for m in matches])
            if chosen is None:
                return True
            self.model = chosen
        else:
            self.model = arg
        self.cfg["model"] = self.model
        save_config(self.cfg)
        print_ok(f"Modelo: {self.model}")
        return True

    def cmd_mode(self, arg: str):
        valid = ("ask", "agent", "delegate")
        if arg and arg in valid:
            self.mode = arg
        else:
            chosen = select("Modo de trabajo", [
                Option("ask", "ask", "chat normal con el modelo"),
                Option("agent", "agent", "el modelo edita código en tu workspace"),
                Option("delegate", "delegate", "auto-routing inteligente del servidor"),
            ], default=valid.index(self.mode))
            if chosen is None:
                return True
            self.mode = chosen
        self.cfg["mode"] = self.mode
        save_config(self.cfg)
        if self.mode == "agent":
            print_note(f"Workspace del agente: {self.workspace}")
        return True

    def cmd_new(self, arg: str):
        self.history = []
        self.session_tokens = 0
        self.conversation_id = str(uuid.uuid4())
        print_ok("Conversación nueva")
        return True

    def cmd_compact(self, arg: str):
        if len(self.history) < 4:
            print_note("La conversación aún es corta; nada que compactar.")
            return True
        before_tokens, _ = self._estimate_context()
        prompt = {
            "role": "user",
            "content": (
                "Resume la conversación anterior en un único bloque conciso. "
                "Preserva: decisiones tomadas, fragmentos de código relevantes, "
                "datos concretos y tareas pendientes. Responde SOLO con el resumen."
            ),
        }
        with spinner("compactando conversación…"):
            resp = self.api.chat(
                model=self.model,
                messages=self.history + [prompt],
                conversation_id=None,
                client_id=self.client_id,
                title="compactación",
            )
        summary = (resp.get("choices", [{}])[0].get("message", {}).get("content", "")).strip()
        if not summary:
            print_error("No se pudo generar el resumen.")
            return True
        keep = self.history[-2:]
        self.history = [{
            "role": "system",
            "content": f"Resumen de la conversación previa:\n{summary}",
        }] + keep
        after_tokens, _ = self._estimate_context()
        self._refresh_status()
        print_ok(
            f"Conversación compactada: {fmt_tokens(before_tokens)} {g('arrow')} {fmt_tokens(after_tokens)} tokens"
        )
        return True

    def cmd_image(self, arg: str):
        if not arg:
            print_error("Uso: /image <ruta> — o escribe @ruta dentro del mensaje")
            return True
        path = Path(arg.strip('"'))
        if not path.is_absolute():
            path = self.workspace / path
        try:
            encode_image(path)  # valida formato y tamaño
        except ValueError as exc:
            print_error(str(exc))
            return True
        self.pending_images.append(path.resolve())
        print_ok(f"{g('image')} {path.name} se adjuntará al próximo mensaje")
        return True

    def cmd_usage(self, arg: str):
        with spinner("consultando uso…"):
            data = self.api.usage()
        self.console.print(
            f"[lx.dim]Uso global:[/] conversaciones {data.get('conversations', 0)} {g('sep')} "
            f"mensajes {data.get('messages', 0)} {g('sep')} tokens {fmt_tokens(int(data.get('total_tokens', 0)))}"
        )
        return True

    def cmd_nodes(self, arg: str):
        with spinner("consultando nodos…"):
            data = self.api.nodes()
        nodes = data.get("nodos", [])
        if not nodes:
            print_note("Sin nodos registrados; se usa el Ollama local del servidor.")
            return True
        for n in nodes:
            icon = f"[lx.ok]{g('dot')}[/]" if n.get("online") else f"[lx.err]{g('dot_empty')}[/]"
            cb = f" [lx.warn]\\[CB][/]" if n.get("circuit_breaker") else ""
            self.console.print(
                f"  {icon} [lx.primary]{esc(n.get('name', n.get('id')))}[/] "
                f"[lx.dim]score {n.get('score', 0)} {g('sep')} {len(n.get('modelos', []))} modelos[/]{cb}"
            )
        return True

    def cmd_status(self, arg: str):
        self.console.print()
        rows = [
            ("Modelo", self.model or "no configurado"),
            ("Modo", self.mode),
            ("Sesión", self._session_label()),
            ("API key", mask_key(self.cfg.get("api_key", ""))),
            ("Base URL", self.api.base_url),
            ("Workspace", str(self.workspace)),
            ("Auto-aprobar", "on" if self.session.get("auto_approve") else "off"),
            ("Ventana de contexto", f"{self.cfg.get('context_window', 8192)} tokens"),
        ]
        for label, value in rows:
            self.console.print(f"  [lx.dim]{label:<20}[/] [lx.primary]{esc(value)}[/]")
        self.console.print()
        return True

    def cmd_login(self, arg: str):
        if self.onboarding_flow():
            self._load_models_quietly()
            self._refresh_status()
        return True

    def cmd_key(self, arg: str):
        if not arg:
            return self.cmd_login("")
        self.api.api_key = arg
        try:
            with spinner("verificando la clave…"):
                info = self.api.key_info()
        except ApiError as exc:
            self.api.api_key = self.cfg.get("api_key", "")
            print_error(f"Clave inválida: {exc}")
            return True
        self.cfg["api_key"] = arg
        self.cfg["key_model"] = info.get("key_model") or ""
        if self.cfg["key_model"]:
            self.model = self.cfg["key_model"]
        save_config(self.cfg)
        print_ok("API key actualizada")
        return True

    def cmd_approve(self, arg: str):
        if arg in ("on", "off"):
            self.session["auto_approve"] = arg == "on"
        else:
            chosen = select("Auto-aprobar herramientas del agente", [
                Option("off", "off", "pedir confirmación en cada cambio (recomendado)"),
                Option("on", "on", "aplicar cambios sin preguntar"),
            ], default=1 if self.session.get("auto_approve") else 0)
            if chosen is None:
                return True
            self.session["auto_approve"] = chosen == "on"
        self.cfg["auto_approve_tools"] = self.session["auto_approve"]
        save_config(self.cfg)
        print_ok(f"Auto-aprobar: {'on' if self.session['auto_approve'] else 'off'}")
        return True

    def cmd_workspace(self, arg: str):
        if not arg:
            print_note(f"Workspace actual: {self.workspace}")
            return True
        new_ws = Path(arg).expanduser().resolve()
        if not new_ws.is_dir():
            print_error("Ruta inválida o no es una carpeta.")
            return True
        self.workspace = new_ws
        self.cfg["workspace"] = str(new_ws)
        save_config(self.cfg)
        print_ok(f"Workspace: {new_ws}")
        return True

    def cmd_context_window(self, arg: str):
        try:
            value = max(1024, int(arg))
        except ValueError:
            print_error("Uso: /context-window 8192")
            return True
        self.cfg["context_window"] = value
        save_config(self.cfg)
        self._refresh_status()
        print_ok(f"Ventana de contexto: {value} tokens")
        return True

    def cmd_copy(self, arg: str):
        last = next((m for m in reversed(self.history) if m.get("role") == "assistant"), None)
        if not last:
            print_note("No hay una respuesta para copiar.")
            return True
        text = last.get("content", "")
        try:
            if os.name == "nt":
                subprocess.run("clip", input=text, text=True, check=True)
            elif os.uname().sysname == "Darwin":  # type: ignore[attr-defined]
                subprocess.run("pbcopy", input=text, text=True, check=True)
            else:
                subprocess.run(["xclip", "-selection", "clipboard"], input=text, text=True, check=True)
            print_ok("Respuesta copiada al portapapeles")
        except Exception as exc:
            print_error(f"No se pudo copiar: {exc}")
        return True

    def cmd_clear(self, arg: str):
        self.console.clear()
        render_header(self.console, CLI_VERSION)
        return True

    def cmd_update(self, arg: str):
        from lixbon_cli.cli import cmd_update

        cmd_update(None)
        return True

    def cmd_exit(self, arg: str):
        print_note("Hasta pronto.")
        return False
