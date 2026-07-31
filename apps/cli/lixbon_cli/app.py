"""ChatApp: loop principal del CLI interactivo (transcript inline estilo Claude Code)."""
import os
import platform
import queue
import subprocess
import time
import uuid
from pathlib import Path

from lixbon_cli.agent import (
    TOOL_SCHEMAS,
    TOOL_SPECS,
    build_native_system_prompt,
    clean_prose,
    run_agent_turn,
    sanitize_for_plain_chat,
    workspace_tree,
)
from lixbon_cli.api import ApiClient, ApiError
from lixbon_cli.context import estimate_tokens, tools_tokens
from lixbon_cli.remote import REMOTE_COMMANDS, RemoteLink
from lixbon_cli.commands import (
    COMMAND_GROUPS,
    COMMAND_SPECS,
    command_matches,
    common_command_prefix,
    encode_image,
    fmt_size,
    make_completer,
    parse_attachments,
)
from lixbon_cli.clipboard import paste_image
from lixbon_cli.inputq import InputQueue
from lixbon_cli.config import (
    CLI_VERSION,
    CONFIG_DIR,
    CONFIG_FILE,
    HISTORY_FILE,
    load_config,
    mask_key,
    save_config,
)
from lixbon_cli.sessions import SessionStore, relative_time
from lixbon_cli.term import (
    attach_status_repaint,
    clear_screen,
    draw_status_line,
    g,
    is_interactive,
    release_status_line,
    repaint_status,
    reserve_status_line,
    set_status_painter,
    set_title,
    setup_terminal,
    status_line_active,
    term_size,
)
from lixbon_cli.theme import make_console, pt_style
from lixbon_cli.ui import (
    Option,
    StatusBar,
    Tail,
    esc,
    fmt_tokens,
    TOOL_VERB,
    print_error,
    print_note,
    print_ok,
    rail_text,
    render_action,
    render_action_result,
    render_header,
    render_intro_line,
    render_log_line,
    render_speaker,
    render_tips,
    render_user_message,
    rule,
    select,
    short_path,
    spinner,
)

TOKENS_PER_IMAGE = 800  # estimación para la barra de contexto

# Alto máximo de la vista viva del streaming. El Live es transitorio (se borra
# al cerrarse y el texto íntegro se imprime después), así que si creciera hasta
# llenar la pantalla taparía el turno anterior y al cerrarse daría un salto.
# Con una ventana fija se lee la cola de lo que escribe el modelo y el
# transcript de arriba se queda quieto.
LIVE_TAIL_ROWS = 20


class ChatApp:
    def __init__(self, model_override: str = "", client_id: str = "", title: str = ""):
        setup_terminal()
        self.console = make_console()
        self.cfg = load_config()
        self.api = ApiClient(self.cfg["base_url"], self.cfg.get("api_key", ""))
        self.model = self.cfg.get("key_model") or model_override or self.cfg.get("model", "")
        self.client_id = client_id or os.getenv("HOSTNAME", "cli-client")
        # Sin título fijo: el servidor lo genera tras el primer intercambio
        # (_maybe_autotitle). Antes iba "Sesión CLI" en CADA mensaje y todas
        # las conversaciones del CLI acababan llamándose igual.
        self.title = title or ""
        self.mode = self.cfg.get("mode", "ask")
        # El workspace es SIEMPRE la carpeta desde la que se lanzó el CLI
        # (como Claude Code); /workspace lo cambia solo para la sesión.
        self.workspace = Path.cwd().resolve()
        self.session = {
            "auto_approve": bool(self.cfg.get("auto_approve_tools", False)),
            # Comandos de shell: flag aparte de auto_approve (irreversibles).
            "auto_run_commands": bool(self.cfg.get("auto_run_commands", False)),
            # Tool-calling nativo del modelo (modo agent). Se apaga solo si el
            # modelo no lo soporta; entonces se usa el protocolo de texto.
            "native_tools": bool(self.cfg.get("native_tools", True)),
            # Ventana con la que el loop del agente calcula su presupuesto de
            # contexto. Es la misma que viaja como num_ctx a Ollama: si no
            # coincidieran, el agente podaría de más o de menos.
            "context_window": int(self.cfg.get("context_window", 16384)),
        }
        # tool_calls nativos del último stream (los consume _stream_agent)
        self._last_tool_calls: list[dict] = []
        # Estado del turno en curso: el rótulo "✦ Lixbon" se imprime una sola vez
        # y justo encima de la primera prosa, con el registro de acciones ya
        # arriba. `_turn_mark` recuerda cuántas líneas llevaba impresas el turno
        # para saber si hace falta aire entre el registro y la respuesta.
        self._spoke = False
        self._turn_mark = 0
        # Teclado durante el turno: se puede escribir mientras el agente
        # trabaja y lo escrito se ejecuta cuando termina (nunca a mitad).
        self.input_queue = InputQueue() if self.cfg.get("input_queue", True) else None
        self.history: list[dict] = []
        self.remote: RemoteLink | None = None  # host de /remote (takeover activo)
        self.conversation_id = str(uuid.uuid4())
        # Historial persistente: cada conversación sobrevive al cierre del CLI y
        # se puede reabrir con /history.
        self.sessions = SessionStore(CONFIG_DIR)
        self.models_cache: list[str] = []
        # Modelo que el gateway asigna al rol `chat` (GET /api/model-roles). Sirve
        # para no preguntar cuál usar cuando el servidor ya lo tiene decidido.
        # "" = gateway antiguo o sin modelo de chat resuelto.
        self.role_chat_model = ""
        # Plan comercial (Pro/Advance/Gratuito): se muestra en la cabecera.
        # Se cachea en el config para que el arranque no dependa de la red.
        self.plan_name = self.cfg.get("plan_name", "")
        self.pending_images: list[Path] = []
        self.web_search = bool(self.cfg.get("web_search", False))
        self.project_context = ""  # LIXBON.md del workspace, si lo hay
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
        self.status.web = self.web_search
        self.status.project = bool(self.project_context)
        tokens, pct = self._estimate_context()
        self.status.tokens = self.session_tokens or tokens
        self.status.ctx_pct = pct
        self._paint_status()

    def _paint_status(self) -> None:
        """Repinta la barra en su fila reservada (no hace nada si no la hay)."""
        if not status_line_active():
            return
        from lixbon_cli.theme import render_ansi

        cols, _ = term_size()
        width = max(cols, 20)
        try:
            line = self.status.rich_line(bar=True, width=width - 1)
            draw_status_line(render_ansi(line, width))
        except Exception:
            pass  # la barra nunca puede tumbar la sesión

    def _estimate_context(self) -> tuple[int, float]:
        # Mide lo que se ENVIARÁ al modelo, que NO es lo mismo en cada modo: en
        # ask son los últimos max_context_messages, pero en agent viaja el turno
        # entero (con los resultados de las herramientas, que es lo que pesa) más
        # el system prompt del agente. Medir solo el chat plano hacía que la
        # barra marcara 20 % con la ventana ya desbordada.
        if self.mode == "agent":
            sent = self.history
            extra = estimate_tokens([{"role": "system",
                                      "content": build_native_system_prompt(self.workspace)}])
            extra += tools_tokens(TOOL_SCHEMAS) if self.session.get("native_tools", True) else 0
        else:
            sent = self._context_messages()
            extra = 0
        chars = sum(len(m.get("content", "")) for m in sent)
        chars += sum(len(str(m.get("tool_calls") or "")) for m in sent)
        tokens = int(chars / max(self.chars_per_token, 1.0)) + extra
        tokens += TOKENS_PER_IMAGE * sum(len(m.get("images") or []) for m in sent)
        window = max(int(self.cfg.get("context_window", 16384)), 1)
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
        self._set_tab_title()
        self._load_project_context()
        # La sesión toma la terminal entera: fuera el banner de cmd/PowerShell
        # y la línea que lanzó el CLI. Todo lo que sigue (spinner, onboarding,
        # cabecera) se dibuja ya sobre lienzo limpio. Con la pantalla en blanco
        # es también el único momento seguro para reservar la fila de la barra
        # (DECSTBM manda el cursor a home).
        if not once:
            clear_screen()
            if self.cfg.get("fixed_status_bar", True):
                # El painter se registra ANTES de reservar: cualquier interfaz
                # de prompt_toolkit (prompt, selector) borra la fila con su
                # erase_down, y este callback es el que la devuelve a su sitio.
                set_status_painter(self._paint_status)
                reserve_status_line()

        if not self.cfg.get("api_key"):
            if not is_interactive():
                print_error("No hay sesión. Ejecuta el CLI en una terminal interactiva para iniciar sesión.")
                return 1
            render_intro_line(self.console, CLI_VERSION, "iniciar sesión")
            if not self.onboarding_flow():
                return 1

        # Con sesión no hay preámbulo: la marca se ve una sola vez, en la
        # cabecera de abajo, ya con modelo y plan resueltos.
        if once or not is_interactive():
            state = self._load_account_quietly()
        else:
            with spinner("conectando con Lixbon…"):
                state = self._load_account_quietly()

        # Una clave rechazada (logout desde la web, key revocada) dejaba entrar
        # al chat sin modelos y sin explicación: ahora se pide sesión de nuevo.
        if state == "auth":
            self._clear_session()
            print_error("Tu sesión ya no es válida (se cerró desde otro sitio o la clave fue revocada).")
            if once or not is_interactive():
                return 1
            if not self.onboarding_flow():
                return 1
            with spinner("conectando con Lixbon…"):
                state = self._load_account_quietly()
            self.model = self.cfg.get("key_model") or self.cfg.get("model", "")
        elif state == "offline":
            print_error("No se pudo contactar con el servidor; se trabajará con la configuración local.")

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

        # Zona 1: identidad (quién soy, con qué modelo y sobre qué carpeta).
        self._render_identity()
        # Zona 2: cómo se usa.
        render_tips(self.console)
        if self.mode == "ask":
            print_note("Modo ask: el modelo solo conversa. /mode agent para que cree y edite archivos.")
        # Zona 3: a partir de aquí, todo es conversación.
        rule(self.console, "conversación")
        try:
            return self._prompt_loop()
        finally:
            self._persist_session()  # salir del CLI no pierde la conversación
            release_status_line()

    def _render_identity(self) -> None:
        """Cabecera de identidad del CLI (sube con el transcript al chatear)."""
        render_header(self.console, CLI_VERSION, model=self.model,
                      plan=self.plan_name, workspace=self.workspace)

    def _set_tab_title(self) -> None:
        """La pestaña de la terminal deja de llamarse `cmd` y pasa a ser Lixbon.
        Con la conversación ya titulada, su nombre acompaña al workspace."""
        label = self.title or self.workspace.name
        set_title(f"{g('spark')} Lixbon {g('sep')} {label}")

    def _maybe_autotitle(self) -> None:
        """Pide el título de la conversación tras el primer intercambio.

        Mismo endpoint que la web y la app: el servidor lo resuelve con el
        modelo pequeño y, si el cluster no responde, con el primer mensaje.
        """
        if self.title or len(self.history) < 2 or not self.conversation_id:
            return
        try:
            title = str(self.api.generate_title(self.conversation_id).get("title") or "").strip()
        except Exception:
            return  # el título nunca puede tumbar el turno
        if title:
            self.title = title
            self._set_tab_title()

    def _load_account_quietly(self) -> str:
        """Modelos disponibles y plan del usuario, sin ruido si el server falla.

        Devuelve el estado de la sesión: `ok`, `auth` (la clave ya no sirve:
        logout desde la web, key revocada o rotada) u `offline` (no se pudo
        hablar con el servidor). Distinguirlos importa: antes cualquier fallo
        acababa igual — entrando al chat con la lista de modelos vacía.
        """
        auth_failed = False
        try:
            self.models_cache = self.api.models()
        except ApiError as exc:
            self.models_cache = []
            auth_failed = exc.status in (401, 403)
        # Qué modelo sirve el rol `chat` según el servidor (no falla nunca: el
        # método devuelve {} con un gateway que no conozca los roles).
        roles = self.api.model_roles().get("roles") or {}
        self.role_chat_model = str((roles.get("chat") or {}).get("model") or "")
        if not self.cfg.get("api_key"):
            return "auth"
        try:
            plan = (self.api.key_info().get("plan") or {}).get("name") or ""
        except ApiError as exc:
            if exc.status in (401, 403):
                return "auth"
            # servidor viejo o sin red: se conserva el plan cacheado
            return "auth" if auth_failed else ("ok" if self.models_cache else "offline")
        if plan and plan != self.plan_name:
            self.plan_name = plan
            self.cfg["plan_name"] = plan
            save_config(self.cfg)
        return "auth" if auth_failed else "ok"

    # ── sesiones (conversaciones persistentes) ───────────────────────────

    def _persist_session(self) -> None:
        """Guarda la conversación en curso en el historial local.

        Se llama al final de cada turno y al salir, así que cerrar la terminal
        (o que se caiga) nunca pierde lo hablado.
        """
        self.sessions.save(
            self.conversation_id, self.history,
            title=self.title, model=self.model, mode=self.mode,
            workspace=str(self.workspace), tokens=self.session_tokens,
        )

    def _new_session(self, label: str = "conversación nueva") -> None:
        """Empieza una conversación DE VERDAD nueva.

        Nuevo id de conversación (el servidor abre otra), contexto vacío y
        pantalla limpia. Antes `/clear` solo borraba lo visible: el modelo
        seguía recibiendo el contexto anterior y no había forma real de
        empezar de cero sin cerrar el CLI.
        """
        self._persist_session()  # lo anterior no se pierde: queda en /history
        self.history = []
        self.session_tokens = 0
        self.conversation_id = str(uuid.uuid4())
        self.title = ""  # la nueva conversación se titulará sola al responder
        self.pending_images = []
        self._set_tab_title()
        clear_screen()
        self._render_identity()
        rule(self.console, label)
        self._paint_status()  # el 2J del clear también borró la fila reservada
        self._refresh_status()

    def _open_session(self, session_id: str) -> bool:
        """Reabre una conversación guardada: contexto, id y transcript."""
        record = self.sessions.load(session_id)
        if not record:
            print_error("Esa conversación ya no está disponible.")
            return False
        self._persist_session()  # la actual se guarda antes de cambiar
        self.history = list(record.get("messages") or [])
        self.conversation_id = record.get("id") or session_id
        self.title = record.get("title") or ""
        self.session_tokens = int(record.get("tokens") or 0)
        self.pending_images = []
        self._set_tab_title()
        clear_screen()
        self._render_identity()
        rule(self.console, self.title or "conversación")
        self._replay_transcript()
        self._refresh_status()
        return True

    def _replay_transcript(self) -> None:
        """Repinta una conversación cargada del historial.

        No reproduce la fontanería del turno (diffs, aprobaciones): las
        herramientas se resumen en una línea cada una, que es lo que hace
        legible una conversación larga al reabrirla.
        """
        from rich.markdown import Markdown

        for msg in self.history:
            role = msg.get("role")
            content = (msg.get("content") or "").strip()
            if role == "user":
                if content.startswith("TOOL_RESULT"):
                    continue
                render_user_message(self.console, content)
            elif role == "assistant":
                for call in msg.get("tool_calls") or []:
                    fn = (call.get("function") or {}).get("name", "herramienta")
                    render_action(self.console, TOOL_VERB.get(fn, fn), "", readonly=True)
                prose = clean_prose(content) if self.mode == "agent" else content
                if prose:
                    self.console.print()
                    render_speaker(self.console)
                    self.console.print(Markdown(prose))
        self.console.print()
        rule(self.console, "continúa la conversación")

    def _clear_session(self) -> None:
        """Olvida la sesión local (logout o clave rechazada por el servidor)."""
        self.cfg["api_key"] = ""
        self.cfg["key_model"] = ""
        self.cfg["account_email"] = ""
        self.cfg["plan_name"] = ""
        save_config(self.cfg)
        self.api.api_key = ""
        self.plan_name = ""
        self.models_cache = []

    def _report_api_error(self, exc: ApiError) -> None:
        """Errores del servidor con la acción que los resuelve, no el crudo."""
        if exc.status in (401, 403):
            print_error("Tu sesión ya no es válida. Usa /login para volver a entrar.")
        elif exc.status == 402:
            print_error(f"Sin créditos disponibles: {exc}")
        elif exc.status == 429:
            print_error("Demasiadas peticiones seguidas; espera unos segundos.")
        else:
            print_error(str(exc))

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
        from lixbon_cli.term import ui_capable

        try:
            if not ui_capable():
                if password:
                    import getpass

                    return getpass.getpass(f"  {label}: ").strip()
                return input(f"  {label}: ").strip()
            from prompt_toolkit import prompt as pt_prompt

            value = pt_prompt(
                [("", "  "), ("class:prompt", f"{label}: ")],
                is_password=password,
                style=pt_style(),
            )
            repaint_status()  # el prompt borró la fila reservada al cerrarse
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
            with spinner("consultando modelos…"):
                state = self._load_account_quietly()
            if state == "auth":
                print_error("Tu sesión ya no es válida. Usa /login para volver a entrar.")
                return False
        if not self.models_cache:
            print_error("El servidor no está publicando modelos ahora mismo — revísalo con /nodes.")
            return False
        # El servidor ya decidió cuál es el modelo de chat: no hay nada que
        # preguntar la primera vez. El selector sigue disponible con /model.
        if not self.model and self.role_chat_model in self.models_cache:
            self.model = self.role_chat_model
            self.cfg["model"] = self.model
            save_config(self.cfg)
            print_ok(f"Modelo: {self.model} (el que el servidor usa para chat)")
            return True
        options = [Option(m, m, badge="actual" if m == self.model else "")
                   for m in self.models_cache]
        default = self.models_cache.index(self.model) if self.model in self.models_cache else 0
        chosen = select("Modelo", options, default=default)
        if chosen is None:
            return bool(self.model)
        self.model = chosen
        self.cfg["model"] = chosen
        save_config(self.cfg)
        return True

    # ── loop de entrada ──────────────────────────────────────────────────

    def _completion_bindings(self):
        """Enter resuelve el comando escrito a medias y lo ejecuta.

        Antes esto dependía del menú de prompt_toolkit (`has_completions`), y ahí
        estaba el fallo: con `complete_while_typing` las sugerencias se calculan
        en una tarea de fondo, así que escribir «/re» y pulsar Enter enseguida
        llegaba con el menú todavía vacío y se enviaba «/re» tal cual. Resolver
        el prefijo contra el catálogo es síncrono y no tiene esa carrera.
        """
        from prompt_toolkit.document import Document
        from prompt_toolkit.filters import completion_is_selected
        from prompt_toolkit.key_binding import KeyBindings

        kb = KeyBindings()

        def _set_line(buff, value: str) -> None:
            buff.document = Document(value, len(value))

        # Handler general. Se registra ANTES del de "completado seleccionado"
        # porque prompt_toolkit se queda con la ÚLTIMA vinculación aplicable.
        @kb.add("enter")
        def _enter(event):
            buff = event.current_buffer
            text = buff.text.strip()
            if not text.startswith("/"):
                buff.validate_and_handle()
                return

            head, _sep, rest = text[1:].partition(" ")
            rest = rest.strip()
            matches = command_matches(head)

            # Nombre completo (o basura que no es comando): enviar y que el
            # dispatcher decida; él ya sabe explicar un comando desconocido.
            if not matches or any(spec[0] == head.lower() for spec in matches):
                buff.cancel_completion()
                buff.validate_and_handle()
                return

            if len(matches) > 1:
                shared = common_command_prefix([spec[0] for spec in matches])
                if rest:
                    # Ya hay argumento: el menú no puede desambiguar (solo
                    # completa nombres), así que se envía y el dispatcher
                    # responde con los candidatos en vez de dejar Enter mudo.
                    buff.cancel_completion()
                    buff.validate_and_handle()
                    return
                # Ambiguo: se avanza hasta donde todos coinciden y se abre el
                # menú, en vez de elegir por el usuario o enviar un no-comando.
                if len(shared) > len(head):
                    _set_line(buff, f"/{shared}")
                buff.start_completion(select_first=False)
                return

            name, args = matches[0][0], matches[0][1]
            if rest:
                # «/mod gpt» → «/model gpt»: el argumento ya está escrito.
                _set_line(buff, f"/{name} {rest}")
                buff.cancel_completion()
                buff.validate_and_handle()
                return
            if args:
                # Lleva argumento: se completa y se espera a que lo escriba.
                _set_line(buff, f"/{name} ")
                buff.start_completion(select_first=False)
                return
            # Sin argumentos: un solo Enter completa y ejecuta.
            _set_line(buff, f"/{name}")
            buff.cancel_completion()
            buff.validate_and_handle()

        @kb.add("escape", "v")
        def _paste(event):
            # Alt+V llega como Esc+v. `run_in_terminal` suspende el prompt para
            # imprimir por encima y lo restaura: escribir directo dejaría el
            # mensaje pisado por el siguiente repintado de prompt_toolkit.
            from prompt_toolkit.application import run_in_terminal

            run_in_terminal(self._paste_clipboard_image)

        @kb.add("enter", filter=completion_is_selected)
        def _enter_selected(event):
            # El usuario navegó el menú con las flechas: Enter elige lo marcado.
            buff = event.current_buffer
            buff.apply_completion(buff.complete_state.current_completion)

        return kb

    def _prompt_loop(self) -> int:
        from lixbon_cli.term import ui_capable

        if not ui_capable():
            print_note("Interfaz simplificada: esta terminal no soporta la interfaz completa.")
            print_note("Para la experiencia completa usa Windows Terminal (o `winpty lixbon` en Git Bash).")
            return self._prompt_loop_plain()

        from prompt_toolkit import PromptSession
        from prompt_toolkit.history import FileHistory

        HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
        session = PromptSession(
            message=[("", "  "), ("class:prompt", f"{g('prompt')} ")],
            style=pt_style(),
            completer=make_completer(self),
            complete_while_typing=True,
            key_bindings=self._completion_bindings(),
            history=FileHistory(str(HISTORY_FILE)),
            # Con la fila reservada la barra la pinta el CLI y queda fija; el
            # bottom_toolbar de prompt_toolkit solo vive mientras hay prompt
            # (por eso desaparecía al enviar), así que sería un duplicado.
            bottom_toolbar=None if status_line_active() else (lambda: self.status.pt_toolbar()),
            reserve_space_for_menu=9,
            mouse_support=False,  # el mouse queda libre para scroll/selección en el transcript
        )
        # Sin esto la barra fija se pinta y prompt_toolkit la borra en el mismo
        # instante (erase_down del primer render): nunca llegaba a verse.
        attach_status_repaint(session.app)

        while True:
            self._refresh_status()
            # Lo tecleado durante el turno se ejecuta ahora, antes de volver a
            # preguntar: en orden, uno detrás de otro y con el agente ya parado.
            ran = self._run_queued_input()
            if ran is False:
                return 0
            if ran:
                continue  # esos turnos pueden haber dejado más en la cola
            try:
                # Lo que se quedó a medio escribir durante el turno reaparece
                # en el prompt, listo para seguir.
                partial = self.input_queue.take_partial() if self.input_queue else ""
                text = session.prompt(default=partial).strip()
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

            if self._handle_input(text) is False:
                return 0

    def _prompt_loop_plain(self) -> int:
        """Loop sin prompt_toolkit (Git Bash/mintty): input() plano."""
        while True:
            self._refresh_status()
            try:
                text = input(f"  {g('prompt')} ").strip()
            except KeyboardInterrupt:
                print()
                print_note("Hasta pronto.")
                return 0
            except EOFError:
                print_note("Hasta pronto.")
                return 0
            if self._handle_input(text) is False:
                return 0

    def _handle_input(self, text: str):
        if not text:
            return True
        if text.startswith("/"):
            return self._dispatch_command(text)
        try:
            self.send_message(text)
        except ApiError as exc:
            self._report_api_error(exc)
        return True

    def _dispatch_command(self, text: str):
        parts = text[1:].split(" ", 1)
        name = parts[0].strip().lower()
        arg = parts[1].strip() if len(parts) > 1 else ""
        handler = getattr(self, f"cmd_{name.replace('-', '_')}", None)
        if handler is None:
            # Un prefijo ambiguo («/mod algo») llega aquí a propósito: la barra
            # de comandos no puede desambiguar cuando ya hay un argumento.
            near = [spec[0] for spec in command_matches(name)][:4]
            if not near:
                near = [spec[0] for spec in command_matches(name[:3])][:4]
            hint = f" — ¿quisiste decir {', '.join('/' + n for n in near)}?" if near else \
                   " — escribe / para ver el menú"
            print_error(f"Comando no reconocido: /{name}{hint}")
            return True
        try:
            return handler(arg)
        except ApiError as exc:
            self._report_api_error(exc)
            return True

    # ── envío de mensajes ────────────────────────────────────────────────

    def send_message(self, text: str, origin: str = "local") -> None:
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
        if origin != "local":
            # El mensaje llegó por /remote: aquí nadie lo tecleó, así que el
            # transcript local tiene que mostrarlo para no perder el hilo.
            render_user_message(self.console, clean or text)
        if self.remote:
            self.remote.emit("user_msg", text=clean or text, origin=origin)
            self.remote.emit("status", state="thinking")

        # Aire entre la pregunta y el turno. El rótulo del asistente NO va aquí:
        # lo imprime _speak_once() cuando hay algo que decir, por debajo del
        # registro de acciones, para que abra la respuesta y no la fontanería.
        self.console.print()
        self._spoke = False
        self._turn_mark = self.console.writes
        self._start_input_queue()
        try:
            if self.mode == "delegate":
                self._delegate_turn(clean or text)
            elif self.mode == "agent":
                assistant, self.history = run_agent_turn(
                    self.history, self.workspace, self.session, self._stream_agent
                )
            else:
                assistant = self._stream_assistant(self._context_messages())
                self.history.append({"role": "assistant", "content": assistant})
        except ApiError:
            self.history.pop()
            raise
        finally:
            self._stop_input_queue()
            if self.remote:
                self.remote.emit("status", state="idle")
        self._maybe_autotitle()
        self._persist_session()  # el historial se actualiza turno a turno
        self._refresh_status()

    # ── teclado durante el turno ─────────────────────────────────────────

    def _start_input_queue(self) -> None:
        """Empieza a escuchar el teclado mientras el agente trabaja.

        No se activa con `/remote`: ahí quien conduce es el móvil y el teclado
        local está deliberadamente en pausa.
        """
        from lixbon_cli.term import ui_capable

        if self.input_queue is None or self.remote or not ui_capable():
            return
        self.input_queue.start()

    def _stop_input_queue(self) -> None:
        if self.input_queue is not None:
            self.input_queue.stop()

    def _typing_row(self):
        """Fila de la vista viva con lo tecleado y lo que ya está en cola."""
        from rich.text import Text

        queue = self.input_queue
        if queue is None or not queue.running:
            return None
        typed, pending = queue.typing, queue.queued
        if not typed and not pending:
            return None
        parts = []
        if typed:
            parts += [(f"{g('prompt')} ", "lx.accent2"), (typed, "lx.primary"),
                      (g("block"), "lx.dim2")]
        if pending:
            label = f"{pending} en cola" if pending > 1 else "1 en cola"
            parts.append((f"{'   ' if typed else ''}{label} {g('sep')} se envía al terminar",
                          "lx.dim2"))
        return Text.assemble(*parts)

    def _queue_interrupted(self) -> bool:
        """Ctrl+C durante el turno: con el lector activo no llega como señal."""
        queue = self.input_queue
        if queue is None or not queue.interrupted:
            return False
        queue.interrupted = False
        return True

    def _run_queued_input(self):
        """Ejecuta lo tecleado durante el turno.

        Devuelve `False` si toca salir del CLI, o el número de líneas que ha
        ejecutado (que pueden haber dejado más en la cola).
        """
        queue = self.input_queue
        if queue is None:
            return 0
        lines = queue.drain()
        for line in lines:
            # Se repite en el transcript como si se acabara de escribir: sin el
            # eco, una respuesta aparecería sin pregunta a la vista.
            render_user_message(self.console, line)
            if self._handle_input(line) is False:
                return False
        return len(lines)

    def _speak_once(self) -> None:
        """Abre la zona de respuesta: rótulo `✦ Lixbon`, una vez por turno.

        Va justo encima de la primera prosa del turno, no al empezar a trabajar.
        Si el registro de acciones ya escribió algo, se separa con una línea en
        blanco: la respuesta necesita aire propio para despegarse del canal.
        """
        if self._spoke:
            return
        self._spoke = True
        if self.console.writes > self._turn_mark:
            self.console.print()
        render_speaker(self.console)

    def _load_project_context(self) -> None:
        """LIXBON.md del workspace: contexto permanente del proyecto.

        Es el equivalente al CLAUDE.md de otros CLIs — lo genera /init y a
        partir de ahí viaja con cada turno, así el modelo no tiene que
        redescubrir el stack y las convenciones en cada sesión.
        """
        self.project_context = ""
        for name in ("LIXBON.md", "lixbon.md"):
            candidate = self.workspace / name
            try:
                if candidate.is_file():
                    text = candidate.read_text(encoding="utf-8", errors="replace").strip()
                    if text:
                        self.project_context = text[:12000]
                    return
            except OSError:
                return

    def _context_messages(self) -> list[dict]:
        max_msgs = int(self.cfg.get("max_context_messages", 12))
        # El historial puede traer el round-trip de tools de un turno de agente;
        # recortado a los últimos N quedaría descolgado y rompería el template.
        messages = sanitize_for_plain_chat(self.history)[-max_msgs:]
        if self.project_context:
            return [{
                "role": "system",
                "content": f"Contexto del proyecto (LIXBON.md):\n{self.project_context}",
            }] + messages
        return messages

    def _stream_agent(self, messages: list[dict], tools: list[dict] | None = None):
        """Un paso del agente: devuelve (texto, tool_calls nativos).

        Si el modelo no soporta tool-calling nativo, Ollama responde con un error
        y el turno pasa al protocolo de texto para el resto de la sesión.
        """
        try:
            text = self._stream_assistant(messages, tools=tools)
        except ApiError as exc:
            if tools and "tool" in str(exc).lower():
                self.session["native_tools"] = False
                print_note(f"{self.model} no soporta herramientas nativas: "
                           "el agente pasa al protocolo de texto.")
                text = self._stream_assistant(
                    sanitize_for_plain_chat(messages), tools=None)
            else:
                raise
        return text, self._last_tool_calls

    def _stream_assistant(self, messages: list[dict], tools: list[dict] | None = None) -> str:
        """Streamea una respuesta con Live: thinking en gris, contenido en Markdown."""
        from rich.console import Group
        from rich.markdown import Markdown
        from rich.text import Text

        self._last_tool_calls = []
        stream = self.api.chat_stream(
            model=self.model,
            messages=messages,
            conversation_id=self.conversation_id,
            client_id=self.client_id,
            title=self.title,
            web_search=self.web_search,
            num_ctx=self.cfg.get("context_window"),
            tools=tools,
        )

        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        sources: list[dict] = []
        usage: dict = {}
        reasoning_started = 0.0
        reasoning_seconds = 0.0
        interrupted = False

        from lixbon_cli.theme import pad

        def _live_view():
            blocks = []
            if reasoning_parts:
                # El razonamiento es trabajo, no respuesta: va en el canal, igual
                # que las acciones, para que en vivo se distinga de lo que dirá.
                tail = "".join(reasoning_parts).strip().splitlines()[-3:]
                blocks.append(Text.assemble(
                    rail_text(), (f"{g('spark_alt')} pensando…", "lx.dim")))
                for line in tail:
                    blocks.append(Text.assemble(rail_text(), (line, "lx.thinking")))
            if content_parts:
                raw = "".join(content_parts)
                if self.mode == "agent":
                    # En vivo se muestra la prosa, no el JSON de las llamadas:
                    # las herramientas aparecen luego en el bloque de acciones.
                    prose = clean_prose(raw)
                    blocks.append(Markdown(prose) if prose
                                  else Text(f"{g('spark_alt')} preparando acciones…", style="lx.dim"))
                else:
                    blocks.append(Markdown(raw))
            if not blocks:
                blocks.append(Text(
                    f"{g('spark_alt')} preparando acciones…" if self._last_tool_calls
                    else f"{g('spark_alt')} …", style="lx.dim"))
            # Con la fila reservada la barra ya está clavada abajo; repetirla
            # aquí la pegaría al texto que va saliendo.
            if not status_line_active():
                blocks.append(self.status.rich_line(compact=True))
            # Lo que se está tecleando mientras el modelo responde. Va al final
            # del bloque vivo (donde estaría el prompt) y el `Tail` lo conserva
            # aunque la respuesta desborde: escribir a ciegas sería peor que no
            # poder escribir.
            typed_row = self._typing_row()
            if typed_row is not None:
                blocks.append(typed_row)
            # La vista viva se queda en la cola: una respuesta larga desbordaría
            # la pantalla y el borrado del Live dejaría el hueco de vuelta. El
            # texto íntegro lo imprime _final_body() al cerrar el Live.
            rows = min(self.console.size.height - 2, LIVE_TAIL_ROWS)
            return Tail(pad(Group(*blocks)), max(rows, 4))

        def _final_body():
            """Lo que el modelo DICE, ya sin la fontanería del turno.

            El resumen del razonamiento no entra aquí: se imprime aparte y
            dentro del canal, porque pertenece al registro de trabajo.
            """
            blocks = []
            text = "".join(content_parts).strip()
            if self.mode == "agent":
                # Paso intermedio del agente (solo tool calls): no hay prosa que
                # mostrar — lo que sigue es el bloque de acciones, que ya se lee.
                text = clean_prose(text)
                if text:
                    blocks.append(Markdown(text))
            else:
                blocks.append(Markdown(text) if text else Text("(sin respuesta)", style="lx.dim"))
            if interrupted:
                blocks.append(Text(f"{g('sep')} interrumpido {g('sep')}", style="lx.dim"))
            return Group(*blocks) if blocks else None

        from rich.live import Live

        # La barra fija deja de ser un adorno estático: acompaña al turno.
        self.status.extra = "respondiendo…"
        self._paint_status()
        last_paint = time.monotonic()
        with Live(
            _live_view(),
            console=self.console,
            refresh_per_second=8,
            transient=True,
            # Tail ya acota el alto; `crop` es la red por si un renderable
            # midiera distinto — "ellipsis" añadiría una línea de "..." que
            # descuadraría el borrado.
            vertical_overflow="crop",
        ) as live:
            try:
                for kind, payload in stream:
                    if time.monotonic() - last_paint > 0.4:
                        # El transcript crece y arrastra el scroll; repintar
                        # cada poco garantiza que la barra siga entera.
                        last_paint = time.monotonic()
                        self._paint_status()
                    if (self.remote and self.remote.interrupt_requested) or self._queue_interrupted():
                        # Interrupción pedida desde el móvil/web, o Ctrl+C con el
                        # lector de teclado activo (ahí no llega como señal).
                        if self.remote:
                            self.remote.interrupt_requested = False
                        interrupted = True
                        stream.close()
                        break
                    if kind == "reasoning":
                        if not reasoning_parts:
                            reasoning_started = time.monotonic()
                        reasoning_parts.append(payload)
                        reasoning_seconds = time.monotonic() - reasoning_started
                    elif kind == "content":
                        if reasoning_parts and not content_parts and reasoning_started:
                            reasoning_seconds = time.monotonic() - reasoning_started
                        content_parts.append(payload)
                        if self.remote:
                            self.remote.emit("assistant_delta", text=payload)
                    elif kind == "tool_calls":
                        # Tool-calling nativo: Ollama los manda enteros; el
                        # bloque de acciones los renderiza al cerrar el stream.
                        self._last_tool_calls.extend(payload)
                    elif kind == "sources":
                        sources = payload
                    elif kind == "usage":
                        usage = payload
                    live.update(_live_view())
            except KeyboardInterrupt:
                interrupted = True
                stream.close()

        self.status.extra = ""
        if reasoning_seconds > 0.5:
            render_log_line(self.console,
                            f"{g('spark_alt')} pensó {reasoning_seconds:.1f} s", "lx.dim2")
        body = _final_body()
        if body is not None:
            self._speak_once()
            self.console.print(body)
            if sources:
                # Pie de la respuesta, no del registro: las fuentes son de lo
                # que acaba de decir, así que se quedan con ella.
                self.console.print("[lx.dim2]fuentes: " + esc("; ".join(
                    str(s.get("url") or s.get("title") or "?") for s in sources[:5])) + "[/]")
            self.console.print()

        if usage:
            self._register_usage(usage)
        self._refresh_status()  # tokens/contexto nuevos → repinta la barra fija
        text = "".join(content_parts).strip()
        if self.remote:
            # El controller reemplaza lo streameado por el texto final limpio
            # (en modo agent, los JSON de herramientas desaparecen del transcript)
            display = clean_prose(text) if self.mode == "agent" else text
            self.remote.emit("assistant_done", text=display, interrupted=interrupted)
        if interrupted:
            text += "\n[respuesta interrumpida por el usuario]"
        return text

    def _delegate_turn(self, text: str) -> None:
        with spinner("delegando al router…"):
            result = self.api.delegate(text)
        routing = result.get("routing", {})
        classification = result.get("classification", {})
        # Cómo se enrutó es registro de trabajo, no respuesta: va en el canal.
        render_log_line(
            self.console,
            f"delegó a {routing.get('model', '?')} "
            f"[{routing.get('type', 'PLAN')}] {g('sep')} {result.get('execution_time_ms', 0)} ms",
        )
        render_log_line(self.console, "  ".join(
            f"{k}:{classification.get(v, '?')}"
            for k, v in (("intent", "intent"), ("complejidad", "complexity"),
                         ("dominio", "domain"), ("riesgo", "riskLevel"))
        ), "lx.dim2")
        from rich.markdown import Markdown

        self._speak_once()
        self.console.print(Markdown(result.get("response", "(sin respuesta)")))
        self.console.print()
        self.history.append({"role": "assistant", "content": result.get("response", "")})

    # ── comandos ─────────────────────────────────────────────────────────

    def cmd_help(self, arg: str):
        """Menú de comandos navegable: elegir una fila ejecuta el comando."""
        if arg in ("plain", "list") or not is_interactive():
            self.console.print()
            for group in COMMAND_GROUPS:
                self.console.print(f"  [lx.dim2]{group}[/]")
                for name, args, desc, grp in COMMAND_SPECS:
                    if grp == group:
                        cmd = f"/{name} {args}".strip()
                        self.console.print(f"    [lx.accent2]{esc(f'{cmd:<26}')}[/] [lx.dim]{esc(desc)}[/]")
            self.console.print()
            return True

        options: list[Option] = []
        for group in COMMAND_GROUPS:
            options.append(Option(group.upper(), None, disabled=True))
            for name, args, desc, grp in COMMAND_SPECS:
                if grp != group:
                    continue
                label = f"/{name} {args}".strip()
                options.append(Option(f"{label:<26}", name, desc))
        chosen = select("Comandos", options, hint="escribe para filtrar  ↑↓ mover  ↵ ejecutar  esc salir",
                        searchable=True, max_visible=14)
        if chosen is None:
            return True
        spec = next((s for s in COMMAND_SPECS if s[0] == chosen), None)
        if spec and spec[1].startswith("<"):
            # Argumento OBLIGATORIO (<ruta>, <comando>): no se puede ejecutar a
            # ciegas desde el menú, así que se explica cómo se usa. Los [args]
            # opcionales sí se lanzan: abren su propio selector.
            print_note(f"Uso: /{spec[0]} {spec[1]} {g('sep')} {spec[2]}")
            return True
        return self._dispatch_command(f"/{chosen}")

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
        self._new_session("conversación nueva")
        print_note("Conversación nueva: contexto vacío. La anterior queda en /history.")
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
                # sin tools en la petición: el round-trip de herramientas del
                # modo agent no puede viajar tal cual
                messages=sanitize_for_plain_chat(self.history) + [prompt],
                conversation_id=None,
                client_id=self.client_id,
                title="compactación",
            )
        summary = (resp.get("choices", [{}])[0].get("message", {}).get("content", "")).strip()
        if not summary:
            print_error("No se pudo generar el resumen.")
            return True
        keep = sanitize_for_plain_chat(self.history)[-2:]
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

    def cmd_paste(self, arg: str):
        self._paste_clipboard_image()
        return True

    def _paste_clipboard_image(self) -> bool:
        """Adjunta la imagen del portapapeles. Devuelve si lo consiguió.

        Lo comparten `/paste` y el atajo Alt+V del prompt; el modelo la recibe
        igual que con `@ruta` (base64 en `ChatMessage.images`), así que solo
        funciona de verdad con un modelo multimodal.
        """
        path, error = paste_image(CONFIG_DIR)
        if path is None:
            print_error(error or "el portapapeles no tiene ninguna imagen")
            return False
        try:
            encode_image(path)  # valida formato y tamaño antes de prometer nada
        except ValueError as exc:
            print_error(str(exc))
            return False
        self.pending_images.append(path)
        size = fmt_size(path.stat().st_size)
        print_ok(f"{g('image')} imagen pegada ({size}); se enviará con el próximo mensaje")
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
            ("Plan", f"Lixbon {self.plan_name}" if self.plan_name else "desconocido"),
            ("Modo", self.mode),
            ("Sesión", self._session_label()),
            ("API key", mask_key(self.cfg.get("api_key", ""))),
            ("Base URL", self.api.base_url),
            ("Workspace", str(self.workspace)),
            ("Auto-aprobar", "on" if self.session.get("auto_approve") else "off"),
            ("Auto-run comandos", "on" if self.session.get("auto_run_commands") else "off"),
            ("Búsqueda web", "on" if self.web_search else "off"),
            ("Contexto del proyecto", "LIXBON.md cargado" if self.project_context else "sin LIXBON.md (/init)"),
            ("Barra fija", "on" if status_line_active() else "off"),
            ("Ventana de contexto", f"{self.cfg.get('context_window', 8192)} tokens"),
        ]
        for label, value in rows:
            self.console.print(f"  [lx.dim]{label:<20}[/] [lx.primary]{esc(value)}[/]")
        self.console.print()
        return True

    def cmd_login(self, arg: str):
        if self.onboarding_flow():
            self._load_account_quietly()
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
                Option("on", "on", "aplicar cambios sin preguntar (por defecto; el diff queda en el transcript)"),
                Option("off", "off", "pedir confirmación en cada cambio"),
            ], default=0 if self.session.get("auto_approve") else 1)
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
        self.workspace = new_ws  # solo para esta sesión; al relanzar vuelve a cwd
        self._set_tab_title()
        self._load_project_context()
        print_ok(f"Workspace: {short_path(new_ws)}")
        if self.project_context:
            print_note("LIXBON.md encontrado: se usará como contexto del proyecto.")
        return True

    def cmd_context_window(self, arg: str):
        try:
            value = max(1024, int(arg))
        except ValueError:
            print_error("Uso: /context-window 8192")
            return True
        self.cfg["context_window"] = value
        # El loop del agente presupuesta con esta misma cifra: si se quedara con
        # la vieja podaría contra una ventana que ya no es la que usa Ollama.
        self.session["context_window"] = value
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
        # /clear reinicia la conversación, no solo la pantalla: limpiar lo
        # visible dejando el mismo contexto vivo era engañoso — el modelo seguía
        # arrastrando todo lo anterior y no había manera de empezar de cero.
        self._new_session("contexto limpio")
        print_note("Contexto limpio: empiezas de cero. La conversación anterior queda en /history.")
        return True

    def cmd_update(self, arg: str):
        from lixbon_cli.cli import cmd_update

        cmd_update(None)
        return True

    # ── cuenta ───────────────────────────────────────────────────────────

    def cmd_logout(self, arg: str):
        if not self.cfg.get("api_key"):
            print_note("No hay ninguna sesión activa.")
            return True
        who = self._session_label()
        confirm = select(f"Cerrar la sesión de {who}", [
            Option("Sí, cerrar sesión", "yes", "se borra la clave guardada en esta máquina"),
            Option("No", "no", "seguir con la sesión actual"),
        ], default=1)
        if confirm != "yes":
            return True
        self._clear_session()
        self.model = ""
        self._refresh_status()
        print_ok("Sesión cerrada. Usa /login para volver a entrar.")
        return True

    def cmd_cost(self, arg: str):
        """Consumo de ESTA sesión: lo que /usage no cuenta porque es global."""
        tokens, pct = self._estimate_context()
        window = int(self.cfg.get("context_window", 8192))
        users = sum(1 for m in self.history if m.get("role") == "user")
        assistants = sum(1 for m in self.history if m.get("role") == "assistant")
        self.console.print()
        rows = [
            ("Tokens de la sesión", fmt_tokens(self.session_tokens)),
            ("Contexto en uso", f"{fmt_tokens(tokens)} / {fmt_tokens(window)}  ({pct:.0f}%)"),
            ("Turnos", f"{users} tuyos {g('sep')} {assistants} del modelo"),
            # En agent viaja el turno entero (con los resultados de las
            # herramientas), no los últimos N del chat: decir lo contrario
            # hacía imposible entender por qué se llenaba la ventana.
            ("Mensajes que se envían",
             "el turno entero (se poda al llenarse)" if self.mode == "agent"
             else f"últimos {self.cfg.get('max_context_messages', 12)}"),
            ("Chars por token (medido)", f"{self.chars_per_token:.2f}"),
        ]
        for label, value in rows:
            self.console.print(f"  [lx.dim]{label:<26}[/] [lx.primary]{esc(value)}[/]")
        if pct > 75:
            print_note("El contexto va lleno: /compact resume la conversación y libera espacio.")
        self.console.print()
        return True

    # ── agente ───────────────────────────────────────────────────────────

    def cmd_tools(self, arg: str):
        """Qué puede hacer el agente, y con qué nivel de permiso."""
        from lixbon_cli.agent import READ_ONLY_TOOLS

        self.console.print()
        self.console.print(f"  [lx.dim2]herramientas del modo agent {g('sep')} workspace {esc(short_path(self.workspace))}[/]")
        for name, args, desc in TOOL_SPECS:
            readonly = name in READ_ONLY_TOOLS
            dot = f"[lx.dim2]{g('dot_empty')}[/]" if readonly else f"[lx.accent2]{g('dot')}[/]"
            self.console.print(
                f"  {dot} [bold lx.primary]{esc(f'{name:<14}')}[/][lx.dim2]{esc(args)}[/]"
            )
            self.console.print(f"      [lx.dim]{esc(desc)}[/]")
        approve = "sin preguntar" if self.session.get("auto_approve") else "pidiendo confirmación"
        commands = "sin preguntar" if self.session.get("auto_run_commands") else "pidiendo confirmación"
        self.console.print()
        self.console.print(
            f"  [lx.dim]Cambios en archivos:[/] [lx.beige]{approve}[/] "
            f"[lx.dim2]{g('sep')}[/] [lx.dim]comandos de shell:[/] [lx.beige]{commands}[/]"
        )
        self.console.print(f"  [lx.dim2]{g('dot_empty')} solo lectura   {g('dot')} modifica tu disco[/]")
        # El protocolo importa al diagnosticar: con modelos chicos, "el agente
        # no usa las herramientas" casi siempre es que van por texto y no nativas.
        protocol = ("nativo (el modelo recibe las funciones)"
                    if self.session.get("native_tools", True)
                    else "texto (el modelo no soporta herramientas nativas)")
        self.console.print(f"  [lx.dim]Protocolo:[/] [lx.beige]{protocol}[/]")
        self.console.print()
        return True

    def _git(self, *args: str, timeout: int = 20) -> tuple[int, str]:
        """Ejecuta git en el workspace. Devuelve (código, salida combinada)."""
        try:
            proc = subprocess.run(
                ["git", *args], cwd=str(self.workspace), capture_output=True,
                text=True, encoding="utf-8", errors="replace", timeout=timeout,
            )
            return proc.returncode, (proc.stdout or "") + (proc.stderr or "")
        except FileNotFoundError:
            return 127, "git no está instalado o no está en el PATH."
        except subprocess.TimeoutExpired:
            return 124, "git tardó demasiado en responder."

    def cmd_diff(self, arg: str):
        """Cambios sin confirmar del workspace, con el mismo color que el agente."""
        code, _ = self._git("rev-parse", "--is-inside-work-tree", timeout=10)
        if code != 0:
            print_note(f"{short_path(self.workspace)} no es un repositorio git.")
            return True
        target = [arg.strip()] if arg.strip() else []
        _, status = self._git("status", "--short")
        if not status.strip():
            print_ok("El workspace está limpio: no hay cambios sin confirmar.")
            return True
        _, stat = self._git("diff", "--stat", "--", *target)
        _, body = self._git("diff", "--unified=2", "--", *target)

        self.console.print()
        rule(self.console, "cambios sin confirmar")
        for line in status.rstrip().splitlines()[:40]:
            self.console.print(f"  [lx.beige]{esc(line)}[/]")
        if body.strip():
            self.console.print()
            for line in body.rstrip().splitlines()[:220]:
                if line.startswith("+++") or line.startswith("---"):
                    style = "lx.dim2"
                elif line.startswith("+"):
                    style = "lx.diff.add"
                elif line.startswith("-"):
                    style = "lx.diff.del"
                elif line.startswith("@@"):
                    style = "lx.diff.hunk"
                else:
                    style = "lx.dim"
                self.console.print(f"  [{style}]{esc(line)}[/]")
        if stat.strip():
            self.console.print()
            self.console.print(f"  [lx.dim]{esc(stat.strip().splitlines()[-1])}[/]")
        self.console.print()
        return True

    def cmd_run(self, arg: str):
        """Ejecuta un comando y deja su salida en el contexto del modelo."""
        command = arg.strip()
        if not command:
            print_error("Uso: /run npm test")
            return True
        if not self.session.get("auto_run_commands"):
            decision = select(f"Ejecutar «{command}»", [
                Option("Sí", "yes", f"se ejecuta en {short_path(self.workspace)}"),
                Option("Sí, y no preguntar más", "always", "auto-ejecutar comandos el resto de la sesión"),
                Option("No", "no", "cancelar"),
            ], default=0)
            if decision == "always":
                self.session["auto_run_commands"] = True
            elif decision != "yes":
                return True
        try:
            with spinner(f"ejecutando {command}…"):
                proc = subprocess.run(
                    command, cwd=str(self.workspace), shell=True, capture_output=True,
                    text=True, encoding="utf-8", errors="replace", timeout=300,
                )
            output = ((proc.stdout or "") + (proc.stderr or "")).rstrip()
            code = proc.returncode
        except subprocess.TimeoutExpired:
            output, code = "El comando superó los 300 s y se canceló.", 124
        except Exception as exc:
            output, code = str(exc), 1

        self.console.print()
        render_action(self.console, "ejecutó", command)
        for line in (output or "(sin salida)").splitlines()[:80]:
            render_log_line(self.console, line)
        render_action_result(self.console, f"salida {code}", error=code != 0)
        self.console.print()
        # El modelo debe poder razonar sobre el resultado en el siguiente turno.
        self.history.append({
            "role": "user",
            "content": f"TOOL_RESULT run_command `{command}` (EXIT {code}):\n{output[:6000]}",
        })
        self._refresh_status()
        return True

    def cmd_init(self, arg: str):
        """Genera LIXBON.md: el contexto del proyecto que el CLI carga solo."""
        target = self.workspace / "LIXBON.md"
        if target.exists():
            choice = select("Ya existe LIXBON.md", [
                Option("Regenerarlo", "yes", "se sobrescribe con un análisis nuevo"),
                Option("Cancelar", "no", "dejar el archivo como está"),
            ], default=1)
            if choice != "yes":
                return True
        tree = workspace_tree(self.workspace, max_entries=200)
        prompt = (
            "Analiza este proyecto y escribe un LIXBON.md breve (máximo 60 líneas) que sirva "
            "de contexto permanente para un asistente de código. Incluye: qué es el proyecto, "
            "stack y estructura, cómo se ejecuta y se prueba, y convenciones que haya que "
            "respetar. Responde SOLO con el Markdown del archivo, sin explicaciones ni ```.\n\n"
            f"Carpeta: {self.workspace.name}\nÁrbol:\n{tree}"
        )
        with spinner("analizando el proyecto…"):
            resp = self.api.chat(
                model=self.model, messages=[{"role": "user", "content": prompt}],
                conversation_id=None, client_id=self.client_id, title="init",
            )
        content = (resp.get("choices", [{}])[0].get("message", {}).get("content", "")).strip()
        if not content:
            print_error("El modelo no devolvió contenido; inténtalo de nuevo.")
            return True
        if content.startswith("```"):
            content = content.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        target.write_text(content + "\n", encoding="utf-8")
        self._load_project_context()
        render_action(self.console, "escribió", "LIXBON.md", adds=len(content.splitlines()))
        print_ok("LIXBON.md creado: se cargará como contexto en cada sesión de esta carpeta.")
        return True

    # ── conversación ─────────────────────────────────────────────────────

    def cmd_web(self, arg: str):
        if arg in ("on", "off"):
            self.web_search = arg == "on"
        else:
            chosen = select("Búsqueda web", [
                Option("on", "on", "el modelo consulta la web cuando le hace falta"),
                Option("off", "off", "solo el conocimiento del modelo"),
            ], default=0 if self.web_search else 1)
            if chosen is None:
                return True
            self.web_search = chosen == "on"
        self.cfg["web_search"] = self.web_search
        save_config(self.cfg)
        self._refresh_status()
        print_ok(f"Búsqueda web: {'on' if self.web_search else 'off'}")
        return True

    def cmd_save(self, arg: str):
        """Vuelca la conversación a Markdown (para PR, ticket o bitácora)."""
        if not self.history:
            print_note("La conversación está vacía.")
            return True
        if arg.strip():
            path = Path(arg.strip('"')).expanduser()
            if not path.is_absolute():
                path = self.workspace / path
        else:
            stamp = time.strftime("%Y%m%d-%H%M")
            path = self.workspace / f"lixbon-{stamp}.md"
        lines = [
            f"# Conversación Lixbon {g('sep')} {self.workspace.name}",
            "",
            f"- Modelo: `{self.model}`",
            f"- Modo: `{self.mode}`",
            f"- Fecha: {time.strftime('%Y-%m-%d %H:%M')}",
            "",
        ]
        for msg in self.history:
            role = msg.get("role", "")
            content = (msg.get("content") or "").strip()
            if not content or role in ("system", "tool"):
                continue
            if role == "user" and content.startswith("TOOL_RESULT"):
                continue
            lines.append("## Tú" if role == "user" else "## Lixbon")
            lines.append("")
            lines.append(clean_prose(content) if role == "assistant" and self.mode == "agent" else content)
            lines.append("")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("\n".join(lines), encoding="utf-8")
        except OSError as exc:
            print_error(f"No se pudo guardar: {exc}")
            return True
        print_ok(f"Conversación guardada en {short_path(path)}")
        return True

    def cmd_history(self, arg: str):
        """Historial de conversaciones: elegir una la reabre entera.

        `/history mensajes` mantiene el comportamiento anterior (reenviar un
        mensaje de la sesión en curso), que es otra cosa y sigue siendo útil.
        """
        if arg.strip().lower() in ("mensajes", "messages", "msg"):
            return self._history_messages()

        # La sesión en curso tiene que aparecer en la lista aunque aún no se
        # haya cerrado: es la conversación con la que se está trabajando.
        self._persist_session()
        items = self.sessions.list_sessions(limit=50)
        if not items:
            print_note("Todavía no hay conversaciones guardadas. Al primer mensaje "
                       "empieza a guardarse sola.")
            return True

        options = []
        for item in items:
            title = item.get("title") or "Sin título"
            when = relative_time(item.get("updated_at") or 0)
            msgs = int(item.get("messages") or 0)
            tools = int(item.get("tools") or 0)
            current = item.get("id") == self.conversation_id
            detail = f"{when} {g('sep')} {msgs} mensaje{'s' if msgs != 1 else ''}"
            if tools:
                detail += f" {g('sep')} {tools} acción{'es' if tools != 1 else ''}"
            if current:
                detail += f" {g('sep')} actual"
            options.append(Option(title[:60] + (g("ellipsis") if len(title) > 60 else ""),
                                  item["id"], description=detail))
        chosen = select("Conversaciones", options,
                        hint="escribe para filtrar  ↑↓ mover  ↵ abrir  esc salir")
        if chosen is None:
            return True
        if chosen == self.conversation_id:
            print_note("Ya estás en esa conversación.")
            return True
        if self._open_session(chosen):
            print_ok(f"Conversación reabierta: {self.title or 'sin título'}")
        return True

    def _history_messages(self):
        """Los mensajes de la sesión en curso; elegir uno lo reenvía tal cual."""
        mine = [m for m in self.history
                if m.get("role") == "user" and not (m.get("content") or "").startswith("TOOL_RESULT")]
        if not mine:
            print_note("Todavía no has enviado ningún mensaje en esta conversación.")
            return True
        options = []
        for i, msg in enumerate(mine[-30:], start=1):
            text = " ".join((msg.get("content") or "").split())
            options.append(Option(text[:70] + (g("ellipsis") if len(text) > 70 else ""), text,
                                  description=f"mensaje {i}"))
        chosen = select("Reenviar un mensaje", options, default=len(options) - 1,
                        hint="escribe para filtrar  ↑↓ mover  ↵ reenviar  esc salir")
        if chosen is None:
            return True
        self.console.print(f"  [lx.accent2]{g('prompt')}[/] [lx.primary]{esc(chosen)}[/]")
        try:
            self.send_message(chosen)
        except ApiError as exc:
            self._report_api_error(exc)
        return True

    # ── sistema ──────────────────────────────────────────────────────────

    def cmd_bar(self, arg: str):
        """Barra fija al pie. Se puede apagar: roba el scrollback nativo."""
        if arg in ("on", "off"):
            wanted = arg == "on"
        else:
            chosen = select("Barra de estado fija", [
                Option("on", "on", "clavada al pie, siempre visible"),
                Option("off", "off", "solo bajo el prompt; conserva el scrollback de la terminal"),
            ], default=0 if status_line_active() else 1)
            if chosen is None:
                return True
            wanted = chosen == "on"
        self.cfg["fixed_status_bar"] = wanted
        save_config(self.cfg)
        if wanted and not status_line_active():
            set_status_painter(self._paint_status)
            reserve_status_line()
            self._refresh_status()
        elif not wanted and status_line_active():
            release_status_line()
        print_ok(f"Barra fija: {'on' if wanted else 'off'}"
                 + ("" if wanted else " (vuelve al pie del prompt)"))
        return True

    def cmd_config(self, arg: str):
        """Ajustes en un menú, en vez de recordar diez comandos sueltos."""
        while True:
            entries = [
                ("model", f"Modelo{'':<10}", self.model or "sin modelo"),
                ("mode", "Modo de trabajo", self.mode),
                ("approve", "Auto-aprobar cambios", "on" if self.session.get("auto_approve") else "off"),
                ("web", "Búsqueda web", "on" if self.web_search else "off"),
                ("bar", "Barra fija", "on" if status_line_active() else "off"),
                ("context-window", "Ventana de contexto", f"{self.cfg.get('context_window', 8192)} tokens"),
                ("messages", "Mensajes enviados", str(self.cfg.get("max_context_messages", 12))),
                ("workspace", "Workspace", short_path(self.workspace, 40)),
            ]
            options = [Option(label.strip(), key, description=value) for key, label, value in entries]
            options.append(Option("Cerrar ajustes", "__close__"))
            chosen = select("Ajustes", options, hint="↑↓ mover  ↵ cambiar  esc salir",
                            searchable=False, max_visible=12)
            if chosen is None or chosen == "__close__":
                return True
            if chosen == "messages":
                value = self._prompt_text("Mensajes de historial que se envían (2-50)")
                try:
                    self.cfg["max_context_messages"] = max(2, min(50, int(value or "")))
                    save_config(self.cfg)
                    print_ok(f"Se enviarán los últimos {self.cfg['max_context_messages']} mensajes")
                except (TypeError, ValueError):
                    print_error("Valor no válido.")
            elif chosen == "context-window":
                value = self._prompt_text("Tokens de la ventana de contexto")
                self.cmd_context_window(value or "")
            elif chosen == "workspace":
                value = self._prompt_text("Ruta del workspace")
                if value:
                    self.cmd_workspace(value)
            else:
                self._dispatch_command(f"/{chosen}")
            self._refresh_status()

    def cmd_doctor(self, arg: str):
        """Diagnóstico: por qué la interfaz o la conexión no se ven bien."""
        from lixbon_cli.term import UNICODE_OK, is_mintty, ui_capable

        cols, rows = term_size()
        checks: list[tuple[bool | None, str, str]] = [
            (True, "CLI", f"v{CLI_VERSION} {g('sep')} Python {platform.python_version()} {g('sep')} {platform.system()}"),
            (is_interactive(), "Terminal interactiva", "sí" if is_interactive() else "no (pipe o redirección)"),
            (ui_capable(), "Interfaz completa",
             "prompt_toolkit disponible" if ui_capable() else "modo simplificado (Git Bash/mintty)"),
            (UNICODE_OK, "Glifos unicode", "sí" if UNICODE_OK else "no; se usan equivalentes ASCII"),
            (None, "Tamaño", f"{cols}x{rows} {g('sep')} {'mintty' if is_mintty() else os.environ.get('TERM_PROGRAM') or 'consola nativa'}"),
            (status_line_active(), "Barra fija",
             "activa" if status_line_active() else "apagada (/bar on para activarla)"),
            (None, "Config", str(CONFIG_FILE)),
            (None, "Servidor", self.api.base_url),
        ]
        self.console.print()
        for ok, label, value in checks:
            icon = f"[lx.dim2]{g('sep')}[/]" if ok is None else (
                f"[lx.ok]{g('check')}[/]" if ok else f"[lx.warn]{g('cross')}[/]")
            self.console.print(f"  {icon} [lx.dim]{label:<22}[/] [lx.primary]{esc(value)}[/]")

        started = time.monotonic()
        try:
            with spinner("probando el servidor…"):
                models = self.api.models()
            elapsed = (time.monotonic() - started) * 1000
            self.models_cache = models
            self.console.print(
                f"  [lx.ok]{g('check')}[/] [lx.dim]{'Modelos':<22}[/] "
                f"[lx.primary]{len(models)} disponibles[/] [lx.dim2]{elapsed:.0f} ms[/]"
            )
        except ApiError as exc:
            reason = ("la sesión no es válida (/login)" if exc.status in (401, 403)
                      else f"{exc} [{exc.status or 'sin respuesta'}]")
            self.console.print(f"  [lx.err]{g('cross')}[/] [lx.dim]{'Modelos':<22}[/] [lx.err]{esc(reason)}[/]")
        self.console.print()
        return True

    # ── control remoto (/remote) ─────────────────────────────────────────

    def _remote_snapshot(self) -> list[dict]:
        """Historial renderizable para un controller que se une: sin system,
        sin TOOL_RESULT internos y con la prosa del asistente limpia."""
        msgs: list[dict] = []
        for m in self.history:
            role = m.get("role", "")
            content = m.get("content", "")
            if role in ("system", "tool"):
                continue
            if role == "user" and content.startswith("TOOL_RESULT"):
                continue
            if role == "assistant":
                content = clean_prose(content) or content[:400]
                if not content:
                    continue
            msgs.append({"role": role, "content": content})
        return msgs[-80:]

    def cmd_remote(self, arg: str):
        arg = (arg or "").strip().lower()
        if arg and arg not in ("start", "stop", "status"):
            print_error("Uso: /remote — inicia el control remoto desde tu app móvil")
            return True
        if arg in ("stop", "status"):
            print_note("El control remoto se activa con /remote y se termina con Ctrl+C dentro del modo remoto.")
            return True
        if not self.cfg.get("api_key"):
            print_error("Necesitas una sesión activa (/login) para usar /remote.")
            return True

        title = self.workspace.name or "workspace"
        machine = platform.node() or "PC"
        link = RemoteLink(self.api, source="cli", title=title, machine=machine)
        try:
            with spinner("creando sesión remota…"):
                link.start(mode=self.mode, model=self.model)
                qr = link.qr_text()
        except ApiError as exc:
            print_error(f"No se pudo iniciar el control remoto: {exc}")
            return True

        link.snapshot_provider = self._remote_snapshot
        self.remote = link
        self.session["remote"] = link

        self.console.print()
        self.console.print(f"  [bold lx.primary]{g('spark')} Control remoto activo[/]")
        self.console.print(f"  [lx.dim]Sesión:[/] [lx.primary]{esc(title)}[/] [lx.dim]en {esc(machine)}[/]")
        self.console.print(f"  [lx.dim]Link:[/]   [lx.accent2]{esc(link.share_url)}[/]")
        if qr:
            self.console.print()
            for line in qr.rstrip("\n").splitlines():
                self.console.print(f"  {line}")
        self.console.print()
        print_note("La sesión ya aparece en la sección Remote de tu app Lixbon.")
        print_note("Sin la app, escanea el QR: abre la sesión en la web (te pedirá iniciar sesión con tu cuenta).")

        try:
            self._remote_loop(link)
        finally:
            self.session.pop("remote", None)
            self.remote = None
        return True

    def _remote_command(self, link: RemoteLink, text: str) -> None:
        """Ejecuta un slash-command llegado del móvil y devuelve texto plano.

        No se reutilizan los `cmd_*`: escriben en la consola local con `rich` y
        varios abren selectores interactivos, que en remoto no tienen teclado.
        Aquí solo viven los que se pueden resolver con un argumento y contestar
        con una frase, que es lo que la app puede mostrar.
        """
        name, _sep, arg = text[1:].partition(" ")
        name = name.strip().lower()
        arg = arg.strip()

        # Un prefijo también vale: en el móvil se escribe con el pulgar.
        known = [spec[0] for spec in REMOTE_COMMANDS]
        near = [n for n in known if n.startswith(name)] if name not in known else []
        if len(near) == 1:
            name = near[0]

        def reply(message: str) -> None:
            link.emit("notice", text=message)

        if name == "help":
            lines = ["Comandos disponibles desde la app:"]
            lines += [f"/{n} {a}".rstrip() + f" — {d}" for n, a, d in REMOTE_COMMANDS]
            reply("\n".join(lines))
        elif name == "new":
            self.cmd_new("")
            reply("Conversación nueva: el contexto anterior se descartó.")
        elif name == "model":
            if not arg:
                reply(f"Modelo actual: {self.model or 'sin configurar'}")
            elif self.cfg.get("key_model"):
                reply(f"El modelo está fijado por la API key: {self.cfg['key_model']}")
            else:
                models = self._models_or_empty()
                match = next((m for m in models if m.lower() == arg.lower()), None) \
                    or next((m for m in models if arg.lower() in m.lower()), None)
                if not match:
                    reply(f"No hay ningún modelo que coincida con «{arg}».")
                else:
                    self.model = match
                    self.cfg["model"] = match
                    save_config(self.cfg)
                    reply(f"Modelo cambiado a {match}.")
        elif name == "mode":
            if arg in ("ask", "agent", "delegate"):
                self.mode = arg
                reply(f"Modo cambiado a {arg}.")
            else:
                reply(f"Modo actual: {self.mode}. Usa /mode ask, agent o delegate.")
        elif name == "approve":
            if arg in ("on", "off"):
                self.session["auto_approve"] = arg == "on"
            reply(f"Auto-aprobar herramientas: {'on' if self.session.get('auto_approve') else 'off'}.")
        elif name == "web":
            if arg in ("on", "off"):
                self.web_search = arg == "on"
                self.cfg["web_search"] = self.web_search
                save_config(self.cfg)
            reply(f"Búsqueda web: {'on' if self.web_search else 'off'}.")
        elif name == "workspace":
            reply(f"Workspace: {self.workspace}")
        elif name == "cost":
            tokens, pct = self._estimate_context()
            window = int(self.cfg.get("context_window", 8192))
            reply(f"Contexto: {tokens} de {window} tokens ({pct} %) en {len(self.history)} mensajes.")
        elif name == "status":
            reply(
                f"Modelo: {self.model or 'sin configurar'}\n"
                f"Modo: {self.mode}\n"
                f"Workspace: {self.workspace}\n"
                f"Auto-aprobar: {'on' if self.session.get('auto_approve') else 'off'}\n"
                f"Búsqueda web: {'on' if self.web_search else 'off'}"
            )
        elif len(near) > 1:
            reply(f"«/{name}» es ambiguo: " + " o ".join(f"/{n}" for n in near) + ".")
        else:
            reply(f"«/{name}» no se puede ejecutar desde la app. Escribe /help para ver los que sí.")
        link.emit("status", state="idle")

    def _models_or_empty(self) -> list:
        try:
            return self.models_cache or self.api.models()
        except ApiError:
            return list(self.models_cache)

    def _remote_loop(self, link: RemoteLink) -> None:
        """Takeover: el teclado local queda en pausa y los prompts llegan del
        móvil/web. Ctrl+C termina la sesión remota y devuelve el control."""
        print_note("Control local en pausa — Ctrl+C para terminar el modo remoto y volver aquí.")
        self.console.print()
        link.emit_snapshot()
        link.emit("status", state="idle")
        try:
            while True:
                try:
                    cmd = link.commands.get(timeout=0.5)
                except queue.Empty:
                    if link.ended:
                        break
                    continue
                kind = cmd.get("type")
                if kind == "bye":
                    break
                if kind != "prompt":
                    continue
                text = (cmd.get("text") or "").strip()
                if not text:
                    continue
                link.interrupt_requested = False
                self.console.print(f"  [lx.accent2]{g('prompt')}[/] [lx.primary]{esc(text)}[/] [lx.dim]\\[remoto][/]")
                if text.startswith("/"):
                    self._remote_command(link, text)
                    continue
                try:
                    self.send_message(text, origin="remote")
                except ApiError as exc:
                    print_error(str(exc))
                    link.emit("error", message=str(exc))
        except KeyboardInterrupt:
            pass
        link.stop(end_session=True)
        self.console.print()
        print_note("Control remoto terminado; la sesión vuelve a esta terminal.")

    def cmd_exit(self, arg: str):
        print_note("Hasta pronto.")
        return False
