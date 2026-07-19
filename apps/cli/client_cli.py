#!/usr/bin/env python3
# ============================================================================
#  lixbon CLI — GENERADO por apps/cli/build.py. NO EDITAR A MANO.
#  Fuente: apps/cli/lixbon_cli/*.py  |  Regenerar: python apps/cli/build.py
# ============================================================================

# ──────────────────────────────────────────────────────────────────────────
# módulo: lixbon_cli/term.py
# ──────────────────────────────────────────────────────────────────────────
"""Compatibilidad de terminal: VT en Windows, encoding y glifos con fallback."""
import os
import sys

IS_WINDOWS = os.name == "nt"

# Encoding original de stdout ANTES de reconfigurar a utf-8: es el mejor
# indicador de si la consola (conhost legacy, cp1252/cp850) mostrará unicode.
_ORIG_ENCODING = (getattr(sys.stdout, "encoding", None) or "utf-8").lower()


def enable_vt() -> None:
    """Habilita secuencias ANSI (VT) en consolas Windows."""
    if not IS_WINDOWS:
        return
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        for handle_id in (-11, -12):  # stdout, stderr
            handle = kernel32.GetStdHandle(handle_id)
            mode = ctypes.c_uint32()
            if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
                ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
                kernel32.SetConsoleMode(handle, mode.value | ENABLE_VIRTUAL_TERMINAL_PROCESSING)
    except Exception:
        os.system("")  # fallback: activa VT como efecto secundario


def setup_terminal() -> None:
    """Prepara la terminal: VT + salida utf-8 tolerante."""
    enable_vt()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def _unicode_ok() -> bool:
    if not IS_WINDOWS:
        return True
    try:
        "✦●▓░❯╭".encode(_ORIG_ENCODING)
        return True
    except (UnicodeEncodeError, LookupError):
        # Windows Terminal renderiza unicode aunque el codepage legacy no:
        # WT_SESSION la define la propia Windows Terminal.
        return bool(os.environ.get("WT_SESSION"))


UNICODE_OK = _unicode_ok()

_GLYPHS_UNICODE = {
    "spark": "✦",
    "spark_alt": "✻",
    "dot": "●",
    "dot_empty": "○",
    "prompt": "❯",
    "bar_full": "▓",
    "bar_empty": "░",
    "ellipsis": "…",
    "arrow": "→",
    "check": "✓",
    "cross": "✗",
    "sep": "·",
    "image": "🖼",
}
_GLYPHS_ASCII = {
    "spark": "*",
    "spark_alt": "*",
    "dot": "o",
    "dot_empty": ".",
    "prompt": ">",
    "bar_full": "#",
    "bar_empty": ".",
    "ellipsis": "...",
    "arrow": "->",
    "check": "OK",
    "cross": "X",
    "sep": "-",
    "image": "[img]",
}


def g(name: str) -> str:
    """Glifo unicode con fallback ASCII para consolas legacy."""
    table = _GLYPHS_UNICODE if UNICODE_OK else _GLYPHS_ASCII
    return table.get(name, "?")


def is_mintty() -> bool:
    """Git Bash / MSYS (mintty): la stdio son pipes, no una consola Windows."""
    return bool(os.environ.get("MSYSTEM") or os.environ.get("TERM_PROGRAM") == "mintty")


def is_interactive() -> bool:
    """¿Hay un humano al otro lado? (aunque la terminal sea limitada)."""
    if sys.stdout.isatty() and sys.stdin.isatty():
        return True
    # mintty expone la stdio como pipes: isatty() miente, pero es interactivo.
    return is_mintty()


_UI_CAPABLE: bool | None = None


def ui_capable() -> bool:
    """¿Soporta esta terminal la interfaz completa de prompt_toolkit?

    Falso en Git Bash/mintty (sin consola Win32) y en pipes: ahí el CLI usa
    el modo simplificado basado en input().
    """
    global _UI_CAPABLE
    if _UI_CAPABLE is None:
        if not (sys.stdin.isatty() and sys.stdout.isatty()):
            _UI_CAPABLE = False
        else:
            try:
                from prompt_toolkit.output.defaults import create_output

                create_output()
                _UI_CAPABLE = True
            except Exception:
                _UI_CAPABLE = False
    return _UI_CAPABLE

# ──────────────────────────────────────────────────────────────────────────
# módulo: lixbon_cli/theme.py
# ──────────────────────────────────────────────────────────────────────────
"""Identidad visual del CLI: paleta Lixbon y jerarquía semántica.

Derivada del ícono de la app (rombo beige/oliva con destello crema sobre casi
negro) y de los tokens web (crema #F6F7ED, tinta #171717). Terminal oscura:
el acento verde-amarillo se reserva para marca, selección y acciones; el texto
corre en crema; los metadatos y el razonamiento del modelo bajan a grises.

Los imports de rich/prompt_toolkit son perezosos: el archivo único generado
debe poder ejecutar `status`/`init`/`update` sin dependencias instaladas.
"""

PALETTE = {
    "cream": "#F6F7ED",   # primario: texto de respuestas y labels
    "accent": "#B4C13A",  # acento verde-amarillo: logo, prompt, selección
    "beige": "#CBC7A9",   # marca (cuadrante superior del ícono)
    "olive": "#4A5A2A",   # marca (cuadrante inferior del ícono)
    "dim": "#8A8A80",     # secundario: metadatos, hints, barra de estado
    "dim2": "#5C5C55",    # terciario: thinking, placeholders, colapsados
    "ok": "#5FB85F",      # éxito, líneas + de diff
    "err": "#E05C5C",     # error, líneas - de diff
    "warn": "#D6B44C",    # avisos, confirmaciones delicadas
    "ink": "#171717",     # texto sobre acento (selección invertida)
}

# Jerarquía semántica → estilos rich (se usan como [lx.accent]...[/])
RICH_STYLES = {
    "lx.primary": PALETTE["cream"],
    "lx.accent": f"bold {PALETTE['accent']}",
    "lx.accent2": PALETTE["accent"],
    "lx.beige": PALETTE["beige"],
    "lx.dim": PALETTE["dim"],
    "lx.dim2": PALETTE["dim2"],
    "lx.thinking": f"italic {PALETTE['dim2']}",
    "lx.ok": PALETTE["ok"],
    "lx.err": PALETTE["err"],
    "lx.warn": PALETTE["warn"],
    "lx.diff.add": PALETTE["ok"],
    "lx.diff.del": PALETTE["err"],
    "lx.diff.hunk": PALETTE["dim"],
}

_console = None

# Respiro visual: margen izquierdo/derecho y ancho máximo de línea (leer texto
# de borde a borde en una terminal ancha cansa).
PAD_LEFT = 2
PAD_RIGHT = 2
MAX_WIDTH = 100


def pad(renderable):
    """Envuelve un renderable con el margen izquierdo estándar del CLI."""
    from rich.padding import Padding

    return Padding(renderable, (0, PAD_RIGHT, 0, PAD_LEFT))


def make_console():
    """Console rich compartida, con el tema Lixbon y márgenes registrados."""
    global _console
    if _console is None:
        import shutil

        from rich.console import Console
        from rich.theme import Theme


        class LixbonConsole(Console):
            """Console con margen izquierdo automático en cada print."""

            def print(self, *objects, **kwargs):
                if objects and not kwargs.pop("no_pad", False):
                    from rich.padding import Padding

                    objects = tuple(
                        Padding(obj, (0, PAD_RIGHT, 0, PAD_LEFT)) if obj != "" else obj
                        for obj in objects
                    )
                super().print(*objects, **kwargs)

        cols = shutil.get_terminal_size((MAX_WIDTH, 24)).columns
        _console = LixbonConsole(
            theme=Theme(RICH_STYLES),
            highlight=False,
            width=min(cols, MAX_WIDTH),
            # mintty (Git Bash) es una terminal real aunque la stdio sean pipes
            force_terminal=True if is_mintty() else None,
        )
    return _console


def pt_style():
    """Style de prompt_toolkit para prompts, selectores y barra de estado."""
    from prompt_toolkit.styles import Style

    return Style.from_dict({
        # Prompt de entrada
        "prompt": f"bold {PALETTE['accent']}",
        # Selector interactivo
        "sel.title": f"bold {PALETTE['cream']}",
        "sel.hint": PALETTE["dim2"],
        "sel.pointer": f"bold {PALETTE['accent']}",
        "sel.active": f"bold {PALETTE['accent']}",
        "sel.active.desc": PALETTE["dim"],
        "sel.option": PALETTE["cream"],
        "sel.option.desc": PALETTE["dim2"],
        # Barra de estado inferior (bottom_toolbar) — fondo propio sutil
        "bottom-toolbar": f"{PALETTE['dim']} bg:#1E1E1A noinherit",
        "bottom-toolbar.dot": f"{PALETTE['accent']} bg:#1E1E1A",
        "bottom-toolbar.model": f"{PALETTE['beige']} bg:#1E1E1A",
        "bottom-toolbar.sep": f"{PALETTE['dim2']} bg:#1E1E1A",
        # Menú de autocompletado de slash-commands
        "completion-menu": f"bg:#1E1E1A {PALETTE['cream']}",
        "completion-menu.completion": f"bg:#1E1E1A {PALETTE['cream']}",
        "completion-menu.completion.current": f"bg:{PALETTE['accent']} {PALETTE['ink']}",
        "completion-menu.meta.completion": f"bg:#1E1E1A {PALETTE['dim']}",
        "completion-menu.meta.completion.current": f"bg:#2A2A24 {PALETTE['dim']}",
    })

# ──────────────────────────────────────────────────────────────────────────
# módulo: lixbon_cli/config.py
# ──────────────────────────────────────────────────────────────────────────
"""Configuración local del CLI (~/.lixbon/config.json)."""
import json
from pathlib import Path

CLI_VERSION = "2.0.0"

DEFAULT_BASE_URL = "https://lixbon.com/v1"
CONFIG_DIR = Path.home() / ".lixbon"
CONFIG_FILE = CONFIG_DIR / "config.json"
HISTORY_FILE = CONFIG_DIR / "history"


def default_config() -> dict:
    return {
        "base_url": DEFAULT_BASE_URL,
        "api_key": "",
        "model": "",
        "key_model": "",  # Si está definido, la key es de modelo específico (no se puede cambiar)
        "max_context_messages": 12,
        "context_window": 8192,  # tokens estimados de la ventana del modelo (para la barra de contexto)
        "mode": "agent",  # por defecto el modelo puede crear/editar archivos (con aprobación)
        "workspace": str(Path.cwd()),
        "auto_approve_tools": True,  # el agente escribe directo; /approve off para pedir confirmación
    }


def load_config() -> dict:
    cfg = default_config()
    if not CONFIG_FILE.exists():
        return cfg
    try:
        stored = json.loads(CONFIG_FILE.read_text(encoding="utf-8-sig"))
        cfg.update({k: v for k, v in stored.items() if v is not None})
    except Exception:
        pass
    return cfg


def save_config(cfg: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    # El config guarda la API key: solo el dueño debe poder leerlo.
    # En Windows chmod es casi un no-op (ACLs aparte); en POSIX evita que el
    # umask por defecto lo deje legible para todo el mundo.
    try:
        CONFIG_FILE.chmod(0o600)
    except OSError:
        pass


def server_base(base_url: str) -> str:
    """https://lixbon.com/v1 -> https://lixbon.com (raíz para /api/*)."""
    base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
    return base_url.rsplit("/v1", 1)[0] if base_url.endswith("/v1") else base_url


def mask_key(key: str) -> str:
    if not key:
        return "no configurada"
    return f"{key[:10]}{'…' if len(key) > 14 else ''}{key[-4:]}" if len(key) > 14 else "***"

# ──────────────────────────────────────────────────────────────────────────
# módulo: lixbon_cli/sse.py
# ──────────────────────────────────────────────────────────────────────────
"""Parseo del stream SSE del gateway y clasificación de eventos.

Eventos tipados que consume la app:
  ("sources", list)     — fuentes de web_search (primer evento si aplica)
  ("reasoning", str)    — razonamiento del modelo (segundo plano)
  ("content", str)      — texto de la respuesta
  ("usage", dict)       — tokens reales, llega en el último chunk
  ("done", None)        — fin del stream
"""
import json

THINK_OPEN = "<think>"
THINK_CLOSE = "</think>"


class ThinkTagFilter:
    """Reclasifica como reasoning el texto entre <think>…</think>.

    Algunos modelos (deepseek-r1, qwen) emiten el razonamiento inline en el
    content en lugar del campo thinking de Ollama. Los tags pueden llegar
    partidos entre chunks, así que se retiene la cola que podría ser el
    principio de un tag hasta poder decidir.
    """

    def __init__(self):
        self._inside = False
        self._buffer = ""

    def _tag(self) -> str:
        return THINK_CLOSE if self._inside else THINK_OPEN

    @staticmethod
    def _partial_tail(text: str, tag: str) -> int:
        """Longitud del sufijo de text que es prefijo (incompleto) de tag."""
        max_len = min(len(text), len(tag) - 1)
        for size in range(max_len, 0, -1):
            if text.endswith(tag[:size]):
                return size
        return 0

    def feed(self, text: str) -> list[tuple[str, str]]:
        self._buffer += text
        out: list[tuple[str, str]] = []
        while True:
            tag = self._tag()
            pos = self._buffer.find(tag)
            if pos == -1:
                hold = self._partial_tail(self._buffer, tag)
                emit = self._buffer[: len(self._buffer) - hold]
                self._buffer = self._buffer[len(self._buffer) - hold:]
                if emit:
                    out.append(("reasoning" if self._inside else "content", emit))
                return out
            emit = self._buffer[:pos]
            if emit:
                out.append(("reasoning" if self._inside else "content", emit))
            self._buffer = self._buffer[pos + len(tag):]
            self._inside = not self._inside

    def flush(self) -> list[tuple[str, str]]:
        emit = self._buffer
        self._buffer = ""
        if emit:
            return [("reasoning" if self._inside else "content", emit)]
        return []


def iter_sse_data(response):
    """Itera los payloads JSON de las líneas `data:` de una respuesta SSE.

    Ignora keepalives (líneas que empiezan con ':') y corta en [DONE].
    """
    for raw in response:
        line = raw.decode("utf-8", errors="replace").strip()
        if not line or line.startswith(":"):
            continue
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if payload == "[DONE]":
            return
        try:
            yield json.loads(payload)
        except json.JSONDecodeError:
            continue


def events_from_stream(response):
    """Convierte la respuesta SSE cruda en los eventos tipados del CLI."""
    think_filter = ThinkTagFilter()
    for chunk in iter_sse_data(response):
        if "lixbon_sources" in chunk:
            yield ("sources", chunk["lixbon_sources"])
            continue
        choices = chunk.get("choices") or []
        if choices:
            delta = choices[0].get("delta") or {}
            reasoning = delta.get("reasoning_content")
            if reasoning:
                yield ("reasoning", reasoning)
            content = delta.get("content")
            if content:
                yield from think_filter.feed(content)
        usage = chunk.get("usage")
        if usage:
            yield ("usage", usage)
    yield from think_filter.flush()
    yield ("done", None)

# ──────────────────────────────────────────────────────────────────────────
# módulo: lixbon_cli/api.py
# ──────────────────────────────────────────────────────────────────────────
"""Cliente HTTP del gateway Lixbon (urllib stdlib, sin dependencias)."""
import json
from urllib import error, request



class ApiError(RuntimeError):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


def _friendly_detail(body: str) -> str:
    """Extrae el detail legible de un error JSON de FastAPI."""
    try:
        data = json.loads(body)
        detail = data.get("detail", body)
        if isinstance(detail, dict):
            return str(detail.get("message") or detail)
        return str(detail)
    except Exception:
        return body[:300]


class ChatStream:
    """Stream de chat cancelable: iterar produce eventos tipados de sse.py."""

    def __init__(self, response):
        self._response = response
        self.closed = False

    def __iter__(self):
        try:
            yield from events_from_stream(self._response)
        finally:
            self.close()

    def close(self) -> None:
        if not self.closed:
            self.closed = True
            try:
                self._response.close()
            except Exception:
                pass


class ApiClient:
    def __init__(self, base_url: str = DEFAULT_BASE_URL, api_key: str = ""):
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.server = server_base(self.base_url)
        self.api_key = api_key

    # ── infraestructura ──────────────────────────────────────────────────

    def _open(self, method: str, url: str, payload: dict | None = None,
              timeout: int = 120, auth: bool = True):
        headers = {"Content-Type": "application/json"}
        if auth and self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        req = request.Request(url=url, method=method, headers=headers, data=data)
        try:
            return request.urlopen(req, timeout=timeout)
        except error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise ApiError(_friendly_detail(body), status=exc.code) from exc
        except Exception as exc:
            raise ApiError(f"Error de conexión: {exc}") from exc

    def _json(self, method: str, url: str, payload: dict | None = None,
              timeout: int = 120, auth: bool = True) -> dict:
        with self._open(method, url, payload, timeout, auth) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}

    # ── auth ─────────────────────────────────────────────────────────────

    def login(self, email: str, password: str) -> dict:
        """Login con credenciales. issue_api_key hace que el server entregue
        una API key propia y rotable (mismo flujo que la app desktop)."""
        return self._json("POST", f"{self.server}/api/auth/login",
                          {"email": email, "password": password, "issue_api_key": True},
                          auth=False)

    def register(self, email: str, password: str, first_name: str = "", last_name: str = "") -> dict:
        return self._json("POST", f"{self.server}/api/auth/register",
                          {"email": email, "password": password,
                           "first_name": first_name, "last_name": last_name},
                          auth=False)

    def key_info(self) -> dict:
        return self._json("GET", f"{self.server}/api/key/info", timeout=15)

    # ── datos ────────────────────────────────────────────────────────────

    def models(self) -> list[str]:
        data = self._json("GET", f"{self.base_url}/models", timeout=20)
        return [str(m.get("id")) for m in data.get("data", [])
                if m.get("id") and not str(m.get("id")).startswith("error:")]

    def usage(self) -> dict:
        return self._json("GET", f"{self.server}/api/usage", timeout=20)

    def nodes(self) -> dict:
        return self._json("GET", f"{self.server}/api/nodes", timeout=20)

    def delegate(self, user_input: str) -> dict:
        return self._json("POST", f"{self.server}/api/delegate",
                          {"user_input": user_input}, timeout=180)

    # ── chat ─────────────────────────────────────────────────────────────

    def chat(self, model: str, messages: list[dict], conversation_id: str | None = None,
             client_id: str = "cli", title: str | None = None, timeout: int = 300) -> dict:
        payload = {
            "model": model,
            "messages": messages,
            "conversation_id": conversation_id,
            "client_id": client_id,
            "title": title,
            "source": "cli",  # historial independiente del de la web/IDE
        }
        return self._json("POST", f"{self.base_url}/chat/completions", payload, timeout=timeout)

    def chat_stream(self, model: str, messages: list[dict], conversation_id: str | None = None,
                    client_id: str = "cli", title: str | None = None,
                    web_search: bool = False, num_ctx: int | None = None) -> ChatStream:
        payload = {
            "model": model,
            "messages": messages,
            "conversation_id": conversation_id,
            "client_id": client_id,
            "title": title,
            "stream": True,
            "web_search": web_search,
            "source": "cli",  # historial independiente del de la web/IDE
        }
        if num_ctx:
            payload["num_ctx"] = int(num_ctx)
        response = self._open("POST", f"{self.base_url}/chat/completions", payload, timeout=300)
        return ChatStream(response)

# ──────────────────────────────────────────────────────────────────────────
# módulo: lixbon_cli/ui.py
# ──────────────────────────────────────────────────────────────────────────
"""Primitivas de interfaz: header, selector con flechas/mouse, barra de estado."""
import sys
from dataclasses import dataclass, field



def esc(text: object) -> str:
    """Escapa texto dinámico para que rich no lo interprete como markup."""
    from rich.markup import escape

    return escape(str(text))


# ── Header y bienvenida ─────────────────────────────────────────────────────

def render_header(console, version: str) -> None:
    spark = g("spark")
    wordmark = " ".join("LIXBON")
    console.print()
    console.print(f"[lx.accent]{spark} {wordmark}[/]  [lx.dim]code {g('sep')} v{version}[/]")
    console.print()


def render_welcome_box(console) -> None:
    from rich import box
    from rich.panel import Panel

    spark = g("spark")
    body = (
        f"[lx.accent]{spark}[/] [bold lx.primary]Lixbon CLI[/] [lx.dim]{g('sep')} asistente de código en tu terminal[/]\n\n"
        f"[lx.dim]Consejos para empezar:[/]\n\n"
        f" [lx.beige]1.[/] [lx.primary]Pide un cambio en lenguaje natural[/]\n"
        f" [lx.beige]2.[/] [lx.primary]Escribe [lx.accent2]/[/] para ver los comandos[/]\n"
        f" [lx.beige]3.[/] [lx.primary]Aprueba las ediciones antes de aplicarlas[/]"
    )
    console.print(Panel(body, box=box.ROUNDED, border_style="lx.dim2", padding=(1, 2), expand=False))
    console.print()


# ── Selector interactivo (flechas + mouse) ──────────────────────────────────

@dataclass
class Option:
    label: str
    value: object = None
    description: str = ""

    def __post_init__(self):
        if self.value is None:
            self.value = self.label


def select(title: str, options: list, default: int = 0, hint: str = "clic o flechas para elegir"):
    """Selector inline estilo Claude Code. Devuelve Option.value o None (Esc).

    Navegación: ↑/↓ (también j/k), Enter confirma, Esc/Ctrl+C cancela.
    Mouse: hover mueve la selección, clic confirma.
    En terminales sin soporte (Git Bash/mintty) degrada a texto plano.
    """

    options = [o if isinstance(o, Option) else Option(str(o)) for o in options]
    if not ui_capable():
        return _select_plain(title, options, default)
    try:
        return _select_app(title, options, default, hint)
    except Exception:
        # La terminal mintió sobre sus capacidades: degradar en caliente
        return _select_plain(title, options, default)


def _select_app(title: str, options: list, default: int, hint: str):
    from prompt_toolkit.application import Application
    from prompt_toolkit.key_binding import KeyBindings
    from prompt_toolkit.layout import HSplit, Layout, Window
    from prompt_toolkit.layout.controls import FormattedTextControl
    from prompt_toolkit.mouse_events import MouseEventType

    state = {"index": max(0, min(default, len(options) - 1)), "result": None, "accepted": False}
    pointer = g("prompt")

    def _mouse_handler_for(i: int):
        def handler(mouse_event):
            if mouse_event.event_type == MouseEventType.MOUSE_MOVE:
                state["index"] = i
            elif mouse_event.event_type == MouseEventType.MOUSE_UP:
                state["index"] = i
                state["accepted"] = True
                app.exit()
            else:
                return NotImplemented
        return handler

    def fragments():
        out = [
            ("", "  "),
            ("class:sel.title", f"? {title} "),
            ("class:sel.hint", f"({hint})\n"),
        ]
        for i, opt in enumerate(options):
            handler = _mouse_handler_for(i)
            active = i == state["index"]
            out.append(("", "  "))
            if active:
                out.append(("class:sel.pointer", f"{pointer} ", handler))
                out.append(("class:sel.active", opt.label, handler))
                if opt.description:
                    out.append(("class:sel.active.desc", f"  {g('sep')} {opt.description}", handler))
            else:
                out.append(("", "  ", handler))
                out.append(("class:sel.option", opt.label, handler))
                if opt.description:
                    out.append(("class:sel.option.desc", f"  {g('sep')} {opt.description}", handler))
            out.append(("", "\n"))
        return out

    kb = KeyBindings()

    @kb.add("up")
    @kb.add("k")
    def _up(event):
        state["index"] = (state["index"] - 1) % len(options)

    @kb.add("down")
    @kb.add("j")
    def _down(event):
        state["index"] = (state["index"] + 1) % len(options)

    @kb.add("enter")
    def _accept(event):
        state["accepted"] = True
        event.app.exit()

    @kb.add("escape", eager=True)
    @kb.add("c-c")
    def _cancel(event):
        state["accepted"] = False
        event.app.exit()

    control = FormattedTextControl(fragments, focusable=True, show_cursor=False)
    app = Application(
        layout=Layout(HSplit([Window(control, always_hide_cursor=True)])),
        key_bindings=kb,
        style=pt_style(),
        mouse_support=True,
        full_screen=False,
        erase_when_done=True,
    )
    app.run()

    console = make_console()
    if state["accepted"]:
        chosen = options[state["index"]]
        console.print(f"[lx.dim]?[/] [lx.primary]{esc(title)}[/] [lx.dim]{g('sep')}[/] [lx.accent2]{esc(chosen.label)}[/]")
        return chosen.value
    console.print(f"[lx.dim]? {esc(title)} {g('sep')} cancelado[/]")
    return None


def _select_plain(title: str, options: list, default: int):
    """Fallback sin prompt_toolkit: elegir escribiendo (Git Bash, pipes)."""
    console = make_console()
    default = max(0, min(default, len(options) - 1))
    console.print(f"[lx.primary]? {esc(title)}[/] [lx.dim2](escribe parte del nombre; Enter = opción marcada; 'x' cancela)[/]")
    for i, opt in enumerate(options):
        marker = f"[lx.accent2]{g('prompt')}[/]" if i == default else " "
        desc = f"  [lx.dim2]{g('sep')} {esc(opt.description)}[/]" if opt.description else ""
        console.print(f"{marker} [lx.primary]{esc(opt.label)}[/]{desc}")
    while True:
        try:
            raw = input("  > ").strip()
        except (KeyboardInterrupt, EOFError):
            print()
            return None
        if not raw:
            console.print(f"[lx.dim]? {esc(title)} {g('sep')}[/] [lx.accent2]{esc(options[default].label)}[/]")
            return options[default].value
        if raw.lower() in ("x", "q", "cancel", "cancelar"):
            return None
        matches = [o for o in options if raw.lower() in o.label.lower()]
        if len(matches) == 1:
            console.print(f"[lx.dim]? {esc(title)} {g('sep')}[/] [lx.accent2]{esc(matches[0].label)}[/]")
            return matches[0].value
        console.print(f"[lx.warn]{'Varias coincidencias' if matches else 'Sin coincidencias'}; sé más específico.[/]")


def confirm3(question: str):
    """Aprobación de 3 vías estilo Claude Code: 'yes' | 'always' | 'no' | None."""
    return select(
        question,
        [
            Option("Sí", "yes", "aplicar este cambio"),
            Option("Sí, y no preguntar más", "always", "auto-aprobar el resto de la sesión"),
            Option("No", "no", "rechazar y decirle al agente que no"),
        ],
    )


# ── Barra de estado ─────────────────────────────────────────────────────────

def fmt_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def context_bar(pct: float, width: int = 10) -> str:
    pct = max(0.0, min(100.0, pct))
    filled = round(width * pct / 100)
    return g("bar_full") * filled + g("bar_empty") * (width - filled)


@dataclass
class StatusBar:
    model: str = ""
    session_label: str = "sin sesión"
    ctx_pct: float = 0.0
    tokens: int = 0
    mode: str = "ask"
    encoding: str = "UTF-8"
    extra: str = ""

    def _parts(self) -> list[tuple[str, str]]:
        sep = ("class:bottom-toolbar.sep", "  |  ")
        parts = [
            ("class:bottom-toolbar.dot", f" {g('dot')} "),
            ("class:bottom-toolbar.model", self.model or "sin modelo"),
            sep,
            ("class:bottom-toolbar", self.session_label),
        ]
        if self.mode and self.mode != "ask":
            parts += [sep, ("class:bottom-toolbar.model", f"modo {self.mode}")]
        parts += [
            sep,
            ("class:bottom-toolbar", f"contexto {context_bar(self.ctx_pct)} {self.ctx_pct:.0f}%"),
            sep,
            ("class:bottom-toolbar", f"{fmt_tokens(self.tokens)} tokens"),
            sep,
            ("class:bottom-toolbar", self.encoding + " "),
        ]
        if self.extra:
            parts += [sep, ("class:bottom-toolbar", self.extra)]
        return parts

    def pt_toolbar(self):
        """Fragmentos para bottom_toolbar de prompt_toolkit."""
        return self._parts()

    def rich_line(self):
        """La misma barra como línea rich (pie del Live durante el stream)."""
        from rich.text import Text

        text = Text()
        for style_cls, chunk in self._parts():
            if style_cls == "class:bottom-toolbar.dot":
                text.append(chunk, style="lx.accent2")
            elif style_cls == "class:bottom-toolbar.model":
                text.append(chunk, style="lx.beige")
            elif style_cls == "class:bottom-toolbar.sep":
                text.append(chunk, style="lx.dim2")
            else:
                text.append(chunk, style="lx.dim")
        return text


# ── Espera / errores ────────────────────────────────────────────────────────

def spinner(text: str):
    """Context manager de espera breve (rich Status)."""
    console = make_console()
    return console.status(f"[lx.dim]{text}[/]", spinner="dots", spinner_style="lx.accent2")


def print_error(message: str) -> None:
    make_console().print(f"[lx.err]{g('cross')} {esc(message)}[/]")


def print_ok(message: str) -> None:
    make_console().print(f"[lx.ok]{g('check')} {esc(message)}[/]")


def print_note(message: str) -> None:
    make_console().print(f"[lx.dim]{esc(message)}[/]")


# ── Demo (comando dev oculto) ───────────────────────────────────────────────

def ui_demo() -> int:
    console = make_console()
    render_header(console, "2.0.0-demo")
    render_welcome_box(console)

    choice = select("Método de acceso", [
        Option("Credenciales", "creds", "correo y contraseña"),
        Option("Clave de API", "key", "folax_sk_…"),
    ])
    console.print(f"[lx.dim]elegido:[/] {choice!r}")

    decision = confirm3("¿Aplicar este cambio?")
    console.print(f"[lx.dim]decisión:[/] {decision!r}")

    console.print(f"\n[lx.ok]+ línea añadida[/]\n[lx.err]- línea eliminada[/]\n[lx.thinking]así se ve el thinking del modelo…[/]\n")
    bar = StatusBar(model="folax-sonnet-4", session_label="sin sesión", ctx_pct=42.0, tokens=1234)
    console.print(bar.rich_line())

    import time
    with spinner("pensando…"):
        time.sleep(1.2)
    print_ok("demo completa")
    return 0

# ──────────────────────────────────────────────────────────────────────────
# módulo: lixbon_cli/diffs.py
# ──────────────────────────────────────────────────────────────────────────
"""Gestión visual de cambios de código: resúmenes ● Update(...) +N -M y diffs."""
import difflib
from dataclasses import dataclass
from pathlib import Path



@dataclass
class FileChange:
    kind: str          # create | update | delete | rename | mkdir | command | append
    path: str
    old_text: str = ""
    new_text: str = ""
    detail: str = ""   # destino de rename, comando de run_command, etc.

    @property
    def verb(self) -> str:
        return {
            "create": "Create",
            "update": "Update",
            "delete": "Delete",
            "rename": "Rename",
            "mkdir": "Mkdir",
            "append": "Append",
            "command": "Run",
        }.get(self.kind, self.kind.title())


def compute_change(workspace: Path, tool_name: str, args: dict, resolve_path) -> FileChange | None:
    """Describe el efecto de un tool ANTES de ejecutarlo (para aprobar con contexto).

    Devuelve None para herramientas de solo lectura (no requieren aprobación).
    """
    rel = args.get("path", "")
    if tool_name in ("write_file", "append_file"):
        new_content = args.get("content", "")
        try:
            target = resolve_path(workspace, rel)
            old = target.read_text(encoding="utf-8", errors="replace") if target.exists() else None
        except Exception:
            old = None
        if tool_name == "append_file":
            return FileChange("append", rel, old or "", (old or "") + new_content)
        if old is None:
            return FileChange("create", rel, "", new_content)
        return FileChange("update", rel, old, new_content)
    if tool_name == "edit_file":
        old_frag = args.get("old_text", "")
        try:
            target = resolve_path(workspace, rel)
            old = target.read_text(encoding="utf-8", errors="replace") if target.is_file() else ""
        except Exception:
            old = ""
        if not old or not old_frag or old_frag not in old:
            # El error real (no encontrado / ambiguo) saldrá al ejecutar
            return FileChange("update", rel, old, old)
        new = (old.replace(old_frag, args.get("new_text", ""))
               if args.get("all") else old.replace(old_frag, args.get("new_text", ""), 1))
        return FileChange("update", rel, old, new)
    if tool_name == "delete_file":
        try:
            target = resolve_path(workspace, rel)
            old = target.read_text(encoding="utf-8", errors="replace") if target.is_file() else ""
        except Exception:
            old = ""
        return FileChange("delete", rel, old, "")
    if tool_name == "rename_file":
        return FileChange("rename", args.get("src", ""), detail=args.get("dst", ""))
    if tool_name == "mkdir":
        return FileChange("mkdir", rel)
    if tool_name == "run_command":
        return FileChange("command", "", detail=args.get("command", ""))
    return None  # list_files, read_file, search: solo lectura


def diff_counts(change: FileChange) -> tuple[int, int]:
    adds = dels = 0
    for line in _unified(change):
        if line.startswith("+") and not line.startswith("+++"):
            adds += 1
        elif line.startswith("-") and not line.startswith("---"):
            dels += 1
    return adds, dels


def _unified(change: FileChange) -> list[str]:
    return list(difflib.unified_diff(
        change.old_text.splitlines(),
        change.new_text.splitlines(),
        fromfile=f"{change.path} (antes)",
        tofile=f"{change.path} (ahora)",
        lineterm="",
        n=2,
    ))


def render_change(console, change: FileChange, max_lines: int = 40) -> None:
    """Imprime `● Update(ruta) +12 -3` y el diff coloreado truncado."""
    dot = g("dot")
    if change.kind == "command":
        console.print(f"[lx.accent2]{dot}[/] [bold lx.primary]Run[/][lx.dim]([/][lx.beige]{_escape(change.detail)}[/][lx.dim])[/]")
        return
    if change.kind == "rename":
        console.print(
            f"[lx.accent2]{dot}[/] [bold lx.primary]Rename[/][lx.dim]([/][lx.beige]{_escape(change.path)}[/]"
            f"[lx.dim] {g('arrow')} [/][lx.beige]{_escape(change.detail)}[/][lx.dim])[/]"
        )
        return
    if change.kind == "mkdir":
        console.print(f"[lx.accent2]{dot}[/] [bold lx.primary]Mkdir[/][lx.dim]([/][lx.beige]{_escape(change.path)}[/][lx.dim])[/]")
        return

    adds, dels = diff_counts(change)
    summary = f"[lx.accent2]{dot}[/] [bold lx.primary]{change.verb}[/][lx.dim]([/][lx.beige]{_escape(change.path)}[/][lx.dim])[/]"
    if adds or dels:
        summary += f"  [lx.diff.add]+{adds}[/] [lx.diff.del]-{dels}[/]"
    console.print(summary)

    lines = _unified(change)
    if not lines:
        return
    shown = lines[:max_lines]
    for line in shown:
        if line.startswith("+++") or line.startswith("---"):
            console.print(f"  [lx.dim]{_escape(line)}[/]")
        elif line.startswith("@@"):
            console.print(f"  [lx.diff.hunk]{_escape(line)}[/]")
        elif line.startswith("+"):
            console.print(f"  [lx.diff.add]{_escape(line)}[/]")
        elif line.startswith("-"):
            console.print(f"  [lx.diff.del]{_escape(line)}[/]")
        else:
            console.print(f"  [lx.dim]{_escape(line)}[/]")
    if len(lines) > max_lines:
        console.print(f"  [lx.dim2]{g('ellipsis')} +{len(lines) - max_lines} líneas más[/]")


def _escape(line: str) -> str:
    return line.replace("[", "\\[")

# ──────────────────────────────────────────────────────────────────────────
# módulo: lixbon_cli/agent.py
# ──────────────────────────────────────────────────────────────────────────
"""Modo agent: herramientas locales de código y loop de ejecución.

El modelo emite JSON `{"tool": ..., "args": {...}}` embebido en su respuesta;
aquí se parsea, se pide aprobación (con vista previa del diff) y se ejecuta.
"""
import json
import re
import subprocess
from pathlib import Path


MAX_AGENT_STEPS = 12

READ_ONLY_TOOLS = {"list_files", "read_file", "search"}

# Recordatorio de una sola vez cuando el modelo "sugiere" código en el chat
# en vez de aplicarlo con herramientas (vicio típico de los modelos chicos).
NUDGE_PROMPT = (
    "Si ese código debía aplicarse a un archivo del workspace, hazlo AHORA con "
    '{"tool":"write_file","args":{"path":"...","content":"CONTENIDO COMPLETO"}} '
    '(JSON puro, sin ```). Si no había nada que aplicar, responde solo "OK".'
)

TRUNCATED_PROMPT = (
    "Tu respuesta anterior se CORTÓ a mitad porque el contenido era demasiado largo. "
    "NO reescribas el archivo entero con write_file. Usa edit_file para cambiar solo las "
    "secciones necesarias (old_text/new_text), en varios pasos pequeños si hace falta."
)

IGNORED_TREE_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build",
    "target", ".next", ".idea", ".vscode", ".mypy_cache", ".pytest_cache",
}
MAX_TREE_ENTRIES = 150


def workspace_tree(workspace: Path, max_entries: int = MAX_TREE_ENTRIES) -> str:
    """Listado compacto del workspace para el system prompt del agente.

    Da al modelo visión inmediata del proyecto sin que tenga que llamar
    list_files; se trunca para no comerse la ventana de contexto.
    """
    entries: list[str] = []
    truncated = False

    def walk(directory: Path, depth: int) -> None:
        nonlocal truncated
        if truncated or depth > 4:
            return
        try:
            items = sorted(directory.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except OSError:
            return
        for item in items:
            if len(entries) >= max_entries:
                truncated = True
                return
            rel = item.relative_to(workspace).as_posix()
            if item.is_dir():
                if item.name in IGNORED_TREE_DIRS:
                    continue
                entries.append(f"{rel}/")
                walk(item, depth + 1)
            else:
                entries.append(rel)

    walk(workspace, 1)
    if not entries:
        return "(workspace vacío)"
    tree = "\n".join(entries)
    if truncated:
        tree += "\n… (hay más archivos; usa list_files para explorar)"
    return tree


def build_agent_system_prompt(workspace: Path) -> str:
    return (
        "Eres un agente de código experto que trabaja DIRECTAMENTE sobre los archivos del usuario.\n"
        f"Workspace: {workspace}\n"
        "Rutas siempre RELATIVAS al workspace.\n\n"
        "=== HERRAMIENTAS DISPONIBLES ===\n"
        "Para usar una herramienta escribe una línea que contenga SOLO su JSON:\n"
        '{"tool":"list_files","args":{"path":"."}}\n'
        '{"tool":"read_file","args":{"path":"archivo.txt"}}  (opcional: "start_line" y "end_line" para archivos grandes)\n'
        '{"tool":"edit_file","args":{"path":"archivo.txt","old_text":"fragmento EXACTO actual","new_text":"fragmento nuevo"}}\n'
        '{"tool":"write_file","args":{"path":"archivo.txt","content":"contenido completo"}}\n'
        '{"tool":"append_file","args":{"path":"archivo.txt","content":"texto nuevo al final"}}\n'
        '{"tool":"mkdir","args":{"path":"carpeta/subcarpeta"}}\n'
        '{"tool":"search","args":{"pattern":"texto a buscar","path":"."}}\n'
        '{"tool":"delete_file","args":{"path":"archivo.txt"}}\n'
        '{"tool":"rename_file","args":{"src":"viejo.txt","dst":"nuevo.txt"}}\n'
        '{"tool":"run_command","args":{"command":"npm install","timeout":60}}\n\n'
        "=== REGLAS OBLIGATORIAS ===\n"
        "1. Si el usuario pide crear, modificar, arreglar, eliminar o ejecutar algo, DEBES hacerlo "
        "con herramientas EN ESTA MISMA RESPUESTA. Tú ejecutas los cambios; el usuario no copia código.\n"
        "2. PROHIBIDO responder a una petición de cambio mostrando código en bloques ```: "
        "el código va DENTRO del JSON de edit_file o write_file.\n"
        "3. Emite el JSON puro de la herramienta, sin envolverlo en markdown.\n"
        "4. Para EDITAR o MEJORAR un archivo existente: primero read_file, luego edit_file con el fragmento exacto "
        "(old_text copiado tal cual, con su indentación). NUNCA reescribas un archivo grande entero con write_file: "
        "la salida se trunca y falla. write_file es SOLO para archivos nuevos. Haz varios edit_file pequeños si el cambio es amplio.\n"
        "5. Puedes encadenar varias herramientas en una misma respuesta.\n"
        "6. Los resultados te llegan como TOOL_RESULT. Úsalos para continuar; nunca los escribas tú.\n"
        "7. Tras cambiar código, si el proyecto tiene tests o build, verifica con run_command; "
        "si el resultado trae un error (EXIT distinto de 0), CORRIGE el archivo y vuelve a ejecutar hasta que pase.\n"
        "8. Cuando termines todas las acciones, responde SOLO con texto normal (sin JSON ni código) resumiendo lo que hiciste.\n\n"
        "=== EJEMPLO 1 (crear) ===\n"
        "Usuario: crea un script que imprima hola\n"
        'Asistente: {"tool":"write_file","args":{"path":"hola.py","content":"print(\'hola\')\\n"}}\n'
        "Usuario: TOOL_RESULT write_file: Archivo creado: hola.py (14 chars)\n"
        "Asistente: Listo: creé hola.py, que imprime «hola» al ejecutarlo.\n\n"
        "=== EJEMPLO 2 (editar) ===\n"
        "Usuario: renombra la variable x a total en utils.js\n"
        'Asistente: {"tool":"read_file","args":{"path":"utils.js"}}\n'
        "Usuario: TOOL_RESULT read_file: export const x = 1;\\nexport const y = x + 2;\n"
        'Asistente: {"tool":"edit_file","args":{"path":"utils.js","old_text":"export const x = 1;\\nexport const y = x + 2;","new_text":"export const total = 1;\\nexport const y = total + 2;"}}\n'
        "Usuario: TOOL_RESULT edit_file: Archivo editado: utils.js (1 reemplazo)\n"
        "Asistente: Hecho: renombré x a total en utils.js.\n\n"
        "=== ARCHIVOS DEL WORKSPACE ===\n"
        f"{workspace_tree(workspace)}\n\n"
        "=== RECUERDA ===\n"
        "Las peticiones de cambio se resuelven con herramientas, nunca mostrando código en el chat."
    )


# ── Sandbox de rutas y herramientas ─────────────────────────────────────────

def resolve_safe_path(workspace: Path, user_path: str) -> Path:
    path = Path(user_path)
    full = (workspace / path).resolve() if not path.is_absolute() else path.resolve()
    if workspace not in [full, *full.parents]:
        raise RuntimeError("Ruta fuera del workspace permitido")
    return full


def tool_list_files(workspace: Path, rel_path: str = ".") -> str:
    target = resolve_safe_path(workspace, rel_path)
    if not target.exists():
        return f"No existe: {target}"
    if target.is_file():
        return str(target.relative_to(workspace))
    items = sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    lines = []
    for p in items[:200]:
        marker = "F" if p.is_file() else "D"
        lines.append(f"[{marker}] {p.relative_to(workspace)}")
    return "\n".join(lines) if lines else "(vacio)"


def tool_read_file(workspace: Path, rel_path: str, start_line: int = 0, end_line: int = 0) -> str:
    target = resolve_safe_path(workspace, rel_path)
    if not target.exists() or not target.is_file():
        return f"Archivo no encontrado: {rel_path}"
    content = target.read_text(encoding="utf-8", errors="replace")
    if start_line or end_line:
        lines = content.split("\n")
        s = max(1, int(start_line or 1))
        e = min(len(lines), int(end_line or len(lines)))
        return f"(líneas {s}-{e} de {len(lines)})\n" + "\n".join(lines[s - 1:e])
    if len(content) > 120000:
        total = content.count("\n") + 1
        return (f"(archivo grande: {total} líneas; pide rangos con start_line/end_line)\n"
                + content[:120000])
    return content


def tool_edit_file(workspace: Path, rel_path: str, old_text: str, new_text: str,
                   replace_all: bool = False) -> str:
    """Edición parcial estilo Cursor/Claude Code: reemplazo EXACTO de un
    fragmento. Evita reescribir archivos enteros (donde los modelos truncan)."""
    target = resolve_safe_path(workspace, rel_path)
    if not target.is_file():
        return f"Archivo no encontrado: {rel_path}"
    if not old_text:
        return "[ERROR] Falta old_text (el fragmento exacto a reemplazar)"
    content = target.read_text(encoding="utf-8", errors="replace")
    count = content.count(old_text)
    if count == 0:
        return (f"[ERROR] No se encontró old_text en {rel_path}. Debe coincidir EXACTO "
                "(espacios e indentación incluidos); usa read_file y copia el fragmento tal cual")
    if count > 1 and not replace_all:
        return (f"[ERROR] old_text aparece {count} veces en {rel_path}; añade más líneas de "
                'contexto para que sea único, o pasa "all":true para reemplazar todas')
    updated = content.replace(old_text, new_text) if replace_all else content.replace(old_text, new_text, 1)
    target.write_text(updated, encoding="utf-8")
    return f"Archivo editado: {rel_path} ({count} reemplazo{'s' if count > 1 else ''})"


def tool_write_file(workspace: Path, rel_path: str, content: str) -> str:
    target = resolve_safe_path(workspace, rel_path)
    is_new = not target.exists()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    action = "creado" if is_new else "actualizado"
    return f"Archivo {action}: {target.relative_to(workspace)} ({len(content)} chars)"


def tool_append_file(workspace: Path, rel_path: str, content: str) -> str:
    target = resolve_safe_path(workspace, rel_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a", encoding="utf-8") as f:
        f.write(content)
    return f"Archivo actualizado: {target.relative_to(workspace)} (+{len(content)} chars)"


def tool_mkdir(workspace: Path, rel_path: str) -> str:
    target = resolve_safe_path(workspace, rel_path)
    target.mkdir(parents=True, exist_ok=True)
    return f"Directorio creado/listo: {target.relative_to(workspace)}"


def tool_search(workspace: Path, pattern: str, rel_path: str = ".") -> str:
    target = resolve_safe_path(workspace, rel_path)
    try:
        cmd = ["rg", "-n", "--hidden", "--glob", "!.git", pattern, str(target)]
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True)
        return out[:120000] if out else "(sin resultados)"
    except FileNotFoundError:
        return _search_python(workspace, target, pattern)
    except subprocess.CalledProcessError as exc:
        return (exc.output or "").strip() or "(sin resultados)"


def _search_python(workspace: Path, target: Path, pattern: str) -> str:
    """Fallback sin ripgrep: búsqueda simple por substring."""
    hits: list[str] = []
    files = [target] if target.is_file() else [
        p for p in target.rglob("*") if p.is_file() and ".git" not in p.parts
    ]
    for p in files[:2000]:
        try:
            for lineno, line in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if pattern in line:
                    hits.append(f"{p.relative_to(workspace)}:{lineno}:{line.strip()[:200]}")
                    if len(hits) >= 500:
                        return "\n".join(hits)
        except Exception:
            continue
    return "\n".join(hits) if hits else "(sin resultados)"


def tool_delete_file(workspace: Path, rel_path: str) -> str:
    target = resolve_safe_path(workspace, rel_path)
    if not target.exists():
        return f"No encontrado: {rel_path}"
    if target.is_dir():
        import shutil
        shutil.rmtree(target)
        return f"Directorio eliminado: {rel_path}"
    target.unlink()
    return f"Archivo eliminado: {rel_path}"


def tool_rename_file(workspace: Path, src: str, dst: str) -> str:
    source = resolve_safe_path(workspace, src)
    dest = resolve_safe_path(workspace, dst)
    if not source.exists():
        return f"No encontrado: {src}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    source.rename(dest)
    return f"Movido: {src} {g('arrow')} {dst}"


def tool_run_command(workspace: Path, command: str, timeout: int = 30) -> str:
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=str(workspace),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        output = (result.stdout + result.stderr).strip()
        prefix = f"[EXIT {result.returncode}] "
        return prefix + (output[:8000] if output else "(sin salida)")
    except subprocess.TimeoutExpired:
        return f"[TIMEOUT] Comando excedio {timeout}s"
    except Exception as exc:
        return f"[ERROR] {exc}"


def execute_tool_call(workspace: Path, tool_name: str, args: dict) -> str:
    if tool_name == "list_files":
        return tool_list_files(workspace, args.get("path", "."))
    if tool_name == "read_file":
        return tool_read_file(workspace, args.get("path", ""),
                              int(args.get("start_line") or 0), int(args.get("end_line") or 0))
    if tool_name == "write_file":
        return tool_write_file(workspace, args.get("path", ""), args.get("content", ""))
    if tool_name == "edit_file":
        return tool_edit_file(workspace, args.get("path", ""), args.get("old_text", ""),
                              args.get("new_text", ""), bool(args.get("all")))
    if tool_name == "append_file":
        return tool_append_file(workspace, args.get("path", ""), args.get("content", ""))
    if tool_name == "mkdir":
        return tool_mkdir(workspace, args.get("path", ""))
    if tool_name == "search":
        return tool_search(workspace, args.get("pattern", ""), args.get("path", "."))
    if tool_name == "delete_file":
        return tool_delete_file(workspace, args.get("path", ""))
    if tool_name == "rename_file":
        return tool_rename_file(workspace, args.get("src", ""), args.get("dst", ""))
    if tool_name == "run_command":
        return tool_run_command(workspace, args.get("command", ""), int(args.get("timeout", 30)))
    raise RuntimeError(f"Herramienta no soportada: {tool_name}")


# ── Parseo de tool calls embebidos en texto ─────────────────────────────────

def _validate_tool_dict(data: dict) -> dict | None:
    """Normaliza a {tool, args}. Acepta nuestro formato {tool,args} y el de
    función de OpenAI {name,arguments} (que emiten modelos primados con tools,
    p.ej. qwen2.5-coder). Devuelve None si no parece una llamada."""
    if not isinstance(data, dict):
        return None
    if data.get("tool"):
        args = data.get("args")
        return {"tool": data["tool"], "args": args if isinstance(args, dict) else {}}
    # {name, arguments}: solo con arguments presente (evita falsos positivos)
    if data.get("name") and data.get("arguments") is not None:
        args = data["arguments"]
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                args = {}
        return {"tool": data["name"], "args": args if isinstance(args, dict) else {}}
    return None


# `{` + cualquier espacio + `"tool"` (nuestro formato) o `"name"` (formato
# función de OpenAI). Los modelos suelen indentar el JSON ({\n  "tool": …).
_TOOL_START = re.compile(r'\{\s*"(tool|name)"')


def _iter_tool_call_spans(text: str) -> list[tuple[dict, int, int]]:
    """Localiza los JSON `{"tool":...}` embebidos: (call, inicio, fin_exclusivo).

    Cuenta llaves para soportar JSON anidado (write_file con content largo).
    """
    results = []
    i = 0
    while i < len(text):
        m = _TOOL_START.search(text, i)
        if not m:
            break
        start = m.start()
        depth = 0
        j = start
        in_string = False
        escape_next = False
        while j < len(text):
            ch = text[j]
            if escape_next:
                escape_next = False
            elif ch == "\\" and in_string:
                escape_next = True
            elif ch == '"':
                in_string = not in_string
            elif not in_string:
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        candidate = text[start: j + 1]
                        try:
                            # strict=False: tolera saltos de línea reales dentro
                            # de strings (JSON inválido pero frecuente en LLMs)
                            data = _validate_tool_dict(json.loads(candidate, strict=False))
                            if data:
                                results.append((data, start, j + 1))
                        except Exception:
                            pass
                        i = j + 1
                        break
            j += 1
        else:
            break
    return results


def extract_all_tool_calls(text: str) -> list[dict]:
    """Extrae todos los JSON `{"tool":...}` embebidos en texto mixto."""
    return [call for call, _, _ in _iter_tool_call_spans(text)]


def strip_tool_calls(text: str) -> str:
    """Quita los JSON de herramientas del texto para mostrar solo la prosa.

    Corta por posición (no por re-serialización): el JSON del modelo rara vez
    coincide byte a byte con json.dumps.
    """
    for _, start, end in reversed(_iter_tool_call_spans(text)):
        text = text[:start] + text[end:]
    return text


def truncate_fabricated(text: str) -> str:
    """Corta donde el modelo fabrica un "TOOL_RESULT …" (se contesta a sí
    mismo imitando el ejemplo del prompt): lo posterior es alucinado."""
    idx = text.find("TOOL_RESULT")
    if idx == -1:
        return text
    line_start = text.rfind("\n", 0, idx)
    return text[: idx if line_start == -1 else line_start]


def cut_unclosed_call(text: str) -> str:
    """Corta un tool-call JSON iniciado pero SIN CERRAR al final (salida
    truncada al reescribir un archivo grande): evita filtrar JSON crudo."""
    starts = [m.start() for m in _TOOL_START.finditer(text)]
    if not starts:
        return text
    last = starts[-1]
    depth = 0
    in_string = False
    escape_next = False
    closed = False
    j = last
    while j < len(text):
        ch = text[j]
        if escape_next:
            escape_next = False
        elif ch == "\\" and in_string:
            escape_next = True
        elif ch == '"':
            in_string = not in_string
        elif not in_string:
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    closed = True
                    break
        j += 1
    return text if closed else text[:last]


def has_unclosed_call(text: str) -> bool:
    return len(cut_unclosed_call(text)) < len(text)


def clean_prose(text: str) -> str:
    """Prosa final mostrable: sin tool calls (completos ni truncados), sin
    TOOL_RESULT fabricados y sin las vallas de código vacías (```json```)."""
    text = cut_unclosed_call(strip_tool_calls(truncate_fabricated(text)))
    text = re.sub(r"```[\w-]*\s*```", "", text)
    return text.strip()


# ── Loop del agente ─────────────────────────────────────────────────────────

def run_agent_turn(history: list[dict], workspace: Path, session: dict,
                   stream_assistant) -> tuple[str, list[dict]]:
    """Ejecuta un turno de agente con aprobación interactiva.

    - `session`: estado mutable con `auto_approve: bool`.
    - `stream_assistant(messages) -> str`: lo aporta la app; muestra el texto
      del modelo en vivo y devuelve la respuesta completa.
    Devuelve (respuesta_final, history_actualizado).
    """
    console = make_console()
    system_msg = {"role": "system", "content": build_agent_system_prompt(workspace)}
    working = history[:]

    nudged = False
    for _ in range(MAX_AGENT_STEPS):
        # Sin el corte, el modelo "ejecutaría" resultados que él mismo inventó
        assistant = truncate_fabricated(stream_assistant([system_msg] + working))
        working.append({"role": "assistant", "content": assistant})

        tool_calls = extract_all_tool_calls(assistant)
        if not tool_calls:
            if not nudged and has_unclosed_call(assistant):
                # Salida truncada a mitad de un tool-call: empujar a edit_file
                nudged = True
                working.append({"role": "user", "content": TRUNCATED_PROMPT})
                continue
            if not nudged and "```" in assistant:
                # Mostró código en vez de aplicarlo: una oportunidad de corregirse
                nudged = True
                working.append({"role": "user", "content": NUDGE_PROMPT})
                continue
            return assistant, working

        combined_results = []
        for call in tool_calls:
            tool_name = call.get("tool", "")
            args = call.get("args", {})
            result = _approve_and_run(console, workspace, session, tool_name, args)
            combined_results.append(f"TOOL_RESULT {tool_name}: {result}")

        working.append({"role": "user", "content": "\n".join(combined_results)})

    return "No se pudo finalizar: se alcanzó el máximo de pasos del agente.", working


def _approve_and_run(console, workspace: Path, session: dict, tool_name: str, args: dict) -> str:
    dot = g("dot")

    if tool_name in READ_ONLY_TOOLS:
        # Solo lectura: se ejecuta sin preguntar, con rastro discreto.
        label = args.get("path") or args.get("pattern") or "."
        console.print(f"[lx.dim]{dot} {tool_name}({esc(label)})[/]")
        return _run(console, workspace, tool_name, args)

    try:
        change = compute_change(workspace, tool_name, args, resolve_safe_path)
    except Exception:
        change = None
    if change is not None:
        render_change(console, change)
    else:
        console.print(f"[lx.accent2]{dot}[/] [bold lx.primary]{tool_name}[/] [lx.dim]{esc(args)}[/]")

    # Los comandos de shell son irreversibles (sin snapshot que los deshaga):
    # tienen su propio flag y NO los cubre auto_approve. Así, responder
    # "siempre" tras una edición de archivo no habilita ejecutar comandos.
    if tool_name == "run_command":
        if not session.get("auto_run_commands"):
            decision = confirm3("¿Ejecutar este comando?")
            if decision == "always":
                session["auto_run_commands"] = True
            elif decision in ("no", None):
                console.print(f"[lx.dim]{dot} rechazado[/]")
                return "Ejecución cancelada por el usuario"
    elif not session.get("auto_approve"):
        decision = confirm3("¿Aplicar este cambio?")
        if decision == "always":
            session["auto_approve"] = True
        elif decision in ("no", None):
            console.print(f"[lx.dim]{dot} rechazado[/]")
            return "Ejecución cancelada por el usuario"

    return _run(console, workspace, tool_name, args)


def _run(console, workspace: Path, tool_name: str, args: dict) -> str:
    try:
        result = execute_tool_call(workspace, tool_name, args)
    except Exception as exc:
        result = f"[ERROR] {exc}"
    if tool_name not in READ_ONLY_TOOLS:
        first_line = result.split("\n", 1)[0][:120]
        style = "lx.err" if result.startswith("[ERROR]") else "lx.dim"
        console.print(f"  [{style}]{g('arrow')} {esc(first_line)}[/]")
    return result

# ──────────────────────────────────────────────────────────────────────────
# módulo: lixbon_cli/commands.py
# ──────────────────────────────────────────────────────────────────────────
"""Slash-commands: especificación, autocompletado con menú y adjuntos de imagen."""
import base64
import re
from pathlib import Path

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
MAX_IMAGE_BYTES = 8 * 1024 * 1024

# (nombre, argumentos, descripción) — los handlers viven en ChatApp como cmd_<nombre>
COMMAND_SPECS: list[tuple[str, str, str]] = [
    ("help", "", "Ver todos los comandos"),
    ("model", "[nombre]", "Cambiar de modelo (sin argumento abre el selector)"),
    ("mode", "[ask|agent|delegate]", "Cambiar modo de trabajo"),
    ("new", "", "Empezar una conversación nueva"),
    ("compact", "", "Compactar la conversación para liberar contexto"),
    ("image", "<ruta>", "Adjuntar una imagen al próximo mensaje (también @ruta)"),
    ("usage", "", "Ver uso global de la cuenta"),
    ("nodes", "", "Ver nodos del clúster"),
    ("status", "", "Ver estado de la sesión"),
    ("login", "", "Iniciar sesión de nuevo"),
    ("key", "<api_key>", "Usar otra API key"),
    ("approve", "[on|off]", "Auto-aprobar herramientas del agente"),
    ("workspace", "<ruta>", "Carpeta de trabajo del modo agent"),
    ("context-window", "<n>", "Tokens de la ventana de contexto (para la barra)"),
    ("copy", "", "Copiar la última respuesta al portapapeles"),
    ("clear", "", "Limpiar la pantalla"),
    ("update", "", "Actualizar el CLI desde el servidor"),
    ("exit", "", "Salir"),
]


def make_completer(app):
    """Completer de prompt_toolkit: menú al escribir `/` y modelos en `/model `."""
    from prompt_toolkit.completion import Completer, Completion

    class SlashCompleter(Completer):
        def get_completions(self, document, complete_event):
            text = document.text_before_cursor
            if not text.startswith("/"):
                return
            # Autocompletar el argumento de /model con los modelos cargados
            if text.startswith("/model "):
                prefix = text[len("/model "):]
                for model in app.models_cache:
                    if prefix.lower() in model.lower():
                        yield Completion(model, start_position=-len(prefix))
                return
            if " " in text:
                return
            prefix = text[1:]
            for name, args, desc in COMMAND_SPECS:
                if name.startswith(prefix):
                    display = f"/{name} {args}".strip()
                    # Con argumento: dejar espacio final para encadenar el
                    # autocompletado del argumento (ej. /model → modelos)
                    completion_text = f"/{name} " if args else f"/{name}"
                    yield Completion(
                        completion_text,
                        start_position=-len(text),
                        display=display,
                        display_meta=desc,
                    )

    return SlashCompleter()


# ── Adjuntos de imagen ──────────────────────────────────────────────────────

_AT_PATH_RE = re.compile(r'@(?:"([^"]+)"|(\S+))')


def _looks_like_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_EXTS


def parse_attachments(text: str, base_dir: Path) -> tuple[str, list[Path], list[str]]:
    """Extrae rutas de imagen `@ruta` del mensaje.

    Devuelve (texto_limpio, imágenes, errores). Solo se tratan como adjunto
    los @tokens que apuntan a una imagen; el resto del texto queda intacto.
    """
    images: list[Path] = []
    errors: list[str] = []

    def _replace(match: re.Match) -> str:
        raw = match.group(1) or match.group(2)
        path = Path(raw)
        if not path.is_absolute():
            path = (base_dir / path)
        if not _looks_like_image(path):
            return match.group(0)  # no es imagen: se deja tal cual
        if not path.exists():
            errors.append(f"No existe la imagen: {raw}")
            return ""
        images.append(path.resolve())
        return path.name  # el texto conserva el nombre para dar contexto al modelo

    clean = _AT_PATH_RE.sub(_replace, text).strip()
    return clean, images, errors


def encode_image(path: Path) -> str:
    """Valida y codifica una imagen a base64 (para ChatMessage.images)."""
    if not path.exists() or not path.is_file():
        raise ValueError(f"No existe la imagen: {path}")
    if not _looks_like_image(path):
        raise ValueError(f"Formato no soportado ({path.suffix}); usa png/jpg/jpeg/webp")
    data = path.read_bytes()
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError(f"La imagen supera el límite de 8 MB: {path.name}")
    return base64.b64encode(data).decode("ascii")


def fmt_size(num_bytes: int) -> str:
    if num_bytes >= 1024 * 1024:
        return f"{num_bytes / (1024 * 1024):.1f} MB"
    return f"{num_bytes / 1024:.0f} KB"

# ──────────────────────────────────────────────────────────────────────────
# módulo: lixbon_cli/app.py
# ──────────────────────────────────────────────────────────────────────────
"""ChatApp: loop principal del CLI interactivo (transcript inline estilo Claude Code)."""
import os
import subprocess
import time
import uuid
from pathlib import Path


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
        # El workspace es SIEMPRE la carpeta desde la que se lanzó el CLI
        # (como Claude Code); /workspace lo cambia solo para la sesión.
        self.workspace = Path.cwd().resolve()
        self.session = {
            "auto_approve": bool(self.cfg.get("auto_approve_tools", False)),
            # Comandos de shell: flag aparte de auto_approve (irreversibles).
            "auto_run_commands": bool(self.cfg.get("auto_run_commands", False)),
        }
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
        # Mide lo que se ENVIARÁ al modelo (últimos max_context_messages),
        # no todo el historial: es lo que de verdad ocupa la ventana.
        sent = self._context_messages()
        chars = sum(len(m.get("content", "")) for m in sent)
        tokens = int(chars / max(self.chars_per_token, 1.0))
        tokens += TOKENS_PER_IMAGE * sum(len(m.get("images") or []) for m in sent)
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
        if self.mode == "ask":
            print_note("En modo ask el modelo solo conversa; usa /mode agent para que cree y edite archivos.")
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

    def _completion_bindings(self):
        """Enter/Tab aplican la sugerencia del menú de comandos (como Claude Code)."""
        from prompt_toolkit.filters import has_completions
        from prompt_toolkit.key_binding import KeyBindings

        kb = KeyBindings()

        def _apply(event) -> bool:
            buff = event.current_buffer
            state = buff.complete_state
            if not state or not state.completions:
                return False
            completion = state.current_completion
            if completion is None:
                # Sin navegar: autocompletar solo el NOMBRE del comando;
                # en menús de argumentos Enter debe enviar, no elegir por ti.
                if " " in buff.text:
                    return False
                completion = state.completions[0]
            # Si lo escrito ya ES la sugerencia, no hay nada que completar
            if buff.text.strip() == completion.text.strip():
                buff.cancel_completion()
                return False
            buff.apply_completion(completion)
            return True

        @kb.add("enter", filter=has_completions)
        def _enter(event):
            if not _apply(event):
                event.current_buffer.validate_and_handle()

        @kb.add("tab", filter=has_completions)
        def _tab(event):
            _apply(event)

        return kb

    def _prompt_loop(self) -> int:

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
            bottom_toolbar=lambda: self.status.pt_toolbar(),
            reserve_space_for_menu=6,
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
            print_error(str(exc))
        return True

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
            num_ctx=self.cfg.get("context_window"),
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
            return pad(Group(*blocks))

        def _final_view():
            blocks = []
            if reasoning_seconds > 0.5:
                blocks.append(Text(f"{g('spark_alt')} Pensó durante {reasoning_seconds:.1f}s", style="lx.dim2"))
            text = "".join(content_parts).strip()
            if self.mode == "agent":
                text = clean_prose(text) or f"[herramientas solicitadas {g('ellipsis')}]"
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
            ("Auto-run comandos", "on" if self.session.get("auto_run_commands") else "off"),
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

        cmd_update(None)
        return True

    def cmd_exit(self, arg: str):
        print_note("Hasta pronto.")
        return False

# ──────────────────────────────────────────────────────────────────────────
# módulo: lixbon_cli/cli.py
# ──────────────────────────────────────────────────────────────────────────
"""Entrada del CLI: argparse y comandos no interactivos (stdlib puro).

Los comandos `init/status/models/usage/update` funcionan sin dependencias.
`chat` (y `setup`/`ui-demo`) instalan prompt_toolkit + rich si faltan.
"""
import argparse
import hashlib
import os
import sys
import time
from pathlib import Path
from urllib import request


REQUIRED_PACKAGES = ("prompt_toolkit", "rich")


def ensure_deps() -> bool:
    """Instala las dependencias de la interfaz si faltan (patrón autoinstalable)."""
    missing = []
    for pkg in REQUIRED_PACKAGES:
        try:
            __import__(pkg)
        except ImportError:
            missing.append(pkg)
    if not missing:
        return True
    print(f"Instalando la interfaz del CLI ({', '.join(missing)})…")
    import subprocess

    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", *missing])
        return True
    except Exception as exc:
        print(f"No se pudieron instalar las dependencias: {exc}")
        print(f"Instálalas manualmente: {sys.executable} -m pip install {' '.join(missing)}")
        return False


# ── comandos no interactivos ────────────────────────────────────────────────

def cmd_init(args: argparse.Namespace) -> int:
    cfg = load_config()
    if args.base_url:
        cfg["base_url"] = args.base_url.rstrip("/")
    if args.api_key:
        cfg["api_key"] = args.api_key.strip()
    if args.model:
        cfg["model"] = args.model.strip()
    if args.max_context_messages is not None:
        cfg["max_context_messages"] = max(2, int(args.max_context_messages))
    if args.context_window is not None:
        cfg["context_window"] = max(1024, int(args.context_window))
    if args.mode:
        cfg["mode"] = args.mode
    if args.workspace:
        cfg["workspace"] = str(Path(args.workspace).resolve())
    save_config(cfg)
    print(f"Configuración guardada en: {CONFIG_FILE}")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    cfg = load_config()
    print(f"lixbon CLI v{CLI_VERSION}")
    print(f"- Config:              {CONFIG_FILE}")
    print(f"- Base URL:            {cfg.get('base_url') or DEFAULT_BASE_URL}")
    print(f"- API key:             {mask_key(cfg.get('api_key', ''))}")
    print(f"- Cuenta:              {cfg.get('account_email') or '-'}")
    print(f"- Modelo por defecto:  {cfg.get('model') or 'no configurado'}")
    print(f"- Modo:                {cfg.get('mode', 'ask')}")
    print(f"- Ventana de contexto: {cfg.get('context_window', 8192)} tokens")
    print(f"- Workspace:           {cfg.get('workspace') or Path.cwd()}")
    return 0


def cmd_models(args: argparse.Namespace) -> int:
    cfg = load_config()
    if not cfg.get("api_key"):
        print("Primero inicia sesión: lixbon (o lixbon setup)")
        return 1
    api = ApiClient(cfg["base_url"], cfg["api_key"])
    try:
        models = api.models()
    except ApiError as exc:
        print(f"No se pudieron listar los modelos: {exc}")
        return 1
    if not models:
        print("No hay modelos disponibles.")
        return 0
    print("Modelos disponibles:")
    for model in models:
        print(f"- {model}")
    return 0


def cmd_usage(args: argparse.Namespace) -> int:
    cfg = load_config()
    api = ApiClient(cfg["base_url"], cfg.get("api_key", ""))
    try:
        data = api.usage()
    except ApiError as exc:
        print(f"No se pudo obtener el uso. Verifica tu sesión. Error: {exc}")
        return 1
    print(
        f"Uso global: conversaciones={data.get('conversations', 0)} "
        f"mensajes={data.get('messages', 0)} tokens={data.get('total_tokens', 0)}"
    )
    return 0


def cmd_update(args: argparse.Namespace | None) -> int:
    """Descarga la última versión del archivo único y se re-ejecuta."""
    target_path = Path(sys.argv[0]).resolve() if sys.argv else None
    module_path = Path(__file__).resolve()
    if module_path.name != "client_cli.py":
        # Ejecutando desde el paquete fuente (dev): el update sobreescribiría
        # un módulo del repo. El artefacto se regenera con apps/cli/build.py.
        if not target_path or target_path.name != "client_cli.py":
            print("Estás ejecutando el CLI desde el código fuente.")
            print("Regenera el artefacto con: python apps/cli/build.py")
            return 1
    real_target = module_path if module_path.name == "client_cli.py" else target_path

    cfg = load_config()
    base = server_base(cfg.get("base_url") or DEFAULT_BASE_URL)
    # El update descarga CÓDIGO que luego se ejecuta: nunca por http plano
    # (un MitM podría inyectar lo que quisiera). localhost queda exento (dev).
    if base.startswith("http://") and "//localhost" not in base and "//127.0.0.1" not in base:
        print("Por seguridad el update requiere HTTPS (tu base_url es http://).")
        return 1
    url = f"{base}/install/client_cli.py?ts={int(time.time() * 1000)}"
    print(f"Actualizando CLI desde: {url}")
    try:
        req = request.Request(
            url=url,
            headers={"Cache-Control": "no-cache", "Pragma": "no-cache"},
            method="GET",
        )
        with request.urlopen(req, timeout=120) as resp:
            content = resp.read().decode("utf-8")
        # Sanity check antes de sobreescribirnos: que sea Python válido y
        # parezca el CLI (si el servidor devuelve un HTML de error o un
        # archivo truncado, no nos autodestruimos).
        try:
            compile(content, "client_cli.py", "exec")
        except SyntaxError:
            print("La descarga no es un CLI válido (¿error del servidor?). No se actualizó nada.")
            return 1
        if "lixbon" not in content:
            print("La descarga no parece el CLI de lixbon. No se actualizó nada.")
            return 1
        old_content = real_target.read_text(encoding="utf-8") if real_target.exists() else ""
        old_hash = hashlib.sha256(old_content.encode("utf-8")).hexdigest() if old_content else ""
        new_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
        if old_hash == new_hash:
            print("El CLI ya está actualizado (sin cambios remotos).")
            return 0
        real_target.write_text(content, encoding="utf-8")
        print("CLI actualizado correctamente. Recargando…")
        sys.stdout.flush()  # os.execv descarta lo que quede en el buffer
        os.execv(sys.executable, [sys.executable, str(real_target), *sys.argv[1:]])
    except Exception as exc:
        print(f"No se pudo actualizar el CLI: {exc}")
        return 1
    return 0


# ── comandos interactivos ───────────────────────────────────────────────────

def cmd_chat(args: argparse.Namespace) -> int:
    if not ensure_deps():
        return 1

    app = ChatApp(
        model_override=getattr(args, "model", "") or "",
        client_id=getattr(args, "client_id", "") or "",
        title=getattr(args, "title", "") or "",
    )
    try:
        return app.run(once=getattr(args, "once", "") or "")
    except (KeyboardInterrupt, EOFError):
        print("")
        return 0


def cmd_setup(args: argparse.Namespace) -> int:
    """Rehace el login (alias del onboarding interactivo)."""
    if not ensure_deps():
        return 1

    app = ChatApp()
    render_header(make_console(), CLI_VERSION)
    ok = app.onboarding_flow()
    if ok and not app.model:
        app.pick_model()
    return 0 if ok else 1


def cmd_ui_demo(args: argparse.Namespace) -> int:
    if not ensure_deps():
        return 1

    setup_terminal()
    return ui_demo()


# ── parser ──────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lixbon",
        description="Lixbon CLI — asistente de código en tu terminal",
    )
    sub = parser.add_subparsers(dest="command")

    p_init = sub.add_parser("init", help="Guardar base_url, api_key y modelo")
    p_init.add_argument("--base-url")
    p_init.add_argument("--api-key")
    p_init.add_argument("--model")
    p_init.add_argument("--max-context-messages", type=int)
    p_init.add_argument("--context-window", type=int)
    p_init.add_argument("--mode", choices=["ask", "agent", "delegate"])
    p_init.add_argument("--workspace")
    p_init.set_defaults(func=cmd_init)

    sub.add_parser("setup", help="Iniciar sesión (interactivo)").set_defaults(func=cmd_setup)
    sub.add_parser("status", help="Ver configuración local").set_defaults(func=cmd_status)
    sub.add_parser("models", help="Listar modelos disponibles").set_defaults(func=cmd_models)
    sub.add_parser("usage", help="Ver uso global").set_defaults(func=cmd_usage)
    sub.add_parser("update", help="Actualizar CLI desde el servidor").set_defaults(func=cmd_update)
    sub.add_parser("ui-demo", help=argparse.SUPPRESS).set_defaults(func=cmd_ui_demo)

    for name in ("chat", "run", "start"):
        p = sub.add_parser(name, help="Abrir el chat interactivo" if name == "chat" else argparse.SUPPRESS)
        p.add_argument("--model", help="Sobrescribe el modelo por defecto")
        p.add_argument("--client-id", default=os.getenv("HOSTNAME", "cli-client"))
        p.add_argument("--title", default="Sesión CLI")
        p.add_argument("--once", default="", help="Enviar un único mensaje y salir (modo no interactivo)")
        p.set_defaults(func=cmd_chat)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if not args.command:
        args = parser.parse_args(["chat"])
    return int(args.func(args) or 0)


if __name__ == "__main__":
    sys.exit(main())
