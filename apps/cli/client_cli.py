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
        "✦●▓░❯╭█─".encode(_ORIG_ENCODING)
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
    # Ícono de marca: 2×2 celdas de bloque lleno, un color por faceta
    "block": "█",
    "rule": "─",
    "gear": "⚙",
    "corner": "└",
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
    "block": "#",
    "rule": "-",
    "gear": "*",
    "corner": "`",
}


def g(name: str) -> str:
    """Glifo unicode con fallback ASCII para consolas legacy."""
    table = _GLYPHS_UNICODE if UNICODE_OK else _GLYPHS_ASCII
    return table.get(name, "?")


def set_title(text: str) -> None:
    """Renombra la pestaña/ventana de la terminal (OSC 2).

    Windows Terminal, conhost con VT y mintty lo respetan; en el resto el
    escape se ignora silenciosamente. El ÍCONO de la pestaña no es cambiable
    desde el proceso: lo define el perfil de la terminal.
    """
    if not is_interactive():
        return  # en un pipe/redirección el escape ensuciaría la salida
    try:
        sys.stdout.write(f"\033]0;{text}\007")
        sys.stdout.flush()
    except Exception:
        pass


def clear_screen() -> None:
    """Deja la terminal en blanco antes de dibujar la interfaz del CLI.

    `2J` borra lo visible y `3J` el scrollback: sin esta última el usuario
    puede subir con la rueda y volver a ver el banner de cmd/PowerShell y la
    línea que lanzó el programa, y la sesión sigue pareciendo una consola del
    sistema con texto encima. En terminales que no soporten 3J el escape se
    ignora y solo se limpia lo visible.
    """
    if not is_interactive():
        return  # en un pipe/redirección el escape ensuciaría la salida
    try:
        sys.stdout.write("\033[H\033[2J\033[3J")
        sys.stdout.flush()
    except Exception:
        pass


# ── Fila reservada para la barra de estado ─────────────────────────────────
# La última fila se saca de la región de scroll (DECSTBM): el transcript
# desplaza solo las filas 1..h-1 y la barra se queda clavada abajo, sin
# desaparecer al enviar ni viajar pegada a lo que escribe el agente.
#
# CONTRAPARTIDA: con una región de scroll parcial, las líneas que salen por
# arriba NO van al scrollback de la terminal (es el mismo motivo por el que
# tmux implementa el suyo propio). Si molesta, `fixed_status_bar: false` en
# ~/.lixbon/config.json devuelve la barra al pie de prompt_toolkit.

_status_rows = 0  # filas con las que se calculó la región activa (0 = inactiva)


def term_size() -> tuple[int, int]:
    import shutil

    size = shutil.get_terminal_size((100, 24))
    return size.columns, size.lines


def _write(seq: str) -> None:
    try:
        sys.stdout.write(seq)
        sys.stdout.flush()
    except Exception:
        pass


def reserve_status_line() -> bool:
    """Saca la última fila de la región de scroll. Solo tras limpiar la
    pantalla: DECSTBM manda el cursor a home y arrastraría lo ya escrito."""
    global _status_rows
    if not is_interactive():
        return False
    _, rows = term_size()
    if rows < 6:  # terminal diminuta: no merece la pena robarle una fila
        return False
    _status_rows = rows
    _write(f"\033[1;{rows - 1}r\033[H")
    # Si el proceso muere por una excepción sin pasar por el finally, la región
    # quedaría puesta y la terminal seguiría confinando su salida a h-1 filas.
    import atexit

    atexit.register(release_status_line)
    return True


def status_line_active() -> bool:
    return _status_rows > 0


def release_status_line() -> None:
    """Devuelve la región de scroll a la pantalla completa y borra la barra."""
    global _status_rows
    if not _status_rows:
        return
    rows = _status_rows
    _status_rows = 0
    # DECSTBM vuelve a mover el cursor a home, así que se guarda y restaura.
    _write(f"\0337\033[{rows};1H\033[2K\0338\0337\033[r\0338")


def draw_status_line(ansi: str) -> None:
    """Pinta la barra en la fila reservada sin mover el cursor del transcript.
    Si la terminal cambió de alto, rehace la región antes de pintar."""
    global _status_rows
    if not _status_rows:
        return
    _, rows = term_size()
    if rows != _status_rows and rows >= 6:
        _status_rows = rows
        _write(f"\0337\033[1;{rows - 1}r\0338")
    _write(f"\0337\033[{_status_rows};1H\033[2K{ansi}\033[0m\0338")


# ── Repintado de la barra ──────────────────────────────────────────────────
# prompt_toolkit dibuja con `erase_down()` (ESC[J) en su primer render y al
# cerrarse: eso BORRA todo lo que hay del cursor hacia abajo, incluida la fila
# reservada. Como el prompt es el estado normal del CLI, la barra desaparecía
# nada más pintarla. La solución es repintarla después de cada render de
# prompt_toolkit (evento `after_render`), no solo cuando cambian los datos.

_status_painter = None  # callable que sabe redibujar la barra (lo pone ChatApp)


def set_status_painter(painter) -> None:
    global _status_painter
    _status_painter = painter


def repaint_status() -> None:
    """Redibuja la barra si hay fila reservada y alguien sabe pintarla."""
    if _status_rows and _status_painter is not None:
        try:
            _status_painter()
        except Exception:
            pass  # la barra nunca puede tumbar la sesión


def attach_status_repaint(app) -> None:
    """Engancha el repintado a los renders de una Application de prompt_toolkit."""
    if not _status_rows:
        return
    try:
        app.after_render += lambda _: repaint_status()
    except Exception:
        pass


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
    "olive_lt": "#8C9A3C",  # oliva legible sobre fondo oscuro (nombre del CLI)
    # Las 4 facetas del ícono (colores exactos del favicon), en el mismo orden
    # que los cuadrantes: claro/beige arriba, oliva/oliva oscuro abajo.
    "facet_top": "#DCD6BC",
    "facet_top2": "#C7BE9F",
    "facet_bottom": "#4B5327",
    "facet_bottom2": "#333A1C",
    "dim": "#8A8A80",     # secundario: metadatos, hints, barra de estado
    "dim2": "#5C5C55",    # terciario: thinking, placeholders, colapsados, versión
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
    "lx.brand": f"bold {PALETTE['olive_lt']}",       # "Lixbon CLI" en la cabecera
    "lx.facet.top": PALETTE["facet_top"],            # ícono: cuadrantes
    "lx.facet.top2": PALETTE["facet_top2"],
    "lx.facet.bottom": PALETTE["facet_bottom"],
    "lx.facet.bottom2": PALETTE["facet_bottom2"],
    "lx.rule": PALETTE["dim2"],
    "lx.dim": PALETTE["dim"],
    "lx.dim2": PALETTE["dim2"],
    "lx.thinking": f"italic {PALETTE['dim2']}",
    "lx.ok": PALETTE["ok"],
    "lx.err": PALETTE["err"],
    "lx.warn": PALETTE["warn"],
    "lx.diff.add": PALETTE["ok"],
    "lx.diff.del": PALETTE["err"],
    "lx.diff.hunk": PALETTE["dim"],
    # Fondo de la barra de estado fija. Va como estilo BASE del Text: los
    # spans de cada trozo solo fijan color de texto, así que el fondo
    # sobrevive por debajo y llega hasta el relleno del borde derecho.
    "lx.bar": "on #1E1E1A",  # rich usa `on <color>`; el `bg:` es de prompt_toolkit
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

        from rich.console import Console, ConsoleDimensions, NewLine
        from rich.control import Control
        from rich.padding import Padding
        from rich.theme import Theme


        class LixbonConsole(Console):
            """Console con margen izquierdo automático y alto sin la fila fija."""

            @property
            def size(self):
                # La fila de la barra de estado vive FUERA de la región de
                # scroll (DECSTBM, ver term.py). Si rich la cuenta como
                # disponible, cualquier render de pantalla completa (el Live
                # del streaming) se pasa una línea: la terminal scrollea dentro
                # de la región y el `cursor-up + erase` con el que Live se
                # repinta ya no cuadra → cada refresh deja una línea muerta
                # arriba y la respuesta acaba pegada al fondo.
                size = Console.size.fget(self)
                if status_line_active():
                    return ConsoleDimensions(size.width, max(size.height - 1, 5))
                return size

            @size.setter
            def size(self, new_size):
                Console.size.fset(self, new_size)

            def print(self, *objects, **kwargs):
                if objects and not kwargs.pop("no_pad", False):
                    # Los Control (mover cursor, borrar línea) son la fontanería
                    # con la que Live/Status repintan y BORRAN su línea. Si se
                    # envuelven en Padding, rich los maqueta como un bloque del
                    # ancho de la consola: la línea del spinner se rellenaba de
                    # espacios, hacía wrap y el `cursor-up + erase` final ya no
                    # la alcanzaba → cada spinner dejaba su rastro en pantalla.
                    objects = tuple(
                        obj
                        if obj == "" or isinstance(obj, (Control, NewLine))
                        else Padding(obj, (0, PAD_RIGHT, 0, PAD_LEFT))
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


_ansi_console = None
_ansi_width = 0


def render_ansi(renderable, width: int) -> str:
    """Renderiza con el tema Lixbon a una cadena con escapes ANSI, en UNA línea.

    Sirve para pintar fuera del flujo normal (la fila reservada de la barra de
    estado), donde no vale `console.print` porque movería el cursor. Se recorta
    a `width - 1`: llenar la última columna dispara el autowrap de la terminal
    y la barra se derramaría sobre la línea siguiente.
    """
    global _ansi_console, _ansi_width
    inner = max(width - 1, 10)
    if _ansi_console is None or _ansi_width != inner:
        import io

        from rich.console import Console
        from rich.theme import Theme

        _ansi_width = inner
        # Escribe a un StringIO, así que rich no puede sondear la terminal y
        # degradaría a 16 colores: hereda la profundidad ya detectada por la
        # consola real para que la barra tenga los mismos tonos que el resto.
        _ansi_console = Console(
            file=io.StringIO(),
            theme=Theme(RICH_STYLES),
            width=inner,
            force_terminal=True,
            highlight=False,
            color_system=make_console().color_system or None,
        )
    buf = _ansi_console.file
    buf.seek(0)
    buf.truncate(0)
    _ansi_console.print(renderable, end="", no_wrap=True, overflow="ellipsis", crop=True)
    return buf.getvalue().split("\n")[0]


def pt_style():
    """Style de prompt_toolkit para prompts, selectores y barra de estado."""
    from prompt_toolkit.styles import Style

    return Style.from_dict({
        # Prompt de entrada
        "prompt": f"bold {PALETTE['accent']}",
        # Selector interactivo
        "sel.mark": PALETTE["accent"],
        "sel.title": f"bold {PALETTE['cream']}",
        "sel.hint": PALETTE["dim2"],
        "sel.count": PALETTE["dim2"],
        "sel.query": f"bold {PALETTE['accent']}",
        "sel.scroll": PALETTE["dim2"],
        "sel.disabled": f"italic {PALETTE['dim2']}",
        "sel.pointer": f"bold {PALETTE['accent']}",
        "sel.active": f"bold {PALETTE['accent']}",
        "sel.active.desc": PALETTE["dim"],
        "sel.option": PALETTE["cream"],
        "sel.option.desc": PALETTE["dim2"],
        "sel.badge": PALETTE["beige"],
        "sel.badge.active": f"bold {PALETTE['beige']}",
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
        "completion-menu.meta.completion.current": f"bg:#2A2A24 {PALETTE['beige']}",
        # Columnas del display de cada comando. Reglas de 2 nombres: la fila
        # marcada (`completion-menu.completion.current`, 3 nombres) gana en
        # especificidad y se pinta entera en tinta sobre oliva.
        "cmd.name": PALETTE["cream"],
        "cmd.args": PALETTE["dim2"],
        # Barra de scroll del menú, para que se note que la lista sigue.
        "scrollbar.background": "bg:#1E1E1A",
        "scrollbar.button": f"bg:{PALETTE['dim2']}",
    })

# ──────────────────────────────────────────────────────────────────────────
# módulo: lixbon_cli/config.py
# ──────────────────────────────────────────────────────────────────────────
"""Configuración local del CLI (~/.lixbon/config.json)."""
import json
from pathlib import Path

CLI_VERSION = "2.1.1"

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
  ("tool_calls", list)  — tool-calling nativo (modo agent); Ollama los manda
                          completos en un chunk, no incrementales como OpenAI
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
            calls = delta.get("tool_calls")
            if calls:
                yield ("tool_calls", calls)
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

    # ── control remoto (/remote) ─────────────────────────────────────────

    def remote_create(self, source: str, title: str, machine: str) -> dict:
        return self._json("POST", f"{self.server}/api/remote/sessions",
                          {"source": source, "title": title, "machine": machine}, timeout=20)

    def remote_events(self, session_id: str, events: list[dict]) -> dict:
        return self._json("POST", f"{self.server}/api/remote/sessions/{session_id}/events",
                          {"events": events}, timeout=20)

    def remote_end(self, session_id: str) -> dict:
        return self._json("DELETE", f"{self.server}/api/remote/sessions/{session_id}", timeout=20)

    def remote_commands_stream(self, session_id: str):
        """SSE de larga duración con los comandos del móvil/web. El timeout es
        de inactividad del socket; el gateway manda keepalives cada 15 s."""
        return self._open("GET", f"{self.server}/api/remote/sessions/{session_id}/commands",
                          timeout=90)

    def remote_qr_txt(self, data: str) -> str:
        from urllib.parse import quote

        with self._open("GET", f"{self.server}/api/remote/qr?fmt=txt&data={quote(data, safe='')}",
                        timeout=20) as resp:
            return resp.read().decode("utf-8", errors="replace")

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
                    web_search: bool = False, num_ctx: int | None = None,
                    tools: list[dict] | None = None) -> ChatStream:
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
        if tools:
            # Tool-calling nativo: el gateway se las pasa a Ollama, que las mete
            # en el template del modelo (modo agent).
            payload["tools"] = tools
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


class Tail:
    """Renderable que muestra solo las últimas `max_height` líneas de otro.

    Al recortar el propio contenido, el render de un Live nunca excede el alto
    de la pantalla: su borrado (`cursor-up × alto`) siempre cuadra y no queda
    residuo. Rich por su cuenta también recorta, pero se queda con el PRINCIPIO
    del bloque, y mientras el modelo escribe lo que interesa leer es el final.
    """

    def __init__(self, renderable, max_height: int) -> None:
        self.renderable = renderable
        self.max_height = max(1, int(max_height))

    def __rich_console__(self, console, options):
        from rich.segment import Segment

        lines = console.render_lines(self.renderable, options, pad=False)
        del lines[: max(0, len(lines) - self.max_height)]
        new_line = Segment.line()
        for index, line in enumerate(lines):
            if index:
                yield new_line  # el salto va ANTES: sin newline final el
            yield from line     # alto medido es exactamente len(lines)


# ── Cabecera de identidad ───────────────────────────────────────────────────

# El ícono se dibuja con bloques llenos (█) de 2×2 celdas, un color por
# cuadrante — los mismos del favicon. Los triángulos ◢◣ se veían rotos y
# desalineados en Cascadia Mono; █ (U+2588) se renderiza igual en toda fuente
# monoespaciada, así que el logo es fiable en cualquier terminal.
LOGO_WIDTH = 2
LOGO_GAP = 2  # separación entre el ícono y el texto


def _logo_rows() -> tuple[list, list]:
    """Filas superior e inferior del ícono como fragmentos de rich.Text."""
    if not UNICODE_OK:
        return ([("[]", "lx.facet.top")], [("[]", "lx.facet.bottom")])
    block = g("block")
    return (
        [(block, "lx.facet.top"), (block, "lx.facet.top2")],
        [(block, "lx.facet.bottom"), (block, "lx.facet.bottom2")],
    )


def short_path(path, max_len: int = 60) -> str:
    """Ruta legible: ~ para el home y elisión por el medio si es muy larga."""
    from pathlib import Path

    text = str(path)
    try:
        home = str(Path.home())
        if text.startswith(home):
            text = "~" + text[len(home):]
    except Exception:
        pass
    if len(text) <= max_len:
        return text
    keep = (max_len - 3) // 2
    return f"{text[:keep]}{g('ellipsis')}{text[-keep:]}"


def render_header(console, version: str, model: str = "", plan: str = "",
                  workspace: object = None) -> None:
    """Bloque de identidad, arriba a la izquierda y sin cajas.

        ██  Lixbon CLI v2.1.0
        ██  qwen2.5-coder:7b · Lixbon Pro
            ~/proyectos/api

    Se imprime una vez al arrancar (y tras /clear): sube con el transcript en
    lugar de robar espacio permanente. Los datos vivos (contexto, tokens,
    modo) viven en la barra inferior, que sí es fija.
    """
    from rich.text import Text

    top_row, bottom_row = _logo_rows()
    gap = " " * LOGO_GAP
    indent = " " * (LOGO_WIDTH + LOGO_GAP)

    # Text.assemble en vez de markup: el logo ASCII de respaldo contiene `[`,
    # que rich interpretaría como apertura de etiqueta.
    console.print()
    console.print(Text.assemble(
        *top_row, gap, ("Lixbon CLI", "lx.brand"), " ", (f"v{version}", "lx.dim2"),
    ))
    line2 = [*bottom_row, gap, (model or "sin modelo", "lx.beige")]
    if plan:
        line2 += [(f" {g('sep')} ", "lx.dim2"), (f"Lixbon {plan}", "lx.dim")]
    console.print(Text.assemble(*line2))
    if workspace is not None:
        console.print(Text(f"{indent}{short_path(workspace)}", style="lx.dim"))
    console.print()


def render_intro_line(console, version: str, note: str = "") -> None:
    """Preámbulo de una línea para las fases previas al chat (login, elegir
    modelo). El bloque de identidad completo se imprime después, cuando ya hay
    modelo y plan que mostrar: así no se repite dos veces en el arranque."""
    from rich.text import Text

    top_row, _ = _logo_rows()
    parts = [
        *top_row, " " * LOGO_GAP,
        ("Lixbon CLI", "lx.brand"), " ", (f"v{version}", "lx.dim2"),
    ]
    if note:
        parts += [(f" {g('sep')} ", "lx.dim2"), (note, "lx.dim")]
    console.print()
    console.print(Text.assemble(*parts))
    console.print()


def render_tips(console) -> None:
    """Consejos de arranque: texto suelto, sin panel (el panel era una caja
    más que competía visualmente con el chat)."""
    console.print(
        f"[lx.dim]Pide un cambio en lenguaje natural  [lx.dim2]{g('sep')}[/]  "
        f"[lx.accent2]/[/] para los comandos  [lx.dim2]{g('sep')}[/]  "
        f"[lx.accent2]@ruta[/] para adjuntar una imagen  [lx.dim2]{g('sep')}[/]  "
        f"Ctrl+C dos veces para salir[/]"
    )
    console.print(
        f"[lx.dim2]/help abre el menú de comandos  {g('sep')}  /config los ajustes  "
        f"{g('sep')}  /doctor revisa terminal y conexión[/]"
    )


def rule(console, label: str = "") -> None:
    """Separador horizontal con etiqueta opcional: divide zonas del CLI
    (arranque │ conversación) sin encerrar nada en un recuadro."""

    dash = g("rule")
    width = max(20, console.width - PAD_LEFT - PAD_RIGHT)
    console.print()
    if label:
        rest = max(0, width - 5 - len(label))
        console.print(f"[lx.rule]{dash * 3}[/] [lx.dim]{esc(label)}[/] [lx.rule]{dash * rest}[/]")
    else:
        console.print(f"[lx.rule]{dash * width}[/]")
    console.print()


def render_speaker(console, who: str) -> None:
    """Etiqueta de turno: marca de quién es el bloque que viene debajo."""
    if who == "user":
        console.print(f"[lx.accent2]{g('prompt')}[/] [lx.dim]tú[/]")
    else:
        console.print(f"[lx.accent2]{g('spark')}[/] [lx.brand]Lixbon[/]")


# ── Acciones del agente ─────────────────────────────────────────────────────

# Mismos verbos que el panel de acciones del IDE (apps/desktop ToolGroup.jsx):
# el agente "hace cosas" y se lee igual en las dos superficies.
TOOL_VERB = {
    "read_file": "leyó", "write_file": "escribió", "edit_file": "editó",
    "append_file": "añadió a", "delete_file": "eliminó", "rename_file": "movió",
    "mkdir": "creó carpeta", "search": "buscó", "list_files": "listó",
    "run_command": "ejecutó",
}
KIND_VERB = {
    "create": "creó", "update": "editó", "delete": "eliminó", "rename": "movió",
    "mkdir": "creó carpeta", "append": "añadió a", "command": "ejecutó",
}
VERB_WIDTH = 12  # columna fija: los objetivos quedan alineados entre acciones


def render_actions_header(console) -> None:
    """Abre la zona de acciones de un turno para que no se confunda con la
    respuesta en prosa que viene después."""
    console.print(f"[lx.dim2]{g('gear')} acciones[/]")


def render_action(console, verb: str, target: str = "", adds: int = 0, dels: int = 0,
                  readonly: bool = False) -> None:
    """Una acción del agente: `● editó   src/app.py  +12 -3`.

    Las de solo lectura van apagadas (rastro, no evento) y las que tocan el
    disco en acento: al hojear el transcript se ve qué cambió de verdad.
    """
    dot = g("dot")
    padded = f"{verb:<{VERB_WIDTH}}"
    if readonly:
        line = f"[lx.dim2]{dot}[/] [lx.dim]{padded}[/][lx.dim2]{esc(target)}[/]"
    else:
        line = f"[lx.accent2]{dot}[/] [bold lx.primary]{padded}[/][lx.beige]{esc(target)}[/]"
    if adds or dels:
        line += f"  [lx.diff.add]+{adds}[/] [lx.diff.del]-{dels}[/]"
    console.print(line)


def render_action_result(console, text: str, error: bool = False) -> None:
    """Resultado de una acción, colgando de ella."""
    style = "lx.err" if error else "lx.dim2"
    console.print(f"  [lx.dim2]{g('corner')}[/] [{style}]{esc(text)}[/]")


# ── Selector interactivo (flechas + mouse) ──────────────────────────────────

@dataclass
class Option:
    label: str
    value: object = None
    description: str = ""
    badge: str = ""       # etiqueta corta a la derecha: "actual", "recomendado"…
    disabled: bool = False  # se muestra pero no se puede elegir

    def __post_init__(self):
        if self.value is None:
            self.value = self.label


# Con más opciones que esto el selector se vuelve buscable: escribir filtra en
# vez de navegar. Por debajo (modo, sí/no) las teclas j/k siguen moviendo, que
# es lo que espera quien viene de vim y no molesta en menús de 2-3 líneas.
SEARCH_THRESHOLD = 6
MAX_VISIBLE = 10  # filas de opciones antes de paginar


def select(title: str, options: list, default: int = 0, hint: str = "",
           searchable: bool | None = None, max_visible: int = MAX_VISIBLE):
    """Selector inline de la marca. Devuelve Option.value o None (Esc).

    Navegación: ↑/↓ (Ctrl+P/Ctrl+N), PgUp/PgDn, Inicio/Fin. Enter confirma,
    Esc/Ctrl+C cancela. Mouse: hover mueve la selección, clic confirma y la
    rueda desplaza. En listas largas escribir filtra (Backspace borra).
    En terminales sin soporte (Git Bash/mintty) degrada a texto plano.
    """

    options = [o if isinstance(o, Option) else Option(str(o)) for o in options]
    if not options:
        return None
    if not ui_capable():
        return _select_plain(title, options, default)
    try:
        return _select_app(title, options, default, hint, searchable, max_visible)
    except Exception:
        # La terminal mintió sobre sus capacidades: degradar en caliente
        return _select_plain(title, options, default)


def _select_app(title: str, options: list, default: int, hint: str,
                searchable: bool | None, max_visible: int):
    from prompt_toolkit.application import Application
    from prompt_toolkit.key_binding import KeyBindings
    from prompt_toolkit.keys import Keys
    from prompt_toolkit.layout import HSplit, Layout, Window
    from prompt_toolkit.layout.controls import FormattedTextControl
    from prompt_toolkit.mouse_events import MouseEventType

    total = len(options)
    if searchable is None:
        searchable = total > SEARCH_THRESHOLD
    if not hint:
        hint = ("escribe para filtrar  ↑↓ mover  ↵ elegir  esc salir"
                if searchable else "↑↓ mover  ↵ elegir  esc salir")

    pointer = g("prompt")
    state = {
        "matches": list(range(total)),
        "cursor": max(0, min(default, total - 1)),
        "top": 0,
        "query": "",
        "accepted": False,
    }
    _has_disabled = any(o.disabled for o in options)

    def _clamp() -> None:
        count = len(state["matches"])
        if not count:
            state["cursor"] = state["top"] = 0
            return
        state["cursor"] = max(0, min(state["cursor"], count - 1))
        window = min(max_visible, count)
        if state["cursor"] < state["top"]:
            state["top"] = state["cursor"]
        elif state["cursor"] >= state["top"] + window:
            state["top"] = state["cursor"] - window + 1
        state["top"] = max(0, min(state["top"], count - window))

    def _skip_disabled() -> None:
        """El cursor nunca debe nacer sobre una cabecera de grupo."""
        for _ in range(total):
            if not options[state["matches"][state["cursor"]]].disabled:
                return
            state["cursor"] = (state["cursor"] + 1) % max(1, len(state["matches"]))

    def _refilter() -> None:
        query = state["query"].strip().lower()
        if not query:
            state["matches"] = list(range(total))
        else:
            state["matches"] = [
                i for i, opt in enumerate(options)
                if query in opt.label.lower() or query in (opt.description or "").lower()
            ]
            state["cursor"] = 0
        if state["matches"]:
            _skip_disabled()
        _clamp()

    def _move(delta: int) -> None:
        """Mueve el cursor saltando las filas deshabilitadas (cabeceras de grupo)."""
        count = len(state["matches"])
        if not count:
            return
        step = 1 if delta >= 0 else -1
        position = (state["cursor"] + delta) % count
        for _ in range(count):
            if not options[state["matches"][position]].disabled:
                break
            position = (position + step) % count
        state["cursor"] = position
        _clamp()

    def _accept_now(app_ref) -> None:
        if not state["matches"]:
            return
        if options[state["matches"][state["cursor"]]].disabled:
            return
        state["accepted"] = True
        app_ref.exit()

    def _mouse_handler_for(row_index: int):
        def handler(mouse_event):
            disabled = options[state["matches"][row_index]].disabled
            if mouse_event.event_type == MouseEventType.MOUSE_MOVE:
                if not disabled:
                    state["cursor"] = row_index
                    _clamp()
            elif mouse_event.event_type == MouseEventType.MOUSE_UP:
                if not disabled:
                    state["cursor"] = row_index
                    _accept_now(app)
            elif mouse_event.event_type == MouseEventType.SCROLL_DOWN:
                _move(1)
            elif mouse_event.event_type == MouseEventType.SCROLL_UP:
                _move(-1)
            else:
                return NotImplemented
        return handler

    def fragments():
        count = len(state["matches"])
        window = min(max_visible, count)
        out: list = [("", "  "), ("class:sel.mark", f"{g('spark')} "),
                     ("class:sel.title", title)]
        if state["query"]:
            out += [("class:sel.hint", "  /"), ("class:sel.query", state["query"])]
        if searchable:
            out.append(("class:sel.count", f"   {count}/{total}"))
        out.append(("", "\n"))

        if state["top"] > 0:
            out += [("", "    "), ("class:sel.scroll", f"{g('ellipsis')} {state['top']} arriba\n")]

        for row in range(window):
            position = state["top"] + row
            index = state["matches"][position]
            opt = options[index]
            handler = _mouse_handler_for(position)
            active = position == state["cursor"]
            out.append(("", "  "))
            if opt.disabled:
                out += [("", "  ", handler), ("class:sel.disabled", opt.label, handler)]
                if opt.description:
                    out.append(("class:sel.disabled", f"  {g('sep')} {opt.description}", handler))
            elif active:
                out += [("class:sel.pointer", f"{pointer} ", handler),
                        ("class:sel.active", opt.label, handler)]
                if opt.description:
                    out.append(("class:sel.active.desc", f"  {g('sep')} {opt.description}", handler))
            else:
                out += [("", "  ", handler), ("class:sel.option", opt.label, handler)]
                if opt.description:
                    out.append(("class:sel.option.desc", f"  {g('sep')} {opt.description}", handler))
            if opt.badge:
                style = "class:sel.badge.active" if active and not opt.disabled else "class:sel.badge"
                out.append((style, f"  {opt.badge}", handler))
            out.append(("", "\n"))

        rest = count - state["top"] - window
        if rest > 0:
            out += [("", "    "), ("class:sel.scroll", f"{g('ellipsis')} {rest} abajo\n")]
        if not count:
            out += [("", "    "), ("class:sel.disabled", "sin coincidencias\n")]

        out += [("", "  "), ("class:sel.hint", hint), ("", "\n")]
        return out

    kb = KeyBindings()

    @kb.add("up")
    @kb.add("c-p")
    def _up(event):
        _move(-1)

    @kb.add("down")
    @kb.add("c-n")
    def _down(event):
        _move(1)

    @kb.add("pageup")
    def _pageup(event):
        _move(-max_visible)

    @kb.add("pagedown")
    def _pagedown(event):
        _move(max_visible)

    @kb.add("home")
    def _home(event):
        state["cursor"] = 0
        _clamp()

    @kb.add("end")
    def _end(event):
        state["cursor"] = max(0, len(state["matches"]) - 1)
        _clamp()

    @kb.add("enter")
    def _accept(event):
        _accept_now(event.app)

    @kb.add("escape", eager=True)
    @kb.add("c-c")
    def _cancel(event):
        state["accepted"] = False
        event.app.exit()

    if searchable:
        @kb.add("backspace")
        def _backspace(event):
            state["query"] = state["query"][:-1]
            _refilter()

        @kb.add("c-u")
        def _clear_query(event):
            state["query"] = ""
            _refilter()

        @kb.add(Keys.Any)
        def _type(event):
            data = event.data
            if data and data.isprintable():
                state["query"] += data
                _refilter()
    else:
        @kb.add("k")
        def _vim_up(event):
            _move(-1)

        @kb.add("j")
        def _vim_down(event):
            _move(1)

    if _has_disabled:
        _skip_disabled()
    _clamp()

    control = FormattedTextControl(fragments, focusable=True, show_cursor=False)
    app = Application(
        layout=Layout(HSplit([Window(control, always_hide_cursor=True)])),
        key_bindings=kb,
        style=pt_style(),
        mouse_support=True,
        full_screen=False,
        erase_when_done=True,
    )
    attach_status_repaint(app)
    app.run()
    repaint_status()  # erase_when_done borra hasta el pie: la barra vuelve

    console = make_console()
    if state["accepted"] and state["matches"]:
        chosen = options[state["matches"][state["cursor"]]]
        console.print(
            f"[lx.dim]{g('spark')}[/] [lx.primary]{esc(title)}[/] "
            f"[lx.dim2]{g('sep')}[/] [lx.accent2]{esc(chosen.label)}[/]"
        )
        return chosen.value
    console.print(f"[lx.dim2]{g('spark')} {esc(title)} {g('sep')} cancelado[/]")
    return None


def _select_plain(title: str, options: list, default: int):
    """Fallback sin prompt_toolkit: elegir escribiendo (Git Bash, pipes)."""
    console = make_console()
    default = max(0, min(default, len(options) - 1))
    console.print(f"[lx.primary]? {esc(title)}[/] [lx.dim2](escribe parte del nombre o su número; Enter = opción marcada; 'x' cancela)[/]")
    for i, opt in enumerate(options):
        marker = f"[lx.accent2]{g('prompt')}[/]" if i == default else " "
        desc = f"  [lx.dim2]{g('sep')} {esc(opt.description)}[/]" if opt.description else ""
        console.print(f"{marker} [lx.dim2]{i + 1:>2}.[/] [lx.primary]{esc(opt.label)}[/]{desc}")
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
        if raw.isdigit() and 1 <= int(raw) <= len(options):
            chosen = options[int(raw) - 1]
            if chosen.disabled:
                console.print("[lx.warn]Esa opción no está disponible.[/]")
                continue
            console.print(f"[lx.dim]? {esc(title)} {g('sep')}[/] [lx.accent2]{esc(chosen.label)}[/]")
            return chosen.value
        matches = [o for o in options if raw.lower() in o.label.lower() and not o.disabled]
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
    web: bool = False       # búsqueda web activa (/web)
    project: bool = False   # hay LIXBON.md cargado en el workspace

    def _parts(self) -> list[tuple[str, str]]:
        sep = ("class:bottom-toolbar.sep", f"  {g('sep')}  ")
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
        ]
        # Solo se anuncian los modos ACTIVOS: una barra llena de "off" es ruido.
        flags = []
        if self.web:
            flags.append("web")
        if self.project:
            flags.append("LIXBON.md")
        if flags:
            parts += [sep, ("class:bottom-toolbar.model", " ".join(flags))]
        parts += [sep, ("class:bottom-toolbar", self.encoding + " ")]
        if self.extra:
            parts += [sep, ("class:bottom-toolbar.dot", self.extra)]
        return parts

    def _compact_parts(self) -> list[tuple[str, str]]:
        """Versión corta para el pie del stream: cabe en una línea y no repite
        lo que ya está en la cabecera (sesión, encoding)."""
        sep = ("class:bottom-toolbar.sep", f"  {g('sep')}  ")
        return [
            ("class:bottom-toolbar.dot", f"{g('dot')} "),
            ("class:bottom-toolbar.model", self.model or "sin modelo"),
            sep,
            ("class:bottom-toolbar", f"contexto {context_bar(self.ctx_pct, 8)} {self.ctx_pct:.0f}%"),
            sep,
            ("class:bottom-toolbar", f"{fmt_tokens(self.tokens)} tokens"),
        ]

    def pt_toolbar(self):
        """Fragmentos para bottom_toolbar de prompt_toolkit."""
        return self._parts()

    def rich_line(self, compact: bool = False, bar: bool = False, width: int = 0):
        """La misma barra como línea rich.

        `bar=True` la viste como barra de verdad (fondo propio de borde a
        borde) para la fila reservada al pie de la terminal; sin él es una
        línea más del transcript.
        """
        from rich.text import Text

        text = Text(style="lx.bar" if bar else "")
        for style_cls, chunk in (self._compact_parts() if compact else self._parts()):
            if style_cls == "class:bottom-toolbar.dot":
                text.append(chunk, style="lx.accent2")
            elif style_cls == "class:bottom-toolbar.model":
                text.append(chunk, style="lx.beige")
            elif style_cls == "class:bottom-toolbar.sep":
                text.append(chunk, style="lx.dim2")
            else:
                text.append(chunk, style="lx.dim")
        if width:
            # Relleno hasta el borde: sin él el fondo acabaría a media fila.
            text.pad_right(max(0, width - text.cell_len))
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
    from pathlib import Path

    render_header(console, "2.0.0-demo", model="qwen2.5-coder:7b", plan="Pro",
                  workspace=Path.cwd())
    render_tips(console)
    rule(console, "conversación")
    render_speaker(console, "assistant")
    render_actions_header(console)
    render_action(console, "leyó", "src/app.py", readonly=True)
    render_action(console, "editó", "src/app.py", adds=12, dels=3)
    render_action_result(console, "1 reemplazo aplicado")

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
        return KIND_VERB.get(self.kind, self.kind)


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
    """Imprime la acción (`● editó  ruta  +12 -3`) y el diff coloreado."""
    if change.kind == "command":
        render_action(console, change.verb, change.detail)
        return
    if change.kind == "rename":
        render_action(console, change.verb, f"{change.path} {g('arrow')} {change.detail}")
        return
    if change.kind == "mkdir":
        render_action(console, change.verb, change.path)
        return

    adds, dels = diff_counts(change)
    render_action(console, change.verb, change.path, adds=adds, dels=dels)

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
# módulo: lixbon_cli/remote.py
# ──────────────────────────────────────────────────────────────────────────
"""Host del control remoto (/remote): la sesión CLI se controla desde la app.

Transporte stdlib puro, igual que el resto del CLI:
- Bajada: SSE de larga duración con los comandos del móvil/web (hilo lector).
- Subida: POST de lotes de eventos del transcript (hilo flusher, ~4 Hz).
El gateway solo releva; este proceso sigue siendo quien ejecuta todo.
"""
import json
import queue
import threading
import time
import uuid


REMOTE_FLUSH_SECONDS = 0.25
REMOTE_RECONNECT_MAX_S = 30
REMOTE_RESULT_CHARS = 600  # tamaño máximo del resumen de un tool_result

# Comandos que el host acepta desde la app, publicados en el `hello` para que
# el móvil pueda ofrecerlos sin conocer de antemano quién está al otro lado
# (CLI e IDE no tienen por qué ofrecer los mismos). Solo entran los que se
# resuelven con un argumento: en remoto no hay teclado para un selector.
REMOTE_COMMANDS: list[tuple[str, str, str]] = [
    ("help", "", "Ver los comandos disponibles aquí"),
    ("new", "", "Empezar una conversación nueva"),
    ("model", "[nombre]", "Ver o cambiar el modelo"),
    ("mode", "[ask|agent|delegate]", "Ver o cambiar el modo de trabajo"),
    ("approve", "[on|off]", "Auto-aprobar herramientas del agente"),
    ("web", "[on|off]", "Búsqueda web durante las respuestas"),
    ("status", "", "Estado de la sesión y del host"),
    ("cost", "", "Tokens y contexto consumidos"),
    ("workspace", "", "Carpeta de trabajo del agente"),
]


def _args_summary(tool: str, args: dict) -> str:
    """Resumen compacto y legible de los argumentos de una herramienta."""
    if tool == "run_command":
        return str(args.get("command", ""))[:200]
    if tool == "rename_file":
        return f"{args.get('src', '?')} → {args.get('dst', '?')}"
    if tool == "search":
        return f"«{args.get('pattern', '')}» en {args.get('path', '.')}"
    if tool == "edit_file":
        old = str(args.get("old_text", ""))
        return f"{args.get('path', '?')} (reemplaza {len(old)} chars)"
    if tool in ("write_file", "append_file"):
        content = str(args.get("content", ""))
        return f"{args.get('path', '?')} ({len(content)} chars)"
    return str(args.get("path") or args.get("pattern") or args)[:200]


class RemoteLink:
    """Canal del host contra el gateway. Los hilos internos solo tocan la red;
    la ejecución de prompts/herramientas sigue en el hilo principal del CLI."""

    def __init__(self, api, source: str = "cli", title: str = "", machine: str = ""):
        self.api = api  # ApiClient
        self.source = source
        self.title = title
        self.machine = machine
        self.session_id = ""
        self.share_url = ""
        self.commands: queue.Queue = queue.Queue()  # prompt/bye hacia el loop principal
        self.interrupt_requested = False
        self.ended = False
        self.snapshot_provider = None  # callable -> list[dict] (lo pone ChatApp)
        self._buffer: list[dict] = []
        self._buf_lock = threading.Lock()
        self._stop = threading.Event()
        self._approvals: dict[str, str] = {}
        self._approval_cv = threading.Condition()
        self._threads: list[threading.Thread] = []

    # ── ciclo de vida ────────────────────────────────────────────────────

    def start(self, mode: str = "", model: str = "") -> dict:
        """Crea la sesión en el gateway y arranca lector y flusher."""
        resp = self.api.remote_create(self.source, self.title, self.machine)
        self.session_id = resp["session"]["id"]
        self.share_url = resp.get("share_url", "")
        self.emit("hello", source=self.source, title=self.title,
                  machine=self.machine, mode=mode, model=model,
                  commands=[{"name": n, "args": a, "description": d}
                            for n, a, d in REMOTE_COMMANDS])
        for target, name in ((self._reader_loop, "remote-reader"),
                             (self._flusher_loop, "remote-flusher")):
            t = threading.Thread(target=target, daemon=True, name=name)
            t.start()
            self._threads.append(t)
        return resp

    def stop(self, end_session: bool = True) -> None:
        """Corta hilos, hace un último flush y (opcional) termina la sesión."""
        self._stop.set()
        with self._approval_cv:
            self._approval_cv.notify_all()
        if end_session and not self.ended:
            try:
                self.emit("bye", reason="host_closed")
                self._flush_now()
                self.api.remote_end(self.session_id)
            except ApiError:
                pass
        self.ended = True

    def qr_text(self) -> str:
        """QR unicode (half-blocks) del share_url, generado por el gateway."""
        try:
            return self.api.remote_qr_txt(self.share_url)
        except ApiError:
            return ""

    # ── eventos (host → controllers) ─────────────────────────────────────

    def emit(self, event_type: str, **fields) -> None:
        ev = {"type": event_type, **fields}
        with self._buf_lock:
            self._buffer.append(ev)

    def emit_snapshot(self) -> None:
        if self.snapshot_provider is None:
            return
        try:
            messages = self.snapshot_provider()
        except Exception:
            return
        self.emit("snapshot", messages=messages)

    def _flush_now(self) -> None:
        with self._buf_lock:
            batch, self._buffer = self._buffer, []
        if not batch:
            return
        try:
            self.api.remote_events(self.session_id, batch)
        except ApiError as exc:
            if exc.status in (404, 410):
                self.ended = True
                self.commands.put({"type": "bye", "reason": "gone"})
                return
            # Fallo transitorio: devolver el lote al frente para reintentar
            with self._buf_lock:
                self._buffer = batch + self._buffer
                # Tope defensivo: nunca acumular sin límite si el server no vuelve
                if len(self._buffer) > 2000:
                    self._buffer = self._buffer[-1000:]

    def _flusher_loop(self) -> None:
        while not self._stop.is_set():
            time.sleep(REMOTE_FLUSH_SECONDS)
            self._flush_now()

    # ── comandos (controllers → host) ────────────────────────────────────

    def _reader_loop(self) -> None:
        backoff = 2
        while not self._stop.is_set() and not self.ended:
            try:
                response = self.api.remote_commands_stream(self.session_id)
                backoff = 2
                self._consume_commands(response)
            except ApiError as exc:
                if exc.status in (404, 410):
                    self.ended = True
                    self.commands.put({"type": "bye", "reason": "gone"})
                    return
            except Exception:
                pass
            if not self._stop.is_set() and not self.ended:
                time.sleep(backoff)
                backoff = min(backoff * 2, REMOTE_RECONNECT_MAX_S)

    def _consume_commands(self, response) -> None:
        try:
            for raw in response:
                if self._stop.is_set():
                    return
                line = raw.decode("utf-8", errors="replace").strip()
                if not line.startswith("data:"):
                    continue
                try:
                    cmd = json.loads(line[len("data:"):].strip())
                except json.JSONDecodeError:
                    continue
                self._dispatch(cmd)
        finally:
            try:
                response.close()
            except Exception:
                pass

    def _dispatch(self, cmd: dict) -> None:
        kind = cmd.get("type")
        if kind == "prompt":
            self.commands.put(cmd)
        elif kind == "interrupt":
            self.interrupt_requested = True
        elif kind == "approve":
            with self._approval_cv:
                self._approvals[str(cmd.get("id"))] = cmd.get("decision") or "deny"
                self._approval_cv.notify_all()
        elif kind == "request_snapshot":
            self.emit_snapshot()
        elif kind == "bye":
            self.ended = True
            with self._approval_cv:
                self._approval_cv.notify_all()
            self.commands.put(cmd)

    # ── aprobaciones remotas ─────────────────────────────────────────────

    def request_approval(self, tool: str, summary: str, risk: str) -> str:
        """Emite approval_request y bloquea hasta la decisión del móvil/web.
        Devuelve "allow" | "deny" (fin de sesión ⇒ deny)."""
        approval_id = uuid.uuid4().hex[:10]
        self.emit("approval_request", id=approval_id, tool=tool, summary=summary, risk=risk)
        with self._approval_cv:
            while approval_id not in self._approvals:
                if self.ended or self._stop.is_set():
                    return "deny"
                self._approval_cv.wait(timeout=1.0)
        decision = self._approvals.pop(approval_id)
        self.emit("approval_resolved", id=approval_id, decision=decision)
        return "allow" if decision == "allow" else "deny"

# ──────────────────────────────────────────────────────────────────────────
# módulo: lixbon_cli/agent.py
# ──────────────────────────────────────────────────────────────────────────
"""Modo agent: herramientas locales de código y loop de ejecución.

Dos protocolos, en este orden de preferencia:

1. Tool-calling NATIVO: se mandan las definiciones de funciones (TOOL_SCHEMAS)
   al gateway, que las pasa a Ollama. Los modelos entrenados con tools
   (qwen2.5-coder, llama3.2, mistral…) devuelven `tool_calls` estructurados.
   Es lo único que funciona de forma fiable con modelos chicos (7B): pedirles
   por prompt que escriban JSON a mano casi siempre acaba en un bloque ```.
2. Fallback de TEXTO: el modelo emite `{"tool": ..., "args": {...}}` embebido en
   la respuesta y aquí se parsea. Se usa si el modelo no soporta tools nativas.

En ambos casos se pide aprobación (con vista previa del diff) antes de ejecutar.
"""
import json
import re
import subprocess
from pathlib import Path


MAX_AGENT_STEPS = 12

READ_ONLY_TOOLS = {"list_files", "read_file", "search"}

# Catálogo legible de lo que el agente puede hacer (lo muestra /tools). Es la
# misma lista que se le describe al modelo en el system prompt, escrita para
# personas: quien usa el CLI necesita saber qué puede tocar el agente.
TOOL_SPECS: list[tuple[str, str, str]] = [
    ("list_files", "path", "Listar el contenido de una carpeta"),
    ("read_file", "path, start_line?, end_line?", "Leer un archivo (o un rango de líneas)"),
    ("search", "pattern, path", "Buscar texto en el workspace"),
    ("write_file", "path, content", "Crear o reemplazar un archivo entero"),
    ("edit_file", "path, old_text, new_text", "Sustituir un fragmento exacto de un archivo"),
    ("append_file", "path, content", "Añadir texto al final de un archivo"),
    ("mkdir", "path", "Crear una carpeta"),
    ("delete_file", "path", "Eliminar un archivo"),
    ("rename_file", "src, dst", "Mover o renombrar un archivo"),
    ("run_command", "command, timeout?", "Ejecutar un comando de shell en el workspace"),
]

# Definiciones de funciones en formato OpenAI para tool-calling NATIVO. El
# gateway (ChatCompletionRequest.tools) las reenvía tal cual a Ollama, que las
# inyecta en el template del modelo. Deben coincidir con execute_tool_call().
def _p(kind: str, description: str) -> dict:
    return {"type": kind, "description": description}


TOOL_SCHEMAS: list[dict] = [
    {"type": "function", "function": {
        "name": "list_files",
        "description": "Lista los archivos del workspace (o de una subcarpeta).",
        "parameters": {"type": "object", "properties": {
            "path": _p("string", 'Ruta relativa; "." para la raíz')}}}},
    {"type": "function", "function": {
        "name": "read_file",
        "description": "Lee el contenido de un archivo. Admite rango de líneas.",
        "parameters": {"type": "object", "properties": {
            "path": _p("string", "Ruta relativa del archivo"),
            "start_line": _p("integer", "Primera línea (1-based), opcional"),
            "end_line": _p("integer", "Última línea, opcional"),
        }, "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "search",
        "description": "Busca un texto EXACTO en los archivos del workspace (grep).",
        "parameters": {"type": "object", "properties": {
            "pattern": _p("string", "Texto a buscar"),
            "path": _p("string", 'Carpeta donde buscar; "." para todo el workspace'),
        }, "required": ["pattern"]}}},
    {"type": "function", "function": {
        "name": "write_file",
        "description": ("Crea un archivo con su contenido completo, creando las carpetas que falten. "
                        "Es la herramienta para crear archivos nuevos; para modificar uno existente "
                        "usa edit_file."),
        "parameters": {"type": "object", "properties": {
            "path": _p("string", "Ruta relativa del archivo"),
            "content": _p("string", "Contenido completo del archivo"),
        }, "required": ["path", "content"]}}},
    {"type": "function", "function": {
        "name": "edit_file",
        "description": ("Reemplaza un fragmento EXACTO de un archivo existente (edición parcial). "
                        "Preferir sobre write_file para modificar archivos ya creados."),
        "parameters": {"type": "object", "properties": {
            "path": _p("string", "Ruta relativa del archivo"),
            "old_text": _p("string", "Fragmento actual a reemplazar, copiado EXACTO (con su indentación)"),
            "new_text": _p("string", "Texto nuevo"),
            "all": _p("boolean", "Reemplazar todas las apariciones (por defecto solo la primera)"),
        }, "required": ["path", "old_text", "new_text"]}}},
    {"type": "function", "function": {
        "name": "append_file",
        "description": "Añade texto al final de un archivo (lo crea si no existe).",
        "parameters": {"type": "object", "properties": {
            "path": _p("string", "Ruta relativa del archivo"),
            "content": _p("string", "Texto a añadir"),
        }, "required": ["path", "content"]}}},
    {"type": "function", "function": {
        "name": "mkdir",
        "description": "Crea una carpeta (y las intermedias si faltan).",
        "parameters": {"type": "object", "properties": {
            "path": _p("string", "Ruta relativa de la carpeta")}, "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "delete_file",
        "description": "Elimina un archivo o carpeta.",
        "parameters": {"type": "object", "properties": {
            "path": _p("string", "Ruta relativa")}, "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "rename_file",
        "description": "Mueve o renombra un archivo.",
        "parameters": {"type": "object", "properties": {
            "src": _p("string", "Ruta origen"),
            "dst": _p("string", "Ruta destino"),
        }, "required": ["src", "dst"]}}},
    {"type": "function", "function": {
        "name": "run_command",
        "description": ("Ejecuta un comando de shell en el workspace: inicializar proyectos "
                        "(npm create, git init…), instalar dependencias, tests y builds."),
        "parameters": {"type": "object", "properties": {
            "command": _p("string", "Comando a ejecutar"),
            "timeout": _p("integer", "Segundos máximos (por defecto 30)"),
        }, "required": ["command"]}}},
]


def native_call_to_internal(call: dict) -> dict:
    """Convierte un tool_call nativo (formato OpenAI) al interno {tool, args}."""
    fn = call.get("function") or {}
    args = fn.get("arguments")
    if isinstance(args, str):
        try:
            args = json.loads(args or "{}")
        except Exception:
            args = {}
    return {"tool": fn.get("name", ""), "args": args if isinstance(args, dict) else {}}


def sanitize_for_plain_chat(messages: list[dict]) -> list[dict]:
    """Quita el round-trip de tools del historial para un chat normal.

    Los mensajes `role="tool"` solo son válidos justo detrás del assistant que
    los pidió; si el usuario pasa a modo ask (que recorta el historial) podrían
    quedar huérfanos y romper el template del modelo.
    """
    out = []
    for m in messages:
        if m.get("role") == "tool":
            continue
        if m.get("tool_calls"):
            m = {k: v for k, v in m.items() if k != "tool_calls"}
            if not (m.get("content") or "").strip():
                continue
        out.append(m)
    return out


# Recordatorio de una sola vez cuando el modelo "sugiere" código en el chat
# en vez de aplicarlo con herramientas (vicio típico de los modelos chicos).
NUDGE_PROMPT = (
    "Si ese código debía aplicarse a un archivo del workspace, hazlo AHORA con "
    '{"tool":"write_file","args":{"path":"...","content":"CONTENIDO COMPLETO"}} '
    '(JSON puro, sin ```). Si no había nada que aplicar, responde solo "OK".'
)

NATIVE_NUDGE_PROMPT = (
    "No escribas el código en el chat: aplícalo AHORA llamando a la herramienta "
    "write_file (o edit_file si el archivo ya existe), y usa run_command para los "
    'comandos. Si no había nada que aplicar, responde solo "OK".'
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


def build_native_system_prompt(workspace: Path) -> str:
    """Prompt para tool-calling NATIVO: las herramientas ya van en el template
    del modelo, así que aquí solo van las reglas de uso (describirlas otra vez
    confunde al modelo y le hace escribir JSON en el texto)."""
    return (
        "Eres un agente de código que trabaja DIRECTAMENTE sobre los archivos del usuario "
        "llamando a las herramientas que tienes disponibles.\n"
        f"Workspace: {workspace}\n"
        "Las rutas son siempre RELATIVAS al workspace.\n\n"
        "=== REGLAS ===\n"
        "1. Si el usuario pide crear, inicializar, modificar, arreglar, eliminar o ejecutar algo, "
        "LLAMA A LAS HERRAMIENTAS. Tú aplicas los cambios: el usuario no copia código a mano.\n"
        "2. NUNCA respondas con el código en un bloque ``` cuando lo que toca es escribirlo en "
        "un archivo: eso va en el argumento content de write_file.\n"
        "3. Para crear un proyecto: mkdir/write_file para los archivos, y run_command para los "
        "comandos de scaffolding, instalación o git.\n"
        "4. Para modificar un archivo que ya existe: primero read_file, luego edit_file con el "
        "fragmento exacto. write_file solo para archivos nuevos o reescrituras completas.\n"
        "5. Puedes llamar a varias herramientas seguidas; el resultado de cada una te llega antes "
        "del siguiente paso. Nunca inventes el resultado de una herramienta.\n"
        "6. Tras cambiar código, si hay tests o build, verifícalo con run_command y corrige si el "
        "EXIT es distinto de 0.\n"
        "7. Cuando ya no quede nada que hacer, responde con texto normal resumiendo lo hecho.\n\n"
        # Los modelos chicos (qwen2.5-coder:7b y similares) conocen el formato
        # pero se saltan los tags <tool_call>, y entonces Ollama devuelve la
        # llamada como texto plano. Repetir el formato aquí hace que al menos el
        # JSON salga bien formado: el CLI lo parsea igual desde el texto.
        "=== FORMATO DE LLAMADA ===\n"
        "Cada llamada va EXACTAMENTE así, sin ``` alrededor:\n"
        "<tool_call>\n"
        '{"name": "write_file", "arguments": {"path": "…", "content": "…"}}\n'
        "</tool_call>\n\n"
        "=== ARCHIVOS DEL WORKSPACE ===\n"
        f"{workspace_tree(workspace)}"
    )


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


def _scan_object(text: str, start: int) -> int:
    """Fin (exclusivo) del objeto que empieza en `start`, o -1 si no cierra.

    Cuenta llaves ignorando las que van dentro de un string. Reconoce strings
    con comilla doble Y simple: los modelos chicos escriben los argumentos al
    estilo Python ('…'), y con esas comillas sin reconocer el conteo se
    desbalancea y la llamada se pierde entera.
    """
    depth = 0
    quote = ""  # comilla que abrió el string actual ("" = fuera de string)
    escape_next = False
    for j in range(start, len(text)):
        ch = text[j]
        if escape_next:
            escape_next = False
        elif quote:
            if ch == "\\":
                escape_next = True
            elif ch == quote:
                quote = ""
        elif ch in ('"', "'"):
            quote = ch
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return j + 1
    return -1


def _quotes_to_json(text: str) -> str:
    """Convierte los strings 'a la Python' del candidato en strings JSON.

    qwen2.5-coder y otros modelos chicos emiten
    `{"name": "write_file", "arguments": {"content": '…'}}`: JSON inválido, así
    que la llamada se descartaba en silencio y el archivo nunca se escribía.
    Los escapes ya presentes (\\n, \\t…) se conservan tal cual; las comillas
    dobles y los saltos reales de dentro se escapan.
    """
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == '"':  # string JSON legítimo: copiar tal cual
            j = i + 1
            while j < n:
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == '"':
                    break
                j += 1
            out.append(text[i:min(j + 1, n)])
            i = j + 1
            continue
        if ch == "'":  # string estilo Python: reescribir con comilla doble
            buf: list[str] = []
            j = i + 1
            while j < n:
                c = text[j]
                if c == "\\":
                    nxt = text[j + 1] if j + 1 < n else ""
                    buf.append('\\"' if nxt == "'" else text[j:j + 2])
                    j += 2
                    continue
                if c == "'":
                    break
                buf.append({'"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t"}.get(c, c))
                j += 1
            out.append('"' + "".join(buf) + '"')
            i = j + 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _loads_lenient(candidate: str):
    """json.loads tolerante con lo que producen los modelos chicos.

    strict=False acepta saltos de línea reales dentro de los strings; si aun
    así falla, se prueba con las comillas normalizadas.
    """
    try:
        return json.loads(candidate, strict=False)
    except Exception:
        return json.loads(_quotes_to_json(candidate), strict=False)


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
        end = _scan_object(text, start)
        if end == -1:  # objeto sin cerrar: no hay más llamadas completas
            break
        try:
            data = _validate_tool_dict(_loads_lenient(text[start:end]))
            if data:
                results.append((data, start, end))
        except Exception:
            pass
        i = end
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
    return text if _scan_object(text, last) != -1 else text[:last]


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

    - `session`: estado mutable con `auto_approve: bool` y `native_tools: bool`
      (este último lo apaga la app si el modelo no soporta tools nativas).
    - `stream_assistant(messages, tools) -> (texto, tool_calls_nativos)`: lo
      aporta la app; muestra el texto del modelo en vivo y devuelve la respuesta
      completa junto con los tool_calls estructurados que haya emitido.
    Devuelve (respuesta_final, history_actualizado).
    """
    console = make_console()
    working = history[:]

    nudged = False
    actions_open = False  # la cabecera "acciones" se abre una vez por turno
    for _ in range(MAX_AGENT_STEPS):
        # El flag puede apagarse a mitad de turno (fallback si el modelo no
        # soporta tools), así que se relee en cada paso.
        native = session.get("native_tools", True)
        system_msg = {"role": "system", "content": (
            build_native_system_prompt(workspace) if native
            else build_agent_system_prompt(workspace))}
        messages = [system_msg] + (working if native else sanitize_for_plain_chat(working))
        raw, native_calls = stream_assistant(messages, TOOL_SCHEMAS if native else None)
        # Sin el corte, el modelo "ejecutaría" resultados que él mismo inventó
        assistant = truncate_fabricated(raw)

        if native_calls:
            working.append({"role": "assistant", "content": assistant, "tool_calls": native_calls})
            if not actions_open:
                render_actions_header(console)
                actions_open = True
            for call in native_calls:
                internal = native_call_to_internal(call)
                tool_name = internal["tool"]
                result = _approve_and_run(console, workspace, session, tool_name, internal["args"])
                working.append({
                    "role": "tool",
                    "content": result,
                    "tool_call_id": str(call.get("id") or ""),
                    "name": tool_name,
                })
            continue

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
                working.append({"role": "user",
                                "content": NATIVE_NUDGE_PROMPT if native else NUDGE_PROMPT})
                continue
            return assistant, working

        if not actions_open:
            render_actions_header(console)
            actions_open = True

        combined_results = []
        for call in tool_calls:
            tool_name = call.get("tool", "")
            args = call.get("args", {})
            result = _approve_and_run(console, workspace, session, tool_name, args)
            combined_results.append(f"TOOL_RESULT {tool_name}: {result}")

        working.append({"role": "user", "content": "\n".join(combined_results)})

    return "No se pudo finalizar: se alcanzó el máximo de pasos del agente.", working


def _approve_and_run(console, workspace: Path, session: dict, tool_name: str, args: dict) -> str:
    # Con /remote activo, la sesión se maneja desde el móvil/web: los eventos
    # de herramientas viajan al controller y las aprobaciones se piden allí
    # (localmente no hay nadie al teclado durante el takeover).
    remote = session.get("remote")

    if tool_name in READ_ONLY_TOOLS:
        # Solo lectura: se ejecuta sin preguntar, con rastro discreto.
        label = args.get("path") or args.get("pattern") or "."
        render_action(console, TOOL_VERB.get(tool_name, tool_name), str(label), readonly=True)
        if remote:
            remote.emit("tool_use", tool=tool_name, summary=str(label), readonly=True)
        return _run(console, workspace, tool_name, args, remote)

    try:
        change = compute_change(workspace, tool_name, args, resolve_safe_path)
    except Exception:
        change = None
    if change is not None:
        render_change(console, change)
    else:
        render_action(console, TOOL_VERB.get(tool_name, tool_name), _args_summary(tool_name, args))
    if remote:
        remote.emit("tool_use", tool=tool_name, summary=_args_summary(tool_name, args), readonly=False)

    # Los comandos de shell son irreversibles (sin snapshot que los deshaga):
    # tienen su propio flag y NO los cubre auto_approve. Así, responder
    # "siempre" tras una edición de archivo no habilita ejecutar comandos.
    if tool_name == "run_command":
        if not session.get("auto_run_commands"):
            if remote:
                if remote.request_approval(tool_name, _args_summary(tool_name, args), "command") != "allow":
                    render_action_result(console, "rechazado desde el control remoto", error=True)
                    return "Ejecución cancelada por el usuario"
            else:
                decision = confirm3("¿Ejecutar este comando?")
                if decision == "always":
                    session["auto_run_commands"] = True
                elif decision in ("no", None):
                    render_action_result(console, "rechazado por el usuario", error=True)
                    return "Ejecución cancelada por el usuario"
    elif not session.get("auto_approve"):
        if remote:
            if remote.request_approval(tool_name, _args_summary(tool_name, args), "edit") != "allow":
                render_action_result(console, "rechazado desde el control remoto", error=True)
                return "Ejecución cancelada por el usuario"
        else:
            decision = confirm3("¿Aplicar este cambio?")
            if decision == "always":
                session["auto_approve"] = True
            elif decision in ("no", None):
                render_action_result(console, "rechazado por el usuario", error=True)
                return "Ejecución cancelada por el usuario"

    return _run(console, workspace, tool_name, args, remote)


def _run(console, workspace: Path, tool_name: str, args: dict, remote=None) -> str:
    try:
        result = execute_tool_call(workspace, tool_name, args)
    except Exception as exc:
        result = f"[ERROR] {exc}"
    failed = (result.startswith("[ERROR]") or result.startswith("[TIMEOUT]")
              or (result.startswith("[EXIT ") and not result.startswith("[EXIT 0]")))
    if tool_name not in READ_ONLY_TOOLS or failed:
        render_action_result(console, result.split("\n", 1)[0][:120], error=failed)
    if remote:
        remote.emit("tool_result", tool=tool_name,
                    result=result[:REMOTE_RESULT_CHARS], error=failed)
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

# (nombre, argumentos, descripción, grupo) — los handlers viven en ChatApp
# como cmd_<nombre>. El grupo ordena /help y el menú de la barra de comandos:
# leer 30 comandos en una lista plana no ayuda a nadie.
COMMAND_SPECS: list[tuple[str, str, str, str]] = [
    # ── conversación ────────────────────────────────────────────────────
    ("help", "", "Ver todos los comandos", "conversación"),
    ("model", "[nombre]", "Cambiar de modelo (sin argumento abre el selector)", "conversación"),
    ("mode", "[ask|agent|delegate]", "Cambiar modo de trabajo", "conversación"),
    ("new", "", "Empezar una conversación nueva", "conversación"),
    ("compact", "", "Compactar la conversación para liberar contexto", "conversación"),
    ("history", "", "Ver los mensajes de la sesión y reenviar uno", "conversación"),
    ("image", "<ruta>", "Adjuntar una imagen al próximo mensaje (también @ruta)", "conversación"),
    ("web", "[on|off]", "Búsqueda web durante las respuestas", "conversación"),
    ("copy", "", "Copiar la última respuesta al portapapeles", "conversación"),
    ("save", "[ruta]", "Guardar la conversación en un archivo Markdown", "conversación"),
    ("clear", "", "Limpiar la pantalla", "conversación"),
    # ── agente ──────────────────────────────────────────────────────────
    ("approve", "[on|off]", "Auto-aprobar herramientas del agente", "agente"),
    ("tools", "", "Ver las herramientas que puede usar el agente", "agente"),
    ("diff", "[ruta]", "Ver los cambios sin confirmar del workspace", "agente"),
    ("run", "<comando>", "Ejecutar un comando y darle la salida al modelo", "agente"),
    ("workspace", "[ruta]", "Carpeta de trabajo del modo agent", "agente"),
    ("init", "", "Generar LIXBON.md con el contexto del proyecto", "agente"),
    # ── cuenta ──────────────────────────────────────────────────────────
    ("status", "", "Ver estado de la sesión", "cuenta"),
    ("cost", "", "Tokens y contexto consumidos en esta sesión", "cuenta"),
    ("usage", "", "Ver uso global de la cuenta", "cuenta"),
    ("nodes", "", "Ver nodos del clúster", "cuenta"),
    ("login", "", "Iniciar sesión de nuevo", "cuenta"),
    ("logout", "", "Cerrar la sesión de esta máquina", "cuenta"),
    ("key", "<api_key>", "Usar otra API key", "cuenta"),
    # ── sistema ─────────────────────────────────────────────────────────
    ("config", "", "Ajustes del CLI en un menú", "sistema"),
    ("context-window", "<n>", "Tokens de la ventana de contexto (para la barra)", "sistema"),
    ("bar", "[on|off]", "Barra de estado fija al pie de la terminal", "sistema"),
    ("doctor", "", "Diagnóstico de terminal, conexión y sesión", "sistema"),
    ("remote", "", "Controlar esta sesión desde la app móvil (link + QR)", "sistema"),
    ("update", "", "Actualizar el CLI desde el servidor", "sistema"),
    ("exit", "", "Salir", "sistema"),
]

COMMAND_GROUPS = ("conversación", "agente", "cuenta", "sistema")

# Orden de presentación: por grupo (el del catálogo) y, dentro, alfabético.
# El menú del prompt no puede pintar cabeceras, así que el orden es lo único
# que agrupa visualmente; sin él son 31 comandos en desorden.
COMMAND_ORDER: list[tuple[str, str, str, str]] = sorted(
    COMMAND_SPECS,
    key=lambda spec: (COMMAND_GROUPS.index(spec[3]) if spec[3] in COMMAND_GROUPS else 99, spec[0]),
)

# Ancho de la columna del nombre: alinea los argumentos y las descripciones.
COMMAND_NAME_WIDTH = max(len(name) for name, _a, _d, _g in COMMAND_SPECS) + 1


def command_matches(prefix: str) -> list[tuple[str, str, str, str]]:
    """Comandos cuyo nombre empieza por `prefix` (sin la barra), en orden de menú."""
    prefix = prefix.lower()
    return [spec for spec in COMMAND_ORDER if spec[0].startswith(prefix)]


def common_command_prefix(names: list[str]) -> str:
    """Prefijo común a todos los nombres (para completar sin elegir por el usuario)."""
    if not names:
        return ""
    shared = names[0]
    for name in names[1:]:
        while not name.startswith(shared):
            shared = shared[:-1]
            if not shared:
                return ""
    return shared


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
            prefix = text[1:].lower()
            for name, args, desc, group in COMMAND_ORDER:
                if not name.startswith(prefix):
                    continue
                # Dos columnas dentro del propio display: el nombre ocupa
                # siempre lo mismo, así los argumentos quedan en vertical y la
                # lista se lee como una tabla y no como texto irregular.
                display = [
                    ("class:cmd.name", f"/{name}".ljust(COMMAND_NAME_WIDTH + 1)),
                    ("class:cmd.args", args),
                ]
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
import platform
import queue
import subprocess
import time
import uuid
from pathlib import Path


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
        self.title = title or "Sesión CLI"
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
        }
        # tool_calls nativos del último stream (los consume _stream_agent)
        self._last_tool_calls: list[dict] = []
        self.history: list[dict] = []
        self.remote: RemoteLink | None = None  # host de /remote (takeover activo)
        self.conversation_id = str(uuid.uuid4())
        self.models_cache: list[str] = []
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

        cols, _ = term_size()
        width = max(cols, 20)
        try:
            line = self.status.rich_line(bar=True, width=width - 1)
            draw_status_line(render_ansi(line, width))
        except Exception:
            pass  # la barra nunca puede tumbar la sesión

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
            release_status_line()

    def _render_identity(self) -> None:
        """Cabecera de identidad del CLI (sube con el transcript al chatear)."""
        render_header(self.console, CLI_VERSION, model=self.model,
                      plan=self.plan_name, workspace=self.workspace)

    def _set_tab_title(self) -> None:
        """La pestaña de la terminal deja de llamarse `cmd` y pasa a ser Lixbon."""
        set_title(f"{g('spark')} Lixbon {g('sep')} {self.workspace.name}")

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

        @kb.add("enter", filter=completion_is_selected)
        def _enter_selected(event):
            # El usuario navegó el menú con las flechas: Enter elige lo marcado.
            buff = event.current_buffer
            buff.apply_completion(buff.complete_state.current_completion)

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
            render_speaker(self.console, "user")
            self.console.print(f"[lx.primary]{esc(clean or text)}[/]")
        if self.remote:
            self.remote.emit("user_msg", text=clean or text, origin=origin)
            self.remote.emit("status", state="thinking")

        self.console.print()
        render_speaker(self.console, "assistant")
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
            if self.remote:
                self.remote.emit("status", state="idle")
        self._refresh_status()

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


        def _live_view():
            blocks = []
            if reasoning_parts:
                tail = "".join(reasoning_parts).strip().splitlines()[-3:]
                head = Text(f"{g('spark_alt')} pensando…", style="lx.dim")
                blocks.append(head)
                for line in tail:
                    blocks.append(Text(f"  {line}", style="lx.thinking"))
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
            # La vista viva se queda en la cola: una respuesta larga desbordaría
            # la pantalla y el borrado del Live dejaría el hueco de vuelta. El
            # texto íntegro lo imprime _final_view() al cerrar el Live.
            rows = min(self.console.size.height - 2, LIVE_TAIL_ROWS)
            return Tail(pad(Group(*blocks)), max(rows, 4))

        def _final_view():
            blocks = []
            if reasoning_seconds > 0.5:
                blocks.append(Text(f"{g('spark_alt')} Pensó durante {reasoning_seconds:.1f}s", style="lx.dim2"))
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
                    if self.remote and self.remote.interrupt_requested:
                        # Interrupción pedida desde el móvil/web (equivale a Ctrl+C)
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
        final = _final_view()
        if final is not None:
            self.console.print(final)
            self.console.print()
        if sources:
            self.console.print(f"[lx.dim]Fuentes web: " + "; ".join(
                str(s.get("url") or s.get("title") or "?") for s in sources[:5]) + "[/]")
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
        self.history = []
        self.session_tokens = 0
        self.conversation_id = str(uuid.uuid4())
        # El separador marca dónde empieza el contexto nuevo: sin él, el
        # transcript anterior parece seguir vivo.
        rule(self.console, "conversación nueva")
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
        # console.clear() solo borra lo visible: el scrollback conservaba la
        # conversación anterior, así que /clear no limpiaba de verdad.
        clear_screen()
        self._render_identity()
        rule(self.console, "conversación")
        self._paint_status()  # el 2J del clear también borró la fila reservada
        return True

    def cmd_update(self, arg: str):

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
            ("Mensajes que se envían", f"últimos {self.cfg.get('max_context_messages', 12)}"),
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

        render_actions_header(self.console)
        render_action(self.console, "ejecutó", command)
        for line in (output or "(sin salida)").splitlines()[:80]:
            self.console.print(f"  [lx.dim]{esc(line)}[/]")
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
        """Los mensajes de la sesión; elegir uno lo reenvía tal cual."""
        mine = [m for m in self.history
                if m.get("role") == "user" and not (m.get("content") or "").startswith("TOOL_RESULT")]
        if not mine:
            print_note("Todavía no has enviado ningún mensaje en esta sesión.")
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
    render_intro_line(make_console(), CLI_VERSION, "iniciar sesión")
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
