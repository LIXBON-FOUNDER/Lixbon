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

# Salida REAL de la terminal, capturada antes de que nadie la sustituya.
#
# Mientras hay un Live (o un Status) de rich activo, rich reemplaza
# `sys.stdout` por un FileProxy: todo lo que se escriba ahí deja de ir a la
# terminal y pasa a ser UN RENDERABLE MÁS del transcript. Los escapes de la
# barra fija (DECSC, ir a la fila reservada, DECRC) contaban entonces como
# texto visible: rich los medía, hacía wrap y cerraba con un salto de línea,
# así que cada repintado durante el streaming empujaba el transcript una o dos
# filas hacia arriba. En segundos la respuesta quedaba pegada al fondo con la
# pantalla en blanco encima. Todo escape de control se escribe al stdout real.
_real_stdout = sys.stdout


def _out():
    """Stream de terminal, a salvo del FileProxy con el que rich toma stdout."""
    return _real_stdout if _real_stdout is not None else sys.stdout


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
    global _real_stdout

    enable_vt()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    _real_stdout = sys.stdout  # se llama al arrancar: aún no hay Live de rich


def _unicode_ok() -> bool:
    if not IS_WINDOWS:
        return True
    try:
        "✦●▓░❯╭█─│┃".encode(_ORIG_ENCODING)
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
    # Canal del registro de trabajo del agente: fino para el rastro (lecturas,
    # diffs, resultados) y grueso para la línea en la que tocó el disco. Los dos
    # pesos del mismo juego de box-drawing ocupan una celda y alinean igual.
    "rail": "│",
    "rail_hot": "┃",
    # Marca de la fila elegida en cualquier menú. El punto (●) queda reservado
    # para el usuario, así que la selección necesita un signo propio.
    "edge": "▌",
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
    "rail": "|",
    "rail_hot": "|",
    "edge": ">",
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
        out = _out()
        out.write(f"\033]0;{text}\007")
        out.flush()
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
        out = _out()
        out.write("\033[H\033[2J\033[3J")
        out.flush()
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
        out = _out()
        out.write(seq)
        out.flush()
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
    if _out().isatty() and sys.stdin.isatty():
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
        if not (sys.stdin.isatty() and _out().isatty()):
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
    # Fondos. `panel` viste todo lo que es superficie y no texto: la burbuja del
    # usuario, la barra de estado, los menús y el código en línea. `sel` es un
    # escalón por encima, solo para la fila marcada de un menú.
    "panel": "#1E1E1A",
    "sel": "#2A2A24",
    "ok": "#5FB85F",      # éxito, líneas + de diff
    "err": "#E05C5C",     # error, líneas - de diff
    # Diff: la fila entera se pinta con un fondo tenue (como en un editor) y el
    # signo va en un tono más vivo para que se lea sobre ese fondo. Elegidos
    # contra el casi-negro de la terminal: visibles sin tapar el código.
    "diff_add_bg": "#173A24",
    "diff_del_bg": "#45191D",
    "diff_add_fg": "#8FE39B",
    "diff_del_fg": "#FF9E9E",
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
    "lx.diff.add": PALETTE["diff_add_fg"],
    "lx.diff.del": PALETTE["diff_del_fg"],
    "lx.diff.hunk": PALETTE["dim"],
    # Burbuja del mensaje del usuario: el fondo la delimita, así que no hace
    # falta borde y solo ocupa lo que ocupa el texto.
    "lx.bubble": f"{PALETTE['cream']} on {PALETTE['panel']}",
    "lx.bubble.dot": f"bold {PALETTE['accent']} on {PALETTE['panel']}",
    "lx.code": f"{PALETTE['beige']} on {PALETTE['panel']}",
    # Un error de herramienta se pinta como una fila de diff eliminado: es la
    # única forma de que no se pierda entre veinte líneas de registro.
    "lx.err.row": f"{PALETTE['diff_del_fg']} on {PALETTE['diff_del_bg']}",
    # Markdown de las respuestas. Sin esto rich usa sus colores por defecto
    # (azules de enlace, títulos en panel centrado) que no son de la marca.
    "markdown.code": f"{PALETTE['beige']} on {PALETTE['panel']}",
    "markdown.code_block": PALETTE["beige"],
    "markdown.h1": f"bold {PALETTE['olive_lt']}",
    "markdown.h2": f"bold {PALETTE['olive_lt']}",
    "markdown.h3": f"bold {PALETTE['olive_lt']}",
    "markdown.h4": f"bold {PALETTE['beige']}",
    "markdown.item.bullet": PALETTE["accent"],
    "markdown.item.number": PALETTE["accent"],
    "markdown.link": PALETTE["accent"],
    "markdown.link_url": PALETTE["dim2"],
    "markdown.block_quote": PALETTE["dim"],
    "markdown.hr": PALETTE["dim2"],
    # Fondo de la barra de estado fija. Va como estilo BASE del Text: los
    # spans de cada trozo solo fijan color de texto, así que el fondo
    # sobrevive por debajo y llega hasta el relleno del borde derecho.
    "lx.bar": f"on {PALETTE['panel']}",  # rich usa `on <color>`; `bg:` es de prompt_toolkit
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

            # Contador de impresiones CON CONTENIDO. Sirve para saber si un
            # turno ya escribió algo (registro de acciones) y decidir si la
            # respuesta necesita una línea de aire por encima, sin repartir
            # banderas por medio código. Los Control del Live no cuentan: son
            # fontanería de repintado y dispararían el contador en cada frame.
            writes = 0

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
                if not objects or any(
                    not isinstance(obj, (Control, NewLine)) for obj in objects
                ):
                    self.writes += 1
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
            # Color base de la consola: sin él el Markdown de las respuestas
            # (que no lleva estilo propio) salía en el blanco por defecto de la
            # terminal, ajeno a la paleta. Con la base en crema, el cuerpo de la
            # respuesta es del color de la marca y los grises del registro de
            # trabajo se leen como lo que son: un escalón por debajo.
            style=PALETTE["cream"],
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

    panel = PALETTE["panel"]
    return Style.from_dict({
        # Prompt de entrada: el punto ● es el usuario, dentro de su caja.
        "prompt": f"bold {PALETTE['accent']}",
        "placeholder": PALETTE["dim2"],
        "img-marker": f"{PALETTE['beige']} bg:{panel}",
        # Caja de entrada (show_frame de prompt_toolkit). `frame` no lleva fondo
        # a propósito: la caja es un borde, no una superficie.
        "frame.border": PALETTE["dim2"],
        # Selector interactivo
        "sel.rail": PALETTE["dim2"],
        "sel.title": f"bold {PALETTE['cream']}",
        "sel.detail": PALETTE["dim2"],
        "sel.hint": PALETTE["dim2"],
        "sel.count": PALETTE["dim2"],
        "sel.query": f"bold {PALETTE['accent']}",
        "sel.scroll": PALETTE["dim2"],
        "sel.group": PALETTE["dim2"],
        "sel.rule": PALETTE["dim2"],
        "sel.disabled": f"italic {PALETTE['dim2']}",
        # Fila marcada: el canto en acento y la fila entera rellena. Las tres
        # clases `sel.row*` comparten el fondo para que el bloque no se corte.
        "sel.edge": f"bold {PALETTE['accent']}",
        "sel.row": f"bg:{PALETTE['sel']}",
        "sel.row.label": f"bold {PALETTE['cream']} bg:{PALETTE['sel']}",
        "sel.row.desc": f"{PALETTE['dim']} bg:{PALETTE['sel']}",
        "sel.row.badge": f"{PALETTE['beige']} bg:{PALETTE['sel']}",
        "sel.option": PALETTE["cream"],
        "sel.option.desc": PALETTE["dim2"],
        "sel.badge": PALETTE["beige"],
        # Barra de estado inferior (bottom_toolbar) — fondo propio sutil
        "bottom-toolbar": f"{PALETTE['dim']} bg:{panel} noinherit",
        "bottom-toolbar.dot": f"{PALETTE['accent']} bg:{panel}",
        "bottom-toolbar.ok": f"{PALETTE['ok']} bg:{panel}",
        "bottom-toolbar.warn": f"{PALETTE['warn']} bg:{panel}",
        "bottom-toolbar.err": f"{PALETTE['err']} bg:{panel}",
        "bottom-toolbar.model": f"{PALETTE['beige']} bg:{panel}",
        "bottom-toolbar.sep": f"{PALETTE['dim2']} bg:{panel}",
        # Menú de autocompletado de slash-commands
        "completion-menu": f"bg:{panel} {PALETTE['cream']}",
        "completion-menu.completion": f"bg:{panel} {PALETTE['cream']}",
        "completion-menu.completion.current": f"bold bg:{PALETTE['accent']} {PALETTE['ink']}",
        "completion-menu.meta.completion": f"bg:{panel} {PALETTE['dim']}",
        # La meta de la fila marcada se queda en el mismo acento y baja a oliva:
        # dos fondos distintos en una sola fila la partían en dos.
        "completion-menu.meta.completion.current": f"bg:{PALETTE['accent']} {PALETTE['olive']}",
        # Columnas del display de cada comando. Reglas de 2 nombres: la fila
        # marcada (`completion-menu.completion.current`, 3 nombres) gana en
        # especificidad y se pinta entera en tinta sobre acento.
        "cmd.name": PALETTE["cream"],
        "cmd.args": PALETTE["dim2"],
        # El color del nombre dice a qué grupo pertenece el comando: el menú del
        # prompt no puede pintar cabeceras, y el orden solo no agrupa a la vista.
        "cmd.conversacion": PALETTE["cream"],
        "cmd.agente": PALETTE["accent"],
        "cmd.cuenta": PALETTE["beige"],
        "cmd.sistema": PALETTE["dim"],
        # Barra de scroll del menú, para que se note que la lista sigue.
        "scrollbar.background": f"bg:{panel}",
        "scrollbar.button": f"bg:{PALETTE['dim2']}",
    })

# ──────────────────────────────────────────────────────────────────────────
# módulo: lixbon_cli/config.py
# ──────────────────────────────────────────────────────────────────────────
"""Configuración local del CLI (~/.lixbon/config.json)."""
import json
from pathlib import Path

CLI_VERSION = "2.3.0"

DEFAULT_BASE_URL = "https://lixbon.com/v1"
# Cloudflare bloquea el User-Agent por defecto de urllib ("Python-urllib/x.y")
# con un 403 "error code: 1010", así que el CLI se identifica con el suyo.
USER_AGENT = f"Lixbon-CLI/{CLI_VERSION}"
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
        # Ventana de contexto que se le pide a Ollama (num_ctx) y con la que se
        # calcula el presupuesto del turno de agente. 8192 se quedaba corto: los
        # resultados de las herramientas la llenaban en pocos pasos y el modelo
        # se quedaba sin system prompt (Ollama recorta por delante), que es como
        # el agente acababa congelado. Si el nodo va justo de VRAM, bájala con
        # /context-window: el CLI se adapta al valor que haya.
        "context_window": 16384,
        "mode": "agent",  # por defecto el modelo puede crear/editar archivos (con aprobación)
        "workspace": str(Path.cwd()),
        "auto_approve_tools": True,  # el agente escribe directo; /approve off para pedir confirmación
        # Poder escribir mientras el agente trabaja (se ejecuta al terminar).
        # A false, el teclado vuelve a estar muerto durante el turno.
        "input_queue": True,
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
    if "error code: 10" in body:  # bloqueo del WAF de Cloudflare, no del gateway
        return f"Conexión bloqueada por el filtro del servidor ({body.strip()[:40]})."
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
        headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
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

    def model_roles(self) -> dict:
        """Mapa rol→modelo que resuelve el gateway. {} si no lo soporta.

        El CLI solo usa el rol `chat` (para no abrir el selector cuando el
        servidor ya tiene un modelo de chat configurado). Un gateway antiguo
        responde 404: se degrada en silencio, no es un error del usuario.
        """
        try:
            return self._json("GET", f"{self.server}/api/model-roles", timeout=15)
        except ApiError:
            return {}

    def usage(self) -> dict:
        return self._json("GET", f"{self.server}/api/usage", timeout=20)

    def nodes(self) -> dict:
        return self._json("GET", f"{self.server}/api/nodes", timeout=20)

    def generate_title(self, conversation_id: str) -> dict:
        """Auto-título del servidor tras el primer intercambio (como la web)."""
        return self._json("POST",
                          f"{self.server}/api/conversations/{conversation_id}/generate-title",
                          {}, timeout=30)

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
# módulo: lixbon_cli/inputq.py
# ──────────────────────────────────────────────────────────────────────────
"""Cola de entrada: escribir mientras el agente trabaja.

Durante un turno el CLI está ocupado (streaming + herramientas) y prompt_toolkit
no corre, así que el teclado quedaba muerto. Aquí se lee en segundo plano: lo
que se teclea se muestra en la vista viva y, al pulsar Enter, se guarda en una
cola que el bucle principal vacía en cuanto el turno termina.

DOS REGLAS que hacen que esto no rompa nada:

1. **No se toca lo que hace el agente.** El hilo solo acumula texto; nada se
   ejecuta hasta que el turno acaba. Un comando escrito a media respuesta no
   cambia el modelo, el modo ni el workspace en mitad del razonamiento.
2. **Se cede el teclado a quien lo pida.** Cualquier prompt interactivo
   (aprobaciones, selectores) pasa por `suspend_input()`, que pausa la lectura
   y restaura el modo de la terminal mientras dure.

En POSIX se usa `cbreak` y NO `raw`: cbreak deja las señales activas, así que
Ctrl+C sigue siendo Ctrl+C. En Windows se lee con `msvcrt`, que no cambia el
modo de la consola en absoluto.
"""
import contextlib
import sys
import threading
import time


MAX_LINE_CHARS = 2000
POLL_SECONDS = 0.03

_active = None  # InputQueue en marcha, para que suspend_input() la encuentre


class InputQueue:
    """Lector de teclado en segundo plano con una cola de líneas."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._buffer = ""
        self._lines: list[str] = []
        self._stop = threading.Event()
        self._paused = threading.Event()
        self._thread: threading.Thread | None = None
        self._saved_mode = None
        self.interrupted = False
        self.running = False

    # ── ciclo de vida ───────────────────────────────────────────────────

    def start(self) -> bool:
        global _active
        if self.running:
            return True
        if not self._enter_mode():
            return False
        self._stop.clear()
        self._paused.clear()
        self.interrupted = False
        self.running = True
        _active = self
        # Si el proceso muere sin pasar por stop(), en POSIX la terminal se
        # quedaría en cbreak (sin eco y sin líneas) para la shell del usuario.
        import atexit

        atexit.register(self._exit_mode)
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return True

    def stop(self) -> None:
        global _active
        if not self.running:
            return
        self.running = False
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=0.5)
        self._exit_mode()
        if _active is self:
            _active = None
        # El buffer a medias NO se borra: `take_partial()` lo pasa como texto
        # inicial del prompt, así una frase que se quedó sin Enter no se pierde.

    def pause(self) -> None:
        if self.running and not self._paused.is_set():
            self._paused.set()
            # El hilo puede estar dentro de una lectura: se le da tiempo a
            # salir antes de devolver la terminal a quien la pidió.
            time.sleep(POLL_SECONDS * 2)
            self._exit_mode()

    def resume(self) -> None:
        if self.running and self._paused.is_set():
            self._enter_mode()
            self._paused.clear()

    # ── estado para pintar ──────────────────────────────────────────────

    @property
    def typing(self) -> str:
        with self._lock:
            return self._buffer

    @property
    def queued(self) -> int:
        with self._lock:
            return len(self._lines)

    def take_partial(self) -> str:
        """Lo que quedó escrito sin Enter (para precargar el prompt)."""
        with self._lock:
            text, self._buffer = self._buffer, ""
        return text

    def drain(self) -> list[str]:
        """Saca las líneas completas; lo que quede a medias sigue en el buffer."""
        with self._lock:
            lines, self._lines = self._lines, []
        return lines

    # ── modo de terminal ────────────────────────────────────────────────

    def _enter_mode(self) -> bool:
        if IS_WINDOWS:
            try:
                import msvcrt  # noqa: F401
            except ImportError:
                return False
            return True
        try:
            import termios
            import tty

            fd = sys.stdin.fileno()
            self._saved_mode = termios.tcgetattr(fd)
            tty.setcbreak(fd)
            return True
        except Exception:
            self._saved_mode = None
            return False

    def _exit_mode(self) -> None:
        if IS_WINDOWS or self._saved_mode is None:
            return
        try:
            import termios

            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, self._saved_mode)
        except Exception:
            pass
        self._saved_mode = None

    # ── lectura ─────────────────────────────────────────────────────────

    def _read_char(self):
        if IS_WINDOWS:
            import msvcrt

            if not msvcrt.kbhit():
                return None
            char = msvcrt.getwch()
            if char in ("\x00", "\xe0"):
                # Flechas, F1-F12, Inicio…: llegan en dos lecturas y aquí no
                # sirven de nada, pero hay que consumir la segunda.
                if msvcrt.kbhit():
                    msvcrt.getwch()
                return None
            return char
        import select

        ready, _, _ = select.select([sys.stdin], [], [], POLL_SECONDS)
        if not ready:
            return None
        return sys.stdin.read(1)

    def _loop(self) -> None:
        while not self._stop.is_set():
            if self._paused.is_set():
                time.sleep(POLL_SECONDS)
                continue
            try:
                char = self._read_char()
            except Exception:
                return  # la terminal cambió bajo los pies: mejor callarse
            if char is None:
                if IS_WINDOWS:
                    time.sleep(POLL_SECONDS)
                continue
            self._handle(char)

    def _handle(self, char: str) -> None:
        if char == "\x03":  # Ctrl+C
            self.interrupted = True
            with self._lock:
                self._buffer = ""
            return
        if char in ("\r", "\n"):
            with self._lock:
                text = self._buffer.strip()
                self._buffer = ""
                if text:
                    self._lines.append(text)
            return
        if char in ("\x08", "\x7f"):  # Backspace
            with self._lock:
                self._buffer = self._buffer[:-1]
            return
        if char == "\x1b":  # Esc descarta lo escrito
            with self._lock:
                self._buffer = ""
            return
        if char < " ":
            return  # otros controles (Ctrl+letra): sin uso durante el turno
        with self._lock:
            if len(self._buffer) < MAX_LINE_CHARS:
                self._buffer += char


@contextlib.contextmanager
def suspend_input():
    """Cede el teclado mientras dure el bloque (selectores, aprobaciones)."""
    queue = _active
    if queue is not None:
        queue.pause()
    try:
        yield
    finally:
        if queue is not None:
            queue.resume()

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


# ── Rejilla de una línea ────────────────────────────────────────────────────
#
# Casi todo el CLI son filas de dos columnas: a la izquierda lo que pasó y a la
# derecha su medida (tiempo, líneas, tokens, +/-). La meta va SIEMPRE pegada al
# margen derecho: así un turno largo se lee como una tabla y no como texto
# irregular, sin tener que contar espacios en cada sitio que imprime.


def row_width(console) -> int:
    """Ancho útil de una fila impresa con `console.print` (sin márgenes)."""

    return max(24, console.width - PAD_LEFT - PAD_RIGHT)


def inner_width() -> int:
    """El mismo ancho para lo que pinta prompt_toolkit (que no pasa por rich)."""

    return max(24, min(term_size()[0], MAX_WIDTH) - PAD_LEFT - PAD_RIGHT)


def two_col(left, right, width: int):
    """Une dos `Text` rellenando el hueco: el derecho queda al margen."""
    if right is None or not right.cell_len:
        return left
    limit = width - right.cell_len - 1
    if left.cell_len > limit:
        # Antes se cede la izquierda (una ruta larga) que la medida: la fila
        # tiene que caber en una línea o el bloque deja de leerse como tabla.
        left.truncate(max(6, limit), overflow="ellipsis")
    left.pad_right(max(1, width - left.cell_len - right.cell_len))
    return left.append_text(right)


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
                  workspace: object = None, branch: str = "", mode: str = "") -> None:
    """Bloque de identidad, arriba a la izquierda y sin cajas.

        ██  Lixbon CLI v2.1.0
        ██  modelo-demo · Lixbon Pro
            ~/proyectos/api · master · modo agent

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
        line3 = [(indent, ""), (short_path(workspace), "lx.dim")]
        for extra in (branch, f"modo {mode}" if mode else ""):
            if extra:
                line3 += [(f"  {g('sep')}  ", "lx.dim2"), (extra, "lx.dim2")]
        console.print(Text.assemble(*line3))
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


# Atajos del arranque, en rejilla de tres columnas. En una sola frase con
# separadores la línea hacía wrap por la mitad de un atajo ("Alt+V pega una
# imagen en el / mensaje") y no había manera de localizar una tecla de un
# vistazo. En columnas, la tecla y lo que hace quedan alineados.
TIPS = (
    ("/", "comandos"),
    ("@ruta", "adjuntar archivo"),
    ("Alt+V", "pegar imagen"),
    ("Alt+↵", "nueva línea"),
    ("Ctrl+C", "interrumpir"),
    ("Ctrl+C ×2", "salir"),
)
TIP_COLUMNS = 3


def render_tips(console) -> None:
    """Atajos de arranque en rejilla, sin panel (el panel era una caja más que
    competía visualmente con el chat)."""
    from rich.text import Text

    width = row_width(console)
    column = max(22, (width - 2) // TIP_COLUMNS)
    key_width = max(len(key) for key, _desc in TIPS) + 2
    for start in range(0, len(TIPS), TIP_COLUMNS):
        line = Text("  ")
        for key, desc in TIPS[start:start + TIP_COLUMNS]:
            cell = Text()
            cell.append(f"{key:<{key_width}}", style="lx.accent2")
            cell.append(desc, style="lx.dim")
            cell.pad_right(max(1, column - cell.cell_len))
            line.append_text(cell)
        console.print(line)


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


def render_speaker(console, meta: str = "") -> None:
    """Rótulo que abre la respuesta de Lixbon, con su medida a la derecha.

    Se imprime una sola vez por turno y JUSTO ENCIMA de lo que dice, no al
    empezar a trabajar: el registro de acciones queda por arriba, dentro de su
    canal, y el rótulo marca dónde empieza lo que hay que leer.
    """
    from rich.text import Text

    left = Text.assemble((f"{g('spark')} ", "lx.accent2"), ("Lixbon", "lx.brand"))
    right = Text(meta, style="lx.dim2") if meta else None
    console.print(two_col(left, right, row_width(console)))


def render_user_message(console, text: str) -> None:
    """Eco de un mensaje del usuario: su burbuja.

    El fondo la delimita y solo llega hasta donde llega el texto, así que un
    «sí» no dibuja una banda de punta a punta. Se imprime al enviar (el prompt
    se borra a sí mismo) y también con /remote: lo que llega del móvil tiene
    que verse igual que lo tecleado, o el transcript se lee como dos
    conversaciones distintas.
    """
    import textwrap

    from rich.text import Text

    width = max(20, row_width(console) - 6)
    lines: list[str] = []
    for raw in (text or "").splitlines() or [""]:
        lines.extend(textwrap.wrap(raw, width) or [""])
    block = max(len(line) for line in lines)
    for index, line in enumerate(lines):
        row = Text(" ", style="lx.bubble")
        row.append(g("dot") if index == 0 else " ", style="lx.bubble.dot")
        row.append(f"  {line.ljust(block)} ", style="lx.bubble")
        console.print(row)


def render_command_echo(console, text: str) -> None:
    """Eco de un comando tecleado. No es una burbuja: un comando se lo dices al
    CLI, no al modelo, y en el transcript basta con que quede el rastro."""
    console.print(f"[lx.dim2]{g('dot')}[/]  [lx.accent2]{esc(text)}[/]")


# ── Registro de trabajo del agente ──────────────────────────────────────────
#
# DISTRIBUCIÓN DEL TURNO. Lo que el agente HACE (lecturas, ediciones, diffs,
# resultados) vive dentro de un canal: una barra vertical en la columna
# izquierda que lo agrupa y lo baja de nivel. Lo que el agente DICE es lo único
# del turno sin canal, en crema y rodeado de aire — al hojear el transcript el
# ojo cae en la respuesta, no en la fontanería que la precede.
#
# El canal grueso en acento marca la línea exacta en la que se tocó el disco;
# su evidencia (el diff, el resultado) sigue en canal fino y apagado. Así un
# turno largo se resume de un vistazo: donde hay acento, algo cambió.

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


def rail(hot: bool = False) -> str:
    """Prefijo de canal para una línea del registro de trabajo (markup rich)."""
    if hot:
        return f"[lx.accent2]{g('rail_hot')}[/] "
    return f"[lx.rule]{g('rail')}[/] "


def rail_text(hot: bool = False):
    """El mismo canal como fragmento de `Text.assemble` (para el Live)."""
    return (f"{g('rail_hot') if hot else g('rail')} ", "lx.accent2" if hot else "lx.rule")


def render_action(console, verb: str, target: str = "", adds: int = 0, dels: int = 0,
                  readonly: bool = False, meta: str = "") -> None:
    """Una acción del agente dentro del canal:

        │ leyó        src/app.py                          128 líneas
        ┃ editó       src/app.py                              +12 -3

    El canal ES el marcador: las lecturas dejan rastro fino y apagado, las
    escrituras encienden el canal grueso en acento. Un solo signo por línea (el
    `●` de antes sobraba al lado de la barra, y ahora además es del usuario).
    La medida va pegada al margen derecho, en su propia columna.
    """
    from rich.text import Text

    left = Text()
    padded = f"{verb:<{VERB_WIDTH}}"
    if readonly:
        left.append(f"{g('rail')} ", style="lx.rule")
        left.append(padded, style="lx.dim")
        left.append(str(target), style="lx.dim2")
    else:
        left.append(f"{g('rail_hot')} ", style="lx.accent2")
        left.append(padded, style="bold lx.primary")
        left.append(str(target), style="lx.beige")

    right = Text()
    if adds or dels:
        right.append(f"+{adds}", style="lx.diff.add")
        right.append(" ")
        right.append(f"-{dels}", style="lx.diff.del")
    elif meta:
        right.append(str(meta), style="lx.dim2")
    console.print(two_col(left, right, row_width(console)))


def render_action_result(console, text: str, error: bool = False, meta: str = "") -> None:
    """Resultado de una acción, colgando de ella dentro del canal."""
    from rich.text import Text

    if not error:
        left = Text(f"{g('rail')} ", style="lx.rule")
        left.append(f"{g('corner')} {text}", style="lx.dim2")
        right = Text(meta, style="lx.dim2") if meta else None
        console.print(two_col(left, right, row_width(console)))
        return
    # Un fallo se pinta como una fila de diff eliminado y llega hasta el margen:
    # es lo único del registro que no puede pasar desapercibido.
    width = row_width(console)
    row = Text(f"{g('rail')} ", style="lx.rule")
    body = Text(f"{g('corner')} {text}", style="lx.err.row")
    tail = Text(f"{meta} " if meta else "", style="lx.err.row")
    limit = max(6, width - 2 - tail.cell_len)
    if body.cell_len > limit:
        body.truncate(limit, overflow="ellipsis")
    body.pad_right(max(0, limit - body.cell_len))
    console.print(row.append_text(body).append_text(tail))


def render_log_line(console, text: str, style: str = "lx.dim", meta: str = "") -> None:
    """Línea suelta del registro (salida de un comando, nota de una acción)."""
    from rich.text import Text

    left = Text(f"{g('rail')} ", style="lx.rule")
    left.append(str(text), style=style)
    right = Text(meta, style="lx.dim2") if meta else None
    console.print(two_col(left, right, row_width(console)))


def render_turn_summary(console, actions: int = 0, files: int = 0, adds: int = 0,
                        dels: int = 0, seconds: float = 0.0, hint: str = "") -> None:
    """Cierre del registro: qué ha pasado en el turno, en una línea.

    Es lo que permite hojear una sesión larga sin leer cada acción.
    """
    if not actions:
        return
    from rich.text import Text

    left = Text(f"{g('rail')} ", style="lx.rule")
    left.append(f"{actions} {'acción' if actions == 1 else 'acciones'}", style="lx.dim")
    if files:
        left.append(f" {g('sep')} ", style="lx.dim2")
        left.append(f"{files} {'archivo' if files == 1 else 'archivos'}", style="lx.dim")
    if adds or dels:
        left.append(f" {g('sep')} ", style="lx.dim2")
        left.append(f"+{adds}", style="lx.diff.add")
        left.append(" ")
        left.append(f"-{dels}", style="lx.diff.del")
    if seconds:
        left.append(f" {g('sep')} {seconds:.1f} s", style="lx.dim2")
    right = Text(hint, style="lx.dim2") if hint else None
    console.print(two_col(left, right, row_width(console)))


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
           searchable: bool | None = None, max_visible: int = MAX_VISIBLE,
           detail: str = "", rail_mode: bool = False):
    """Selector inline de la marca. Devuelve Option.value o None (Esc).

    Navegación: ↑/↓ (Ctrl+P/Ctrl+N), PgUp/PgDn, Inicio/Fin. Enter confirma,
    Esc/Ctrl+C cancela. Mouse: hover mueve la selección, clic confirma y la
    rueda desplaza. En listas largas escribir filtra (Backspace borra).
    En terminales sin soporte (Git Bash/mintty) degrada a texto plano.

    `detail` es la medida de la cabecera (a la derecha) y `rail_mode` mete el
    menú dentro del canal del registro: lo usan las aprobaciones, que
    pertenecen a la acción que las provoca y no al prompt.
    """

    options = [o if isinstance(o, Option) else Option(str(o)) for o in options]
    if not options:
        return None
    # Si el agente está trabajando hay un lector de teclado en segundo plano
    # (inputq): se le cede la terminal mientras dure el selector, o las dos
    # cosas se robarían las teclas del usuario.
    with suspend_input():
        if not ui_capable():
            return _select_plain(title, options, default)
        try:
            return _select_app(title, options, default, hint, searchable,
                               max_visible, detail, rail_mode)
        except Exception:
            # La terminal mintió sobre sus capacidades: degradar en caliente
            return _select_plain(title, options, default)


@dataclass
class SelectLayout:
    """Todo lo que el selector necesita para maquetar, sin estado de teclado."""
    title: str
    hint: str
    detail: str
    searchable: bool
    total: int
    width: int
    label_width: int
    max_visible: int
    rail_mode: bool = False


def select_rows(options: list, state: dict, layout: SelectLayout,
                handler_for=None) -> list:
    """Las filas del selector como fragmentos de prompt_toolkit.

    Función aparte (y no un closure del selector) para poder medirla: es la
    maquetación compartida por /help, /model, /config y las aprobaciones, y lo
    que la hace legible es que todo cuadre al carácter.
    """
    edge = g("edge")
    width = layout.width

    def prefix(handler=None) -> list:
        cell = ("class:sel.rail", f"{g('rail')} ") if layout.rail_mode else ("", "  ")
        return [(*cell, handler)] if handler else [cell]

    def handler(position):
        return handler_for(position) if handler_for is not None else None

    count = len(state["matches"])
    window = min(layout.max_visible, count)
    out: list = []

    # Cabecera: qué se está eligiendo y, al margen derecho, su medida.
    head = prefix() + [("class:sel.title", layout.title)]
    if state["query"]:
        head += [("class:sel.hint", "  /"), ("class:sel.query", state["query"])]
    if layout.detail:
        measure = layout.detail
    elif layout.searchable:
        measure = f"{count} de {layout.total}"
    else:
        measure = f"{layout.total} opciones"
    out += _fit(head, [("class:sel.count", measure)], width) + [("", "\n")]

    if state["top"] > 0:
        out += prefix() + [("class:sel.scroll",
                            f"  {g('ellipsis')} {state['top']} arriba"), ("", "\n")]

    for row in range(window):
        position = state["top"] + row
        opt = options[state["matches"][position]]
        mouse = handler(position)
        active = position == state["cursor"]
        label = opt.label.ljust(layout.label_width)
        badge = [("class:sel.badge", f"{opt.badge}  ", mouse)] if opt.badge else []
        line = prefix(mouse)

        if opt.disabled:
            # Cabecera de grupo: el nombre y una regla hasta el margen. Es lo
            # único que agrupa la lista, así que tiene que leerse como
            # separador y no como una opción apagada.
            line += [("class:sel.group", f"{opt.label} ", mouse)]
            used = sum(len(text) for _style, text, *_ in line)
            line += [("class:sel.rule", g("rule") * max(0, width - used), mouse)]
            out += line + [("", "\n")]
            continue

        if active:
            line += [("class:sel.edge", edge, mouse),
                     ("class:sel.row.label", f" {label}", mouse)]
            if opt.description:
                line += [("class:sel.row.desc", opt.description, mouse)]
            badge = [("class:sel.row.badge", f"{opt.badge}  ", mouse)] if opt.badge else []
        else:
            line += [("", " ", mouse), ("class:sel.option", f" {label}", mouse)]
            if opt.description:
                line += [("class:sel.option.desc", opt.description, mouse)]
        out += _fit(line, badge, width) + [("", "\n")]

    rest = count - state["top"] - window
    if rest > 0:
        out += prefix() + [("class:sel.scroll",
                            f"  {g('ellipsis')} {rest} abajo"), ("", "\n")]
    if not count:
        out += prefix() + [("class:sel.disabled", "  sin coincidencias"), ("", "\n")]

    out += prefix() + [("class:sel.hint", layout.hint), ("", "\n")]
    return out


def _fit(parts: list, right: list, width: int) -> list:
    """Rellena entre `parts` y `right` para que lo de la derecha quede al margen.

    El relleno hereda el estilo del último fragmento de la izquierda: en la fila
    marcada eso es lo que mantiene el fondo de punta a punta en vez de cortarlo
    donde acaba el texto.
    """
    used = sum(len(text) for _style, text, *_ in parts + right)
    if used < width:
        style = parts[-1][0] if parts else ""
        parts = parts + [(style, " " * (width - used))]
    return parts + right


def _select_app(title: str, options: list, default: int, hint: str,
                searchable: bool | None, max_visible: int,
                detail: str = "", rail_mode: bool = False):
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
        hint = (f"escribe para filtrar {g('sep')} ↑↓ mover {g('sep')} ↵ elegir {g('sep')} esc salir"
                if searchable else f"↑↓ mover {g('sep')} ↵ elegir {g('sep')} esc salir")

    width = inner_width()
    # Columna de etiquetas: alinea las descripciones entre filas. Se mide sobre
    # las opciones reales, no sobre las cabeceras de grupo (que no se eligen).
    labels = [len(o.label) for o in options if not o.disabled] or [8]
    label_width = min(max(labels) + 2, max(12, width // 3))
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

    layout = SelectLayout(
        title=title, hint=hint, detail=detail, searchable=searchable,
        total=total, width=width, label_width=label_width,
        max_visible=max_visible, rail_mode=rail_mode,
    )

    def fragments():
        return select_rows(options, state, layout, _mouse_handler_for)

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
    # Rastro de lo elegido. Sin el `✦` de antes: ese signo abre lo que dice
    # Lixbon y aquí quien ha decidido es el usuario.
    prefix = rail() if rail_mode else ""
    if state["accepted"] and state["matches"]:
        chosen = options[state["matches"][state["cursor"]]]
        console.print(
            f"{prefix}[lx.dim]{esc(title)}[/]  [lx.dim2]{g('sep')}[/]  "
            f"[lx.accent2]{esc(chosen.label.strip())}[/]"
        )
        return chosen.value
    console.print(f"{prefix}[lx.dim2]{esc(title)}  {g('sep')}  cancelado[/]")
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


def confirm3(question: str, detail: str = ""):
    """Aprobación de 3 vías: 'yes' | 'always' | 'no' | None.

    Va dentro del canal y con la acción a la que pertenece a la derecha: la
    pregunta cuelga del cambio que la provoca, no del prompt.
    """
    return select(
        question,
        [
            Option("Sí", "yes", "aplicar y seguir"),
            Option("Sí, y no preguntar más", "always", "auto-aprobar el resto de la sesión"),
            Option("No", "no", "rechazar y decirle al agente que no"),
        ],
        detail=detail,
        rail_mode=True,
        hint=f"↑↓ mover {g('sep')} ↵ elegir {g('sep')} esc = No",
    )


# ── Barra de estado ─────────────────────────────────────────────────────────

def fmt_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


CONTEXT_CELLS = 8


def context_bar(pct: float, width: int = CONTEXT_CELLS) -> str:
    pct = max(0.0, min(100.0, pct))
    filled = round(width * pct / 100)
    return g("bar_full") * filled + g("bar_empty") * (width - filled)


# Umbrales de la barra de contexto. El color avisa antes que el texto: cuando
# la barra se pone ámbar aún hay margen para /compact; en rojo ya no.
CTX_WARN = 60.0
CTX_FULL = 85.0

# Traducción de las clases de prompt_toolkit a estilos rich, para que la barra
# se vea igual la pinte quien la pinte (el prompt o la fila reservada).
_BAR_STYLES = {
    "class:bottom-toolbar.dot": "lx.accent2",
    "class:bottom-toolbar.ok": "lx.ok",
    "class:bottom-toolbar.warn": "lx.warn",
    "class:bottom-toolbar.err": "lx.err",
    "class:bottom-toolbar.model": "lx.beige",
    "class:bottom-toolbar.sep": "lx.dim2",
}


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
    online: bool | None = None  # None: todavía sin saberlo
    remote: bool = False        # /remote activo: manda el móvil

    # La barra se lee en dos mitades: a la izquierda QUIÉN eres y con qué
    # trabajas (no cambia casi nunca); a la derecha CUÁNTO llevas gastado (se
    # mueve en cada turno). Antes todo iba apelotonado a la izquierda y el ojo
    # tenía que recorrer la fila entera para encontrar el contexto.

    def _dot_class(self) -> str:
        if self.online is False:
            return "class:bottom-toolbar.err"
        if self.extra or self.online is None:
            return "class:bottom-toolbar.dot"
        return "class:bottom-toolbar.ok"

    def _ctx_class(self) -> str:
        if self.ctx_pct >= CTX_FULL:
            return "class:bottom-toolbar.err"
        if self.ctx_pct >= CTX_WARN:
            return "class:bottom-toolbar.warn"
        return "class:bottom-toolbar.dot"

    def _left(self) -> list[tuple[str, str]]:
        sep = ("class:bottom-toolbar.sep", f"  {g('sep')}  ")
        parts = [
            (self._dot_class(), f" {g('dot')}"),
            ("class:bottom-toolbar.model", f" {self.model or 'sin modelo'}"),
            sep,
            ("class:bottom-toolbar", self.session_label),
        ]
        if self.mode and self.mode != "ask":
            parts += [sep, ("class:bottom-toolbar.model", self.mode)]
        if self.remote:
            parts += [sep, ("class:bottom-toolbar.dot", "móvil conectado")]
        if self.extra:
            parts += [sep, ("class:bottom-toolbar.dot", self.extra)]
        return parts

    def _right(self, compact: bool = False) -> list[tuple[str, str]]:
        sep = ("class:bottom-toolbar.sep", f"  {g('sep')}  ")
        parts = [
            ("class:bottom-toolbar", "contexto "),
            (self._ctx_class(), context_bar(self.ctx_pct)),
            ("class:bottom-toolbar", f" {self.ctx_pct:.0f}%"),
            sep,
            ("class:bottom-toolbar", f"{fmt_tokens(self.tokens)} tokens"),
        ]
        if compact:
            return parts
        # Solo se anuncian los modos ACTIVOS: una barra llena de "off" es ruido.
        flags = [name for name, on in (("web", self.web), ("LIXBON.md", self.project)) if on]
        if flags:
            parts += [sep, ("class:bottom-toolbar.model", " ".join(flags))]
        if self.ctx_pct >= CTX_FULL:
            parts += [sep, ("class:bottom-toolbar.warn", "/compact")]
        parts += [sep, ("class:bottom-toolbar", f"{self.encoding} ")]
        return parts

    def _parts(self, width: int = 0, compact: bool = False) -> list[tuple[str, str]]:
        left, right = self._left(), self._right(compact)
        if not width:
            return left + [("class:bottom-toolbar.sep", f"  {g('sep')}  ")] + right
        used = sum(len(text) for _style, text in left + right)
        gap = max(2, width - used)
        return left + [("class:bottom-toolbar", " " * gap)] + right

    def pt_toolbar(self):
        """Fragmentos para bottom_toolbar de prompt_toolkit."""

        return self._parts(width=term_size()[0])

    def rich_line(self, compact: bool = False, bar: bool = False, width: int = 0):
        """La misma barra como línea rich.

        `bar=True` la viste como barra de verdad (fondo propio de borde a
        borde) para la fila reservada al pie de la terminal; sin él es una
        línea más del transcript.
        """
        from rich.text import Text

        text = Text(style="lx.bar" if bar else "")
        for style_cls, chunk in self._parts(width=width, compact=compact):
            text.append(chunk, style=_BAR_STYLES.get(style_cls, "lx.dim"))
        if width:
            # Relleno hasta el borde: sin él el fondo acabaría a media fila.
            text.pad_right(max(0, width - text.cell_len))
        return text


# ── Markdown de las respuestas ──────────────────────────────────────────────
#
# rich trae su propio look: el h1 centrado, el código en monokai y los enlaces
# en azul. Nada de eso es de la marca, así que se sustituyen los dos elementos
# que se ven: los títulos (siempre a la izquierda, como el resto del CLI) y los
# bloques de código (caja redonda en dim2 con el lenguaje sobre el borde).

_markdown_class = None


def _build_markdown_class():
    from pygments.token import Comment, Keyword, Name, Number, Operator, String, Token
    from rich.box import ROUNDED
    from rich.markdown import CodeBlock, Heading, Markdown
    from rich.panel import Panel
    from rich.style import Style
    from rich.syntax import ANSISyntaxTheme, Syntax

    code_theme = ANSISyntaxTheme({
        Token: Style(color=PALETTE["cream"]),
        Comment: Style(color=PALETTE["dim2"], italic=True),
        Keyword: Style(color=PALETTE["olive_lt"], bold=True),
        Name.Builtin: Style(color=PALETTE["olive_lt"]),
        Name.Class: Style(color=PALETTE["beige"]),
        Name.Function: Style(color=PALETTE["cream"]),
        Number: Style(color=PALETTE["beige"]),
        String: Style(color=PALETTE["beige"]),
        Operator: Style(color=PALETTE["dim"]),
    })

    class LixbonHeading(Heading):
        LEVEL_ALIGN = {f"h{level}": "left" for level in range(1, 7)}

    class LixbonCodeBlock(CodeBlock):
        def __rich_console__(self, console, options):
            code = str(self.text).rstrip()
            syntax = Syntax(code, self.lexer_name, theme=code_theme,
                            word_wrap=True, background_color=PALETTE["panel"])
            language = self.lexer_name if self.lexer_name not in ("", "text") else ""
            yield Panel(syntax, box=ROUNDED, border_style="lx.rule",
                        title=language or None, title_align="left",
                        padding=(0, 1), expand=True)

    class LixbonMarkdown(Markdown):
        elements = {**Markdown.elements,
                    "heading_open": LixbonHeading,
                    "fence": LixbonCodeBlock,
                    "code_block": LixbonCodeBlock}

    return LixbonMarkdown


def markdown(text: str):
    """El Markdown de una respuesta, con el look del CLI."""
    global _markdown_class
    if _markdown_class is None:
        _markdown_class = _build_markdown_class()
    return _markdown_class(text or "")


# ── Caja de entrada ─────────────────────────────────────────────────────────

INPUT_PLACEHOLDER = "escribe, o pulsa / para los comandos"


def input_box_kwargs() -> dict:
    """Opciones visuales de la caja de entrada, para `PromptSession`.

    Viven aquí (y no sueltas en el loop) porque el alto de la caja depende de
    la combinación exacta: con `complete_while_typing` prompt_toolkit reserva
    SIEMPRE el hueco del menú y la caja pasa de tres filas a doce. El menú lo
    abre el propio CLI cuando hay algo que completar.
    """
    return {
        # El Frame no deja margen interior: el aire entre el borde y el punto
        # lo pone el prompt, y la continuación lo repite para que una línea
        # larga siga alineada con el texto y no con el borde.
        "message": [("", " "), ("class:prompt", f"{g('dot')} ")],
        "prompt_continuation": lambda width, line_number, wrap_count: "   ",
        "placeholder": [("class:placeholder", INPUT_PLACEHOLDER)],
        "show_frame": UNICODE_OK,
        # Al enviar, la caja se borra sola y el CLI reimprime el mensaje como
        # burbuja: lo que queda en el transcript no es el prompt, es el mensaje.
        "erase_when_done": True,
        "complete_while_typing": False,
        "reserve_space_for_menu": 8,
    }


def round_frame_border() -> None:
    """Esquinas redondas en la caja del prompt (`show_frame` de prompt_toolkit).

    Su widget `Frame` tiene los caracteres de borde en atributos de clase y no
    admite pasarlos, así que se cambian antes de construir la sesión: el Frame
    los lee al montar el layout. Redondas para que la caja case con los bloques
    de código, que usan el mismo juego.
    """
    if not UNICODE_OK:
        return
    try:
        from prompt_toolkit.widgets.base import Border

        Border.TOP_LEFT, Border.TOP_RIGHT = "╭", "╮"
        Border.BOTTOM_LEFT, Border.BOTTOM_RIGHT = "╰", "╯"
    except Exception:
        pass  # sin esquinas redondas la caja sigue siendo una caja


# ── Espera / errores ────────────────────────────────────────────────────────

def spinner(text: str):
    """Context manager de espera breve (rich Status)."""
    console = make_console()
    return console.status(f"[lx.dim]{text}[/]", spinner="dots", spinner_style="lx.accent2")


def print_error(message: str) -> None:
    make_console().print(f"  [lx.err]{g('cross')}[/] [lx.primary]{esc(message)}[/]")


def print_ok(message: str) -> None:
    make_console().print(f"  [lx.ok]{g('check')}[/] [lx.primary]{esc(message)}[/]")


def print_warn(message: str) -> None:
    make_console().print(f"  [lx.warn]![/] [lx.primary]{esc(message)}[/]")


def print_note(message: str) -> None:
    make_console().print(f"    [lx.dim2]{esc(message)}[/]")


# ── Demo (comando dev oculto) ───────────────────────────────────────────────

def ui_demo() -> int:
    console = make_console()
    from pathlib import Path

    render_header(console, "2.0.0-demo", model="modelo-demo", plan="Pro",
                  workspace=Path.cwd(), branch="master", mode="agent")
    render_tips(console)
    rule(console, "conversación")
    render_user_message(console, "arregla el parseo de comillas simples en el import")
    console.print()
    render_log_line(console, f"{g('spark_alt')} pensó 3.2 s", "lx.dim2")
    render_action(console, "leyó", "src/app.py", readonly=True, meta="128 líneas")
    render_action(console, "editó", "src/app.py", adds=12, dels=3)
    console.print(f"{rail()}[lx.diff.hunk]@@ -120,6 +120,8 @@[/]")
    console.print(f"{rail()}[lx.diff.add]+    return _loads_lenient(raw)[/]")
    console.print(f"{rail()}[lx.diff.del]-    return json.loads(raw)[/]")
    render_action_result(console, "1 reemplazo aplicado", meta=f"{g('check')} 0.2 s")
    render_action_result(console, "[ERROR] la ruta queda fuera del workspace", error=True)
    render_turn_summary(console, actions=4, files=1, adds=12, dels=3, seconds=8.1,
                       hint="/diff para revisarlo")
    console.print()
    render_speaker(console, meta=f"modelo-demo  {g('sep')}  8.1 s  {g('sep')}  1.4k tokens")
    console.print(markdown(
        "El parser ya acepta las comillas simples que emite el modelo.\n\n"
        "## Qué cambié\n\n"
        "- `parse()` captura `JSONDecodeError`\n"
        "- `_loads_lenient()` normaliza y reintenta\n\n"
        "```python\n"
        "def parse(raw: str) -> dict:\n"
        "    try:\n"
        "        return json.loads(raw)\n"
        "    except json.JSONDecodeError:\n"
        "        return _loads_lenient(raw)\n"
        "```\n"
    ))
    console.print()

    choice = select("Método de acceso", [
        Option("Credenciales", "creds", "correo y contraseña", badge="actual"),
        Option("Clave de API", "key", "lixbon_sk_…"),
    ])
    console.print(f"[lx.dim]elegido:[/] {choice!r}")

    decision = confirm3("¿Aplicar este cambio?", detail=f"src/app.py {g('sep')} +12 -3")
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
"""Gestión visual de cambios de código: acción `┃ editó ruta +N -M` y diff.

El diff se dibuja como en un editor: número de línea, signo y la fila entera
con fondo (verde lo añadido, rojo lo eliminado). Es la única parte del registro
de trabajo con color de fondo, y por eso se localiza al vuelo entre decenas de
líneas de acciones.
"""
import difflib
from dataclasses import dataclass
from pathlib import Path


# Líneas iguales que se muestran alrededor de cada cambio. Con menos se pierde
# el sitio; con más, un cambio de una línea arrastra media pantalla.
DIFF_CONTEXT = 3
DIFF_MAX_ROWS = 44
NUM_MIN_WIDTH = 3


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


# ── Cálculo de filas ────────────────────────────────────────────────────────

def diff_rows(change: FileChange, context: int = DIFF_CONTEXT) -> list[tuple[str, int, int, str]]:
    """Filas `(clase, nº antiguo, nº nuevo, texto)` listas para pintar.

    Se usa SequenceMatcher y no `unified_diff` porque este último devuelve
    texto ya formateado y PIERDE los números de línea, que son justo lo que
    permite situar el cambio dentro del archivo.

    Clases: `ctx` (contexto), `del`, `add` y `gap` (tramo igual omitido).
    """
    old = change.old_text.splitlines()
    new = change.new_text.splitlines()
    opcodes = difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes()
    rows: list[tuple[str, int, int, str]] = []

    for index, (tag, i1, i2, j1, j2) in enumerate(opcodes):
        if tag == "equal":
            total = i2 - i1
            last = index == len(opcodes) - 1
            head = 0 if index == 0 else context
            tail = 0 if last else context
            # Saltar una sola línea no ahorra nada y cuesta un `…`: se muestra.
            if total > head + tail + 1:
                for k in range(head):
                    rows.append(("ctx", i1 + k + 1, j1 + k + 1, old[i1 + k]))
                # El `…` solo tiene sentido ENTRE dos tramos visibles: al abrir
                # (sin filas todavía) o al cerrar el diff no informa de nada.
                if rows and not last:
                    rows.append(("gap", 0, 0, ""))
                for k in range(total - tail, total):
                    rows.append(("ctx", i1 + k + 1, j1 + k + 1, old[i1 + k]))
            else:
                for k in range(total):
                    rows.append(("ctx", i1 + k + 1, j1 + k + 1, old[i1 + k]))
            continue
        for k in range(i1, i2):
            rows.append(("del", k + 1, 0, old[k]))
        for k in range(j1, j2):
            rows.append(("add", 0, k + 1, new[k]))
    return rows


def diff_counts(change: FileChange) -> tuple[int, int]:
    """Líneas añadidas y eliminadas."""
    old = change.old_text.splitlines()
    new = change.new_text.splitlines()
    adds = dels = 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes():
        if tag != "equal":
            dels += i2 - i1
            adds += j2 - j1
    return adds, dels


# ── Pintado ─────────────────────────────────────────────────────────────────

def render_change(console, change: FileChange,
                  max_rows: int = DIFF_MAX_ROWS) -> tuple[int, int]:
    """Imprime la acción (`┃ editó  ruta  +12 -3`) y el diff con números.

    Devuelve las líneas añadidas y eliminadas: quien llama las necesita para el
    resumen del turno y recalcularlas cuesta otro diff completo del archivo.
    """
    if change.kind == "command":
        render_action(console, change.verb, change.detail)
        return (0, 0)
    if change.kind == "rename":
        render_action(console, change.verb, f"{change.path} {g('arrow')} {change.detail}")
        return (0, 0)
    if change.kind == "mkdir":
        render_action(console, change.verb, change.path)
        return (0, 0)

    adds, dels = diff_counts(change)
    render_action(console, change.verb, change.path, adds=adds, dels=dels)
    render_diff(console, diff_rows(change), max_rows=max_rows)
    return (adds, dels)


def render_diff(console, rows: list[tuple[str, int, int, str]],
                max_rows: int = DIFF_MAX_ROWS) -> None:
    """Pinta las filas de un diff dentro del canal del registro de trabajo."""
    from rich.cells import set_cell_size
    from rich.text import Text


    if not rows:
        return
    numbers = [max(old_no, new_no) for _, old_no, new_no, _ in rows]
    num_width = max(NUM_MIN_WIDTH, len(str(max(numbers) if numbers else 0)))
    # El canal se come dos columnas; el resto es la fila coloreada, que llega
    # hasta el margen derecho para que el fondo forme un bloque limpio.
    width = max(20, console.width - PAD_LEFT - PAD_RIGHT - 2)
    code_width = max(8, width - num_width - 2)

    shown = rows[:max_rows]
    for kind, old_no, new_no, text in shown:
        if kind == "gap":
            console.print(f"{rail()}[lx.dim2]{' ' * (num_width + 2)}{g('ellipsis')}[/]")
            continue
        if kind == "add":
            back, sign, sign_fg = PALETTE["diff_add_bg"], "+", PALETTE["diff_add_fg"]
        elif kind == "del":
            back, sign, sign_fg = PALETTE["diff_del_bg"], "-", PALETTE["diff_del_fg"]
        else:
            back, sign, sign_fg = "", " ", PALETTE["dim2"]

        number = str(new_no or old_no)
        # Los tabuladores descuadran el bloque de color: el fondo se pinta por
        # celdas y la terminal expande el tabulador a un ancho que rich no sabe.
        body = set_cell_size(text.replace("\t", "    "), code_width)
        on = f" on {back}" if back else ""

        line = Text()
        line.append(g("rail") + " ", style=PALETTE["dim2"])
        line.append(f"{number:>{num_width}} ", style=f"{PALETTE['dim2']}{on}")
        line.append(sign, style=f"{sign_fg}{on}")
        line.append(body, style=f"{PALETTE['cream'] if back else PALETTE['dim']}{on}")
        console.print(line)

    if len(rows) > max_rows:

        left = Text(f"{g('rail')} {' ' * (num_width + 2)}{g('ellipsis')}", style=PALETTE["dim2"])
        right = Text(f"{len(rows) - max_rows} líneas más", style=PALETTE["dim2"])
        console.print(two_col(left, right, row_width(console)))

# ──────────────────────────────────────────────────────────────────────────
# módulo: lixbon_cli/clipboard.py
# ──────────────────────────────────────────────────────────────────────────
"""Pegar imágenes del portapapeles sin dependencias externas.

El CLI se distribuye como UN archivo que se autoinstala solo prompt_toolkit y
rich, así que aquí no se puede usar Pillow: el DIB de Windows se decodifica a
mano y el PNG se escribe con `zlib`, que es stdlib. Son ~80 líneas y evitan
arrastrar una dependencia binaria de 3 MB al instalador.
"""
import os
import struct
import subprocess
import sys
import time
import zlib
from pathlib import Path

# Cuántos pegados se conservan en disco. Son capturas de pantalla: pesan y no
# vuelven a hacer falta una vez el modelo las ha visto.
PASTE_KEEP = 20

CF_DIB = 8
CF_HDROP = 15


def paste_dir(home: Path) -> Path:
    target = home / "pastes"
    target.mkdir(parents=True, exist_ok=True)
    return target


def _prune(folder: Path) -> None:
    try:
        files = sorted(folder.glob("paste-*.png"), key=lambda p: p.stat().st_mtime)
    except OSError:
        return
    for old in files[:-PASTE_KEEP]:
        try:
            old.unlink()
        except OSError:
            pass


def _new_path(folder: Path) -> Path:
    return folder / f"paste-{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid() % 1000:03d}.png"


# ── PNG a mano ──────────────────────────────────────────────────────────────

def _chunk(kind: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + kind + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))


def encode_png(width: int, height: int, rgb_rows: list[bytes]) -> bytes:
    """PNG RGB de 8 bits a partir de filas ya en orden superior→inferior."""
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    raw = b"".join(b"\x00" + row for row in rgb_rows)  # filtro 0 por fila
    return (b"\x89PNG\r\n\x1a\n"
            + _chunk(b"IHDR", header)
            + _chunk(b"IDAT", zlib.compress(raw, 6))
            + _chunk(b"IEND", b""))


def dib_to_png(dib: bytes) -> bytes | None:
    """Convierte el CF_DIB del portapapeles de Windows a PNG.

    Solo 24 y 32 bits sin comprimir, que es lo que dejan las capturas de
    pantalla y los editores de imagen. El canal alfa SE DESCARTA a propósito:
    muchas apps copian 32 bits con alfa a cero y un PNG RGBA salido de ahí se
    vería completamente transparente (el modelo no vería nada).
    """
    if len(dib) < 40:
        return None
    header_size, width, height, _planes, bits, compression = struct.unpack_from("<IiiHHI", dib, 0)
    if header_size < 40 or bits not in (24, 32) or compression not in (0, 3):
        return None
    clr_used = struct.unpack_from("<I", dib, 32)[0]
    offset = header_size + clr_used * 4
    if compression == 3 and header_size == 40:
        offset += 12  # máscaras BI_BITFIELDS, que aquí no hacen falta
    bottom_up = height > 0
    height = abs(height)
    if width <= 0 or height <= 0:
        return None

    stride = ((width * bits + 31) // 32) * 4
    if len(dib) < offset + stride * height:
        return None

    step = bits // 8
    rows: list[bytes] = []
    for y in range(height):
        start = offset + y * stride
        line = dib[start:start + width * step]
        # El DIB guarda BGR(A); PNG quiere RGB.
        rows.append(bytes(b for x in range(0, len(line), step)
                          for b in (line[x + 2], line[x + 1], line[x])))
    if bottom_up:
        rows.reverse()
    return encode_png(width, height, rows)


# ── Portapapeles por plataforma ─────────────────────────────────────────────

def _windows_clipboard_image(folder: Path) -> tuple[Path | None, str]:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    shell32 = ctypes.windll.shell32
    # SIN restype explícito, ctypes asume `int` (32 bits) y en un Windows de 64
    # bits TRUNCA los handles y punteros: GlobalSize devolvía 0 y la imagen
    # llegaba vacía. Es el fallo clásico de hablar con la Win32 API por ctypes.
    user32.GetClipboardData.restype = wintypes.HANDLE
    user32.GetClipboardData.argtypes = [wintypes.UINT]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [wintypes.HANDLE]
    kernel32.GlobalUnlock.argtypes = [wintypes.HANDLE]
    kernel32.GlobalSize.restype = ctypes.c_size_t
    kernel32.GlobalSize.argtypes = [wintypes.HANDLE]
    shell32.DragQueryFileW.argtypes = [wintypes.HANDLE, wintypes.UINT,
                                       wintypes.LPWSTR, wintypes.UINT]

    def _read(handle) -> bytes:
        size = kernel32.GlobalSize(handle)
        pointer = kernel32.GlobalLock(handle)
        if not pointer or not size:
            return b""
        try:
            return ctypes.string_at(pointer, size)
        finally:
            kernel32.GlobalUnlock(handle)

    # Muchas apps (navegadores, capturas, editores) publican también un PNG ya
    # hecho: usarlo evita decodificar el DIB y conserva la calidad original.
    png_format = user32.RegisterClipboardFormatW("PNG")

    if not user32.OpenClipboard(None):
        return None, "no se pudo abrir el portapapeles"
    try:
        # Un archivo copiado en el Explorador vale igual que un mapa de bits, y
        # además conserva el formato original (mejor que reencodificar).
        if user32.IsClipboardFormatAvailable(CF_HDROP):
            handle = user32.GetClipboardData(CF_HDROP)
            if handle:
                count = shell32.DragQueryFileW(handle, 0xFFFFFFFF, None, 0)
                for index in range(count):
                    length = shell32.DragQueryFileW(handle, index, None, 0)
                    buffer = ctypes.create_unicode_buffer(length + 1)
                    shell32.DragQueryFileW(handle, index, buffer, length + 1)
                    candidate = Path(buffer.value)
                    if candidate.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"):
                        return candidate, ""

        data = b""
        if png_format and user32.IsClipboardFormatAvailable(png_format):
            data = _read(user32.GetClipboardData(png_format))
            if data[:8] == b"\x89PNG\r\n\x1a\n":
                target = _new_path(folder)
                target.write_bytes(data)
                _prune(folder)
                return target, ""

        if not user32.IsClipboardFormatAvailable(CF_DIB):
            return None, "el portapapeles no tiene ninguna imagen"
        dib = _read(user32.GetClipboardData(CF_DIB))
    finally:
        user32.CloseClipboard()

    if not dib:
        return None, "no se pudo leer la imagen del portapapeles"
    png = dib_to_png(dib)
    if png is None:
        return None, "formato de imagen no soportado (usa 24 o 32 bits sin comprimir)"
    target = _new_path(folder)
    target.write_bytes(png)
    _prune(folder)
    return target, ""


def _command_clipboard_image(folder: Path) -> tuple[Path | None, str]:
    """Linux/macOS: se delega en la herramienta del sistema, si está."""
    attempts = [
        (["wl-paste", "--no-newline", "--type", "image/png"], ".png"),
        (["xclip", "-selection", "clipboard", "-t", "image/png", "-o"], ".png"),
        (["pngpaste", "-"], ".png"),
    ]
    missing = True
    for command, _suffix in attempts:
        try:
            proc = subprocess.run(command, capture_output=True, timeout=10)
        except (FileNotFoundError, OSError):
            continue
        except subprocess.TimeoutExpired:
            missing = False
            continue
        missing = False
        if proc.returncode == 0 and proc.stdout[:8] == b"\x89PNG\r\n\x1a\n":
            target = _new_path(folder)
            target.write_bytes(proc.stdout)
            _prune(folder)
            return target, ""
    if missing:
        return None, "instala wl-clipboard, xclip o pngpaste para pegar imágenes"
    return None, "el portapapeles no tiene ninguna imagen"


def paste_image(home: Path) -> tuple[Path | None, str]:
    """Guarda la imagen del portapapeles y devuelve (ruta, error).

    Nunca lanza: pegar es un atajo, y que falle no puede tumbar el prompt.
    """
    try:
        folder = paste_dir(home)
        if sys.platform == "win32":
            return _windows_clipboard_image(folder)
        return _command_clipboard_image(folder)
    except Exception as exc:
        return None, f"no se pudo pegar la imagen ({exc})"

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
# módulo: lixbon_cli/context.py
# ──────────────────────────────────────────────────────────────────────────
"""Presupuesto de la ventana de contexto del turno de agente.

Por qué existe: en modo agent el historial NO son solo los mensajes del chat;
son también los resultados de cada herramienta. Un `read_file` puede aportar
100 000 caracteres y un `run_command` varios miles, así que en pocos pasos el
prompt supera el `num_ctx` que se le pide a Ollama.

Y cuando eso pasa Ollama no da error: descarta el principio del prompt, que es
justo donde viven el system prompt y las definiciones de herramientas. El
modelo se queda sin instrucciones y sin tools, "razona" un rato (el tiempo de
reprocesar toda la ventana, decenas de segundos) y devuelve una respuesta vacía
o sin ninguna llamada. El turno termina en silencio y el agente parece
congelado — y sigue igual con el mensaje siguiente, porque el historial no ha
adelgazado.

Aquí se resuelve en dos niveles:

1. `clip_tool_output` recorta lo que un resultado de herramienta APORTA AL
   MODELO (el usuario sigue viendo la salida completa en pantalla).
2. `fit_history` poda mensajes enteros —por fronteras seguras, sin romper el
   round-trip de tool-calling— hasta que el prompt cabe en el presupuesto.
"""

# Fracción de la ventana que puede ocupar el PROMPT. El resto queda para que el
# modelo genere: sin margen, un prompt que "cabe justo" deja al modelo sin sitio
# para responder y la respuesta sale vacía o truncada.
PROMPT_BUDGET_RATIO = 0.65

# Estimación conservadora. El código y el JSON de las herramientas tienen peor
# ratio que la prosa (~3 chars/token frente a ~4), y quedarse corto en la
# estimación es lo que provoca el desbordamiento que este módulo evita.
CHARS_PER_TOKEN = 3.2

# Lo que un resultado de herramienta puede aportar al contexto del modelo.
# Suficiente para que razone sobre un archivo o la salida de un comando, lejos
# del orden de magnitud que reventaba la ventana.
MAX_TOOL_OUTPUT_CHARS = 6000

# Los resultados que ya no son el último paso valen aún menos: el modelo suele
# necesitar el detalle solo del turno que está resolviendo.
MAX_OLD_TOOL_OUTPUT_CHARS = 1200

# Mensajes recientes que nunca se podan (el paso en curso y su contexto
# inmediato): sin ellos el modelo pierde el hilo de lo que acaba de hacer.
KEEP_RECENT = 6

CLIP_MARK = "\n…[recortado: {omitted} caracteres omitidos]…\n"
PRUNE_NOTE = ("[Nota del sistema: los pasos más antiguos de este turno se han "
              "recortado para no desbordar la ventana de contexto. Si necesitas "
              "algo de un archivo que ya leíste, vuelve a leerlo.]")


def estimate_tokens(messages: list[dict]) -> int:
    """Tokens aproximados que ocupa una lista de mensajes.

    Incluye el JSON de los `tool_calls`: en modo nativo el argumento `content`
    de un write_file viaja ahí y es lo más pesado del mensaje.
    """
    chars = 0
    for m in messages:
        chars += len(m.get("content") or "")
        calls = m.get("tool_calls")
        if calls:
            chars += sum(len(str(c)) for c in calls)
        # Cada mensaje paga además los tokens del template (rol, separadores).
        chars += 16
    return int(chars / CHARS_PER_TOKEN)


def tools_tokens(tools: list[dict] | None) -> int:
    """Coste de las definiciones de herramientas, que Ollama inyecta en el
    template. Son ~700 tokens que hay que descontar del presupuesto."""
    if not tools:
        return 0
    return int(len(str(tools)) / CHARS_PER_TOKEN)


def clip_tool_output(text: str, limit: int = MAX_TOOL_OUTPUT_CHARS) -> str:
    """Recorta por el MEDIO un resultado de herramienta.

    Por el medio y no por el final a propósito: en un `read_file` importa el
    principio (imports, cabecera) y en un `run_command` importa el final (el
    error y el código de salida). Cortando por el medio se conservan ambos.
    """
    if not text or len(text) <= limit:
        return text
    head = int(limit * 0.6)
    tail = limit - head
    omitted = len(text) - limit
    return text[:head] + CLIP_MARK.format(omitted=omitted) + text[-tail:]


def _is_tool_result(msg: dict) -> bool:
    """¿El mensaje es el resultado de una herramienta?

    Cubre los dos protocolos: `role="tool"` (tool-calling nativo) y el mensaje
    de usuario `TOOL_RESULT …` (protocolo de texto).
    """
    if msg.get("role") == "tool":
        return True
    return (msg.get("role") == "user"
            and (msg.get("content") or "").lstrip().startswith("TOOL_RESULT"))


def shrink_old_results(messages: list[dict],
                       keep_recent: int = KEEP_RECENT,
                       limit: int = MAX_OLD_TOOL_OUTPUT_CHARS) -> list[dict]:
    """Recorta más los resultados de herramienta que ya no son recientes.

    Es la poda barata: conserva la ESTRUCTURA del turno (el modelo sigue viendo
    qué hizo y en qué orden) y solo adelgaza el detalle que ya no necesita.
    """
    if len(messages) <= keep_recent:
        return messages
    cut = len(messages) - keep_recent
    out = []
    for i, msg in enumerate(messages):
        if i < cut and _is_tool_result(msg):
            content = msg.get("content") or ""
            if len(content) > limit:
                msg = {**msg, "content": clip_tool_output(content, limit)}
        out.append(msg)
    return out


def _safe_start(messages: list[dict], index: int) -> int:
    """Primer índice ≥ `index` en el que se puede empezar sin dejar huérfano un
    resultado de herramienta.

    Un `role="tool"` (o un `TOOL_RESULT`) suelto al principio, sin el assistant
    que lo pidió, rompe el template del modelo — que es otra forma de acabar con
    una respuesta vacía.
    """
    while index < len(messages) and _is_tool_result(messages[index]):
        index += 1
    return index


def fit_history(messages: list[dict], budget_tokens: int,
                keep_recent: int = KEEP_RECENT) -> tuple[list[dict], bool]:
    """Devuelve (historial que cabe en el presupuesto, si hubo que podar).

    Estrategia, de menos a más destructiva:
      1. recortar el detalle de los resultados antiguos,
      2. soltar los mensajes más antiguos conservando SIEMPRE la petición
         original del usuario (sin ella el modelo olvida qué se le pidió),
      3. como último recurso, quedarse con los últimos mensajes.

    El primer mensaje se conserva aparte y se marca con una nota, para que el
    modelo sepa que el hueco es un recorte y no que nunca pasó nada.
    """
    if budget_tokens <= 0 or not messages:
        return messages, False

    working = shrink_old_results(messages, keep_recent)
    if estimate_tokens(working) <= budget_tokens:
        return working, working is not messages and working != messages

    # El primer mensaje del usuario es la petición que se está resolviendo:
    # viaja siempre, aunque todo lo de en medio se caiga.
    first = working[0] if working and working[0].get("role") == "user" else None
    head = [first, {"role": "user", "content": PRUNE_NOTE}] if first else []
    head_tokens = estimate_tokens(head)

    # Se avanza el corte hasta que el resto quepa.
    start = 1 if first else 0
    while start < len(working):
        start = _safe_start(working, start)
        tail = working[start:]
        if not tail:
            break
        if head_tokens + estimate_tokens(tail) <= budget_tokens:
            return head + tail, True
        start += 1

    # Nada cabe con la cabecera: se salva lo último, que es lo que el modelo
    # necesita para dar el siguiente paso.
    tail = working[-keep_recent:] if len(working) > keep_recent else working
    tail = tail[_safe_start(tail, 0):]
    return ([{"role": "user", "content": PRUNE_NOTE}] + tail) if tail else working, True


def prompt_budget(context_window: int, tools: list[dict] | None = None,
                  system_tokens: int = 0) -> int:
    """Tokens disponibles para el HISTORIAL, descontando lo que ya ocupan el
    system prompt y las definiciones de herramientas."""
    total = int(max(context_window, 1) * PROMPT_BUDGET_RATIO)
    return max(total - tools_tokens(tools) - system_tokens, 512)

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
import time
from pathlib import Path


# Tope de pasos por turno. Es un cortafuegos contra bucles, NO un presupuesto de
# trabajo: una tarea real (leer varios archivos, editarlos, ejecutar los tests y
# corregir) se come 12 pasos enseguida, y antes el turno moría ahí sin decir
# nada. Ahora hay margen de sobra y, si se alcanza, se dice por qué.
MAX_AGENT_STEPS = 40

# Llamadas idénticas seguidas que se toleran antes de romper el bucle: un modelo
# atascado repite la misma herramienta con los mismos argumentos indefinidamente.
MAX_REPEATED_CALLS = 3

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

# Los modelos thinking a veces agotan el turno razonando y no llegan a emitir
# nada. Repetir la petición tal cual les hace volver a razonar lo mismo; pedir
# el paso CONCRETO y prohibir el preámbulo es lo que los desatasca.
NO_OUTPUT_PROMPT = (
    "Has razonado pero no has emitido ninguna respuesta ni ninguna llamada a "
    "herramienta. NO vuelvas a razonar: ejecuta AHORA el siguiente paso llamando "
    "a la herramienta que toque, o responde con el resumen final si ya no queda "
    "nada por hacer."
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

def dump_empty_turn(messages: list[dict], reasoning: str, raw: str) -> str:
    """Guarda un turno sin respuesta en ~/.lixbon/empty-turns/ para poder verlo.

    Un turno vacío no deja rastro por definición: sin esto, saber POR QUÉ el
    modelo no dijo nada exige reproducirlo a ciegas. Solo se activa con
    LIXBON_DEBUG=1, y guarda lo que se envió junto a lo que llegó.
    """
    import os
    import time as _time
    from pathlib import Path as _Path

    if os.environ.get("LIXBON_DEBUG") != "1":
        return ""
    try:
        folder = _Path.home() / ".lixbon" / "empty-turns"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{_time.strftime('%Y%m%d-%H%M%S')}.json"
        path.write_text(json.dumps({
            "sent": messages,
            "reasoning": reasoning,
            "content": raw,
        }, ensure_ascii=False, indent=1), encoding="utf-8")
        return str(path)
    except Exception:
        return ""


def _call_signature(call: dict) -> str:
    """Huella de una llamada para detectar que el modelo se repite."""
    return json.dumps({"t": call.get("tool", ""), "a": call.get("args", {})},
                      sort_keys=True, ensure_ascii=False)[:400]


def run_agent_turn(history: list[dict], workspace: Path, session: dict,
                   stream_assistant) -> tuple[str, list[dict]]:
    """Ejecuta un turno de agente con aprobación interactiva.

    - `session`: estado mutable con `auto_approve: bool`, `native_tools: bool`
      (este último lo apaga la app si el modelo no soporta tools nativas) y
      `context_window: int` (la ventana que se le pide a Ollama).
    - `stream_assistant(messages, tools) -> (texto, tool_calls_nativos)`: lo
      aporta la app; muestra el texto del modelo en vivo y devuelve la respuesta
      completa junto con los tool_calls estructurados que haya emitido.
    Devuelve (respuesta_final, history_actualizado).

    El turno solo termina cuando el modelo deja de pedir herramientas, cuando se
    detecta que está atascado o cuando se agota el tope de pasos — y en los dos
    últimos casos lo dice. Nunca se queda callado a mitad de trabajo.
    """
    console = make_console()
    working = history[:]
    window = int(session.get("context_window") or 8192)

    nudged = False
    empty_retries = 0     # respuestas vacías consecutivas ya reintentadas
    last_signature = ""   # última tanda de llamadas, para detectar bucles
    repeated = 0
    pruned_warned = False

    for step in range(MAX_AGENT_STEPS):
        # El flag puede apagarse a mitad de turno (fallback si el modelo no
        # soporta tools), así que se relee en cada paso.
        native = session.get("native_tools", True)
        system_msg = {"role": "system", "content": (
            build_native_system_prompt(workspace) if native
            else build_agent_system_prompt(workspace))}
        tools = TOOL_SCHEMAS if native else None

        body = working if native else sanitize_for_plain_chat(working)
        # El prompt tiene que caber en la ventana CON el system prompt y las
        # definiciones de herramientas dentro: si se pasa, Ollama descarta el
        # principio (justo esos dos) y el modelo responde vacío. Podar aquí es
        # lo que impide que el agente se congele a los pocos minutos.
        budget = prompt_budget(window, tools, estimate_tokens([system_msg]))
        body, pruned = fit_history(body, budget)
        if pruned and not pruned_warned:
            pruned_warned = True
            print_note("La conversación llenaba la ventana de contexto: se han "
                       "recortado los pasos más antiguos para poder seguir.")

        messages = [system_msg] + body
        raw, native_calls = stream_assistant(messages, tools)
        # Sin el corte, el modelo "ejecutaría" resultados que él mismo inventó
        assistant = truncate_fabricated(raw)

        if native_calls:
            empty_retries = 0
            signature = "|".join(_call_signature(native_call_to_internal(c)) for c in native_calls)
            repeated = repeated + 1 if signature == last_signature else 0
            last_signature = signature
            if repeated >= MAX_REPEATED_CALLS:
                return ("Me estaba repitiendo con la misma acción sin avanzar, así que "
                        "he parado. Dime cómo seguir."), working
            working.append({"role": "assistant", "content": assistant, "tool_calls": native_calls})
            for call in native_calls:
                internal = native_call_to_internal(call)
                tool_name = internal["tool"]
                result = _approve_and_run(console, workspace, session, tool_name, internal["args"])
                working.append({
                    "role": "tool",
                    # Al modelo le va una versión acotada del resultado; el
                    # usuario ha visto la salida completa en pantalla. Un
                    # read_file de 100 000 caracteres desbordaba la ventana él solo.
                    "content": clip_tool_output(result),
                    "tool_call_id": str(call.get("id") or ""),
                    "name": tool_name,
                })
            continue

        tool_calls = extract_all_tool_calls(assistant)

        if not tool_calls and not assistant.strip():
            # Sin texto y sin llamadas. Antes de darlo por perdido hay que mirar
            # el RAZONAMIENTO: los modelos thinking (qwen3.5 y compañía) muchas
            # veces deciden la herramienta dentro del bloque de pensamiento y la
            # escriben ahí, así que Ollama la manda por el canal `thinking` y no
            # como content ni como tool_call. Descartarlo era ver al agente
            # "pensar 12 s y no hacer nada" con el contexto casi vacío.
            reasoning = str(session.get("last_reasoning") or "")
            dumped = dump_empty_turn(messages, reasoning, raw)
            if dumped:
                print_note(f"Turno sin respuesta volcado en {dumped}")
            rescued = extract_all_tool_calls(reasoning)
            if rescued:
                tool_calls = rescued
                # El historial guarda la llamada rescatada, no un turno vacío:
                # el modelo tiene que ver lo que pidió para leer bien el resultado.
                assistant = "\n".join(
                    json.dumps({"tool": c.get("tool", ""), "args": c.get("args", {})},
                               ensure_ascii=False)
                    for c in rescued)
                render_action_result(console, "llamada recuperada del razonamiento")
            elif empty_retries < 2:
                empty_retries += 1
                if reasoning:
                    # Razonó pero no dijo nada: no es contexto, es que se quedó
                    # pensando. Se le pide el paso concreto, sin tocar el historial.
                    working.append({"role": "user", "content": NO_OUTPUT_PROMPT})
                    print_note("El modelo se quedó pensando sin responder; le pido "
                               "que ejecute el siguiente paso.")
                else:
                    # Nada en absoluto (ni razonamiento): ahí sí huele a ventana
                    # desbordada. Se recorta lo que se ENVÍA, no el historial:
                    # podar `working` borraba la conversación del usuario.
                    print_note("El modelo no devolvió nada; libero contexto y lo reintento.")
                    working = shrink_old_results(working, keep_recent=2)
                continue
            else:
                return ("Me quedé sin respuesta del modelo: razona pero no llega a "
                        "responder. Prueba con /model a uno sin «thinking», o /new "
                        "para empezar con el contexto limpio."), working
        empty_retries = 0

        working.append({"role": "assistant", "content": assistant})

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

        signature = "|".join(_call_signature(c) for c in tool_calls)
        repeated = repeated + 1 if signature == last_signature else 0
        last_signature = signature
        if repeated >= MAX_REPEATED_CALLS:
            return ("Me estaba repitiendo con la misma acción sin avanzar, así que "
                    "he parado. Dime cómo seguir."), working

        combined_results = []
        for group in _group_reads(tool_calls):
            if len(group) > 1:
                results = _run_read_group(console, workspace, session, group)
            else:
                call = group[0]
                results = [_approve_and_run(console, workspace, session,
                                            call.get("tool", ""), call.get("args", {}))]
            for call, result in zip(group, results):
                combined_results.append(
                    f"TOOL_RESULT {call.get('tool', '')}: {clip_tool_output(result)}")

        working.append({"role": "user", "content": "\n".join(combined_results)})

    return (f"He llegado al tope de {MAX_AGENT_STEPS} pasos en un mismo turno y paro aquí "
            "para no seguir a ciegas. Dime «continúa» si quieres que siga desde donde iba."), working


def turn_stats(session: dict) -> dict:
    """Contadores del turno en curso, para el resumen que lo cierra."""
    return session.setdefault(
        "turn_stats", {"actions": 0, "files": set(), "adds": 0, "dels": 0})


# Medida de una lectura: se saca del propio resultado, así que la acción se
# imprime DESPUÉS de ejecutar. Una lectura no pide permiso, así que el orden en
# pantalla es el mismo y a cambio la columna de la derecha dice algo.
def _read_meta(tool_name: str, result: str) -> str:
    lines = result.count("\n") + 1 if result else 0
    if tool_name == "read_file":
        return f"{lines} líneas"
    if tool_name == "search":
        return f"{lines} coincidencia" + ("" if lines == 1 else "s")
    if tool_name == "list_files":
        return f"{lines} entrada" + ("" if lines == 1 else "s")
    return ""


def _group_reads(tool_calls: list[dict]) -> list[list[dict]]:
    """Parte las llamadas de un paso en grupos: las lecturas seguidas van juntas.

    Cuando el modelo pide tres archivos de golpe, tres líneas iguales no dicen
    más que una: `leyó  3 archivos` y los nombres debajo.
    """
    groups: list[list[dict]] = []
    for call in tool_calls:
        if call.get("tool") == "read_file" and groups and groups[-1][0].get("tool") == "read_file":
            groups[-1].append(call)
        else:
            groups.append([call])
    return groups


def _run_read_group(console, workspace: Path, session: dict, calls: list[dict]) -> list[str]:
    remote = session.get("remote")
    stats = turn_stats(session)
    results: list[str] = []
    names: list[str] = []
    lines = 0
    for call in calls:
        args = call.get("args", {})
        label = str(args.get("path") or ".")
        result, failed, _elapsed = _execute(workspace, "read_file", args)
        stats["actions"] += 1
        results.append(result)
        if failed:
            render_action(console, TOOL_VERB["read_file"], label, readonly=True)
            render_action_result(console, result.split("\n", 1)[0][:120], error=True)
        else:
            names.append(label.rsplit("/", 1)[-1])
            lines += result.count("\n") + 1
        if remote:
            remote.emit("tool_use", tool="read_file", summary=label, readonly=True)
            remote.emit("tool_result", tool="read_file",
                        result=result[:REMOTE_RESULT_CHARS], error=failed)
    if names:
        render_action(console, TOOL_VERB["read_file"], f"{len(names)} archivos",
                      readonly=True, meta=f"{lines} líneas")
        listed = f" {g('sep')} ".join(names)
        render_log_line(console, " " * VERB_WIDTH + listed, "lx.dim2")
    return results


def _approve_and_run(console, workspace: Path, session: dict, tool_name: str, args: dict) -> str:
    # Con /remote activo, la sesión se maneja desde el móvil/web: los eventos
    # de herramientas viajan al controller y las aprobaciones se piden allí
    # (localmente no hay nadie al teclado durante el takeover).
    remote = session.get("remote")
    stats = turn_stats(session)

    if tool_name in READ_ONLY_TOOLS:
        # Solo lectura: se ejecuta sin preguntar, con rastro discreto.
        label = args.get("path") or args.get("pattern") or "."
        result, failed, _elapsed = _execute(workspace, tool_name, args)
        stats["actions"] += 1
        render_action(console, TOOL_VERB.get(tool_name, tool_name), str(label),
                     readonly=True, meta="" if failed else _read_meta(tool_name, result))
        if failed:
            render_action_result(console, result.split("\n", 1)[0][:120], error=True)
        if remote:
            remote.emit("tool_use", tool=tool_name, summary=str(label), readonly=True)
            remote.emit("tool_result", tool=tool_name,
                        result=result[:REMOTE_RESULT_CHARS], error=failed)
        return result

    try:
        change = compute_change(workspace, tool_name, args, resolve_safe_path)
    except Exception:
        change = None
    counts = (0, 0)
    if change is not None:
        counts = render_change(console, change)
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
                decision = confirm3("¿Ejecutar este comando?",
                                    detail=_args_summary(tool_name, args))
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
            detail = change.path if change is not None else _args_summary(tool_name, args)
            if counts != (0, 0):
                detail = f"{detail} {g('sep')} +{counts[0]} -{counts[1]}"
            decision = confirm3("¿Aplicar este cambio?", detail=detail)
            if decision == "always":
                session["auto_approve"] = True
            elif decision in ("no", None):
                render_action_result(console, "rechazado por el usuario", error=True)
                return "Ejecución cancelada por el usuario"

    stats["actions"] += 1
    if change is not None and change.kind != "command":
        stats["files"].add(change.path)
        stats["adds"] += counts[0]
        stats["dels"] += counts[1]
    return _run(console, workspace, tool_name, args, remote)


def _execute(workspace: Path, tool_name: str, args: dict) -> tuple[str, bool, float]:
    """Ejecuta una herramienta. Devuelve (resultado, ha fallado, segundos)."""
    started = time.monotonic()
    try:
        result = execute_tool_call(workspace, tool_name, args)
    except Exception as exc:
        result = f"[ERROR] {exc}"
    failed = (result.startswith("[ERROR]") or result.startswith("[TIMEOUT]")
              or (result.startswith("[EXIT ") and not result.startswith("[EXIT 0]")))
    return result, failed, time.monotonic() - started


def _run(console, workspace: Path, tool_name: str, args: dict, remote=None) -> str:
    result, failed, elapsed = _execute(workspace, tool_name, args)
    if tool_name not in READ_ONLY_TOOLS or failed:
        # El tiempo va en el resultado y no en la acción: la línea de la acción
        # se imprime antes de ejecutar, porque es la que se aprueba.
        meta = f"{g('cross') if failed else g('check')} {elapsed:.1f} s" if elapsed >= 0.1 else ""
        render_action_result(console, result.split("\n", 1)[0][:120],
                            error=failed, meta=meta)
    if remote:
        remote.emit("tool_result", tool=tool_name,
                    result=result[:REMOTE_RESULT_CHARS], error=failed)
    return result

# ──────────────────────────────────────────────────────────────────────────
# módulo: lixbon_cli/sessions.py
# ──────────────────────────────────────────────────────────────────────────
"""Historial persistente de sesiones del CLI (~/.lixbon/sessions/).

Antes no existía: `/history` listaba los mensajes de la sesión EN CURSO para
reenviar uno, y al cerrar el CLI se perdía todo. Cada conversación es ahora un
archivo propio con sus mensajes, sus llamadas a herramientas y sus fechas, y se
puede volver a abrir tal cual — igual que en Claude, ChatGPT o Gemini.

Formato: un JSON por sesión más un `index.json` con las cabeceras, para poder
listar sin abrir (ni cargar en memoria) conversaciones enteras. El índice es
caché reconstruible: si se pierde o se corrompe, `rebuild_index()` lo rehace
leyendo los archivos.
"""
import json
import time
import uuid
from pathlib import Path

# Tope por mensaje al guardar: un `read_file` de un archivo grande no tiene por
# qué ocupar megas en disco para siempre. Es mucho más de lo que se le manda al
# modelo, así que el transcript se lee entero sin sorpresas.
MAX_STORED_CHARS = 20000

MAX_SESSIONS = 200  # las más antiguas se van borrando solas


def _now() -> float:
    return time.time()


def new_session_id() -> str:
    return str(uuid.uuid4())


def relative_time(timestamp: float) -> str:
    """«ahora», «hace 5 horas», «hace 2 días» — como en cualquier app de chat."""
    delta = max(0, int(_now() - (timestamp or 0)))
    if delta < 60:
        return "ahora"
    if delta < 3600:
        minutes = delta // 60
        return f"hace {minutes} min"
    if delta < 86400:
        hours = delta // 3600
        return f"hace {hours} hora{'s' if hours > 1 else ''}"
    days = delta // 86400
    if days < 30:
        return f"hace {days} día{'s' if days > 1 else ''}"
    months = days // 30
    if months < 12:
        return f"hace {months} mes{'es' if months > 1 else ''}"
    years = days // 365
    return f"hace {years} año{'s' if years > 1 else ''}"


def _trim(messages: list[dict]) -> list[dict]:
    out = []
    for msg in messages:
        content = msg.get("content") or ""
        if len(content) > MAX_STORED_CHARS:
            msg = {**msg, "content": content[:MAX_STORED_CHARS] + "\n…[truncado al guardar]"}
        # Las imágenes en base64 no se persisten: multiplicarían el tamaño del
        # archivo por diez y no se pueden reenviar sin el original de todos modos.
        if msg.get("images"):
            msg = {k: v for k, v in msg.items() if k != "images"}
            msg["content"] = (msg.get("content") or "") + " [imagen adjunta]"
        out.append(msg)
    return out


def derive_title(messages: list[dict]) -> str:
    """Título de emergencia a partir del primer mensaje del usuario.

    El bueno lo pone el servidor (`/api/conversations/{id}/generate-title`); este
    es el que evita una lista de conversaciones todas llamadas «Sin título».
    """
    for msg in messages:
        if msg.get("role") != "user":
            continue
        text = " ".join((msg.get("content") or "").split())
        if not text or text.startswith("TOOL_RESULT"):
            continue
        return text[:60] + ("…" if len(text) > 60 else "")
    return "Sin título"


class SessionStore:
    """Sesiones guardadas en disco. Ninguna operación puede tumbar el CLI: el
    historial es una comodidad, no algo por lo que valga la pena perder un turno."""

    def __init__(self, base_dir: Path):
        self.dir = Path(base_dir) / "sessions"
        self.index_file = self.dir / "index.json"

    # ── lectura ──────────────────────────────────────────────────────────

    def _read_index(self) -> list[dict]:
        try:
            data = json.loads(self.index_file.read_text(encoding="utf-8-sig"))
            return [s for s in data.get("sessions", []) if isinstance(s, dict) and s.get("id")]
        except Exception:
            return []

    def list_sessions(self, limit: int = 50) -> "list[dict]":
        """Cabeceras de las sesiones, la más reciente primero."""
        items = self._read_index()
        if not items and self.dir.is_dir():
            items = self.rebuild_index()
        items.sort(key=lambda s: s.get("updated_at") or 0, reverse=True)
        return items[:limit]

    def load(self, session_id: str) -> dict | None:
        """Sesión completa (con sus mensajes) o None si ya no está."""
        path = self._path(session_id)
        try:
            return json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception:
            return None

    # ── escritura ────────────────────────────────────────────────────────

    def _path(self, session_id: str) -> Path:
        return self.dir / f"{session_id}.json"

    def save(self, session_id: str, messages: list[dict], *, title: str = "",
             model: str = "", mode: str = "", workspace: str = "",
             tokens: int = 0) -> None:
        """Crea o actualiza una sesión. Sin mensajes reales no se guarda nada:
        abrir el CLI y cerrarlo no debe dejar una conversación vacía en la lista."""
        real = [m for m in messages
                if m.get("role") in ("user", "assistant") and (m.get("content") or "").strip()
                and not (m.get("content") or "").lstrip().startswith("TOOL_RESULT")]
        if not real:
            return
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            existing = self.load(session_id) or {}
            created = existing.get("created_at") or _now()
            record = {
                "id": session_id,
                "title": title or existing.get("title") or derive_title(messages),
                "created_at": created,
                "updated_at": _now(),
                "model": model or existing.get("model", ""),
                "mode": mode or existing.get("mode", ""),
                "workspace": workspace or existing.get("workspace", ""),
                "tokens": tokens or existing.get("tokens", 0),
                "messages": _trim(messages),
            }
            tmp = self._path(session_id).with_suffix(".tmp")
            tmp.write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")
            tmp.replace(self._path(session_id))  # atómico: nunca un JSON a medias
            self._update_index(record)
        except OSError:
            pass  # disco lleno o sin permisos: el turno sigue igual

    def _header(self, record: dict) -> dict:
        """Lo que va al índice: todo menos los mensajes."""
        counts = {"user": 0, "assistant": 0, "tool": 0}
        for msg in record.get("messages", []):
            role = msg.get("role")
            if role == "tool" or msg.get("tool_calls"):
                counts["tool"] += 1
            elif role in counts:
                counts[role] += 1
        return {
            "id": record["id"],
            "title": record["title"],
            "created_at": record["created_at"],
            "updated_at": record["updated_at"],
            "model": record.get("model", ""),
            "mode": record.get("mode", ""),
            "workspace": record.get("workspace", ""),
            "tokens": record.get("tokens", 0),
            "messages": counts["user"] + counts["assistant"],
            "user_messages": counts["user"],
            "tools": counts["tool"],
        }

    def _update_index(self, record: dict) -> None:
        items = [s for s in self._read_index() if s.get("id") != record["id"]]
        items.append(self._header(record))
        items.sort(key=lambda s: s.get("updated_at") or 0, reverse=True)
        for stale in items[MAX_SESSIONS:]:
            try:
                self._path(stale["id"]).unlink(missing_ok=True)
            except OSError:
                pass
        items = items[:MAX_SESSIONS]
        try:
            tmp = self.index_file.with_suffix(".tmp")
            tmp.write_text(json.dumps({"sessions": items}, ensure_ascii=False, indent=1),
                           encoding="utf-8")
            tmp.replace(self.index_file)
        except OSError:
            pass

    def rebuild_index(self) -> list[dict]:
        """Rehace el índice leyendo los archivos (arranque tras una versión que
        no lo escribía, o índice corrupto)."""
        items = []
        try:
            for path in self.dir.glob("*.json"):
                if path.name == "index.json":
                    continue
                try:
                    items.append(self._header(json.loads(path.read_text(encoding="utf-8-sig"))))
                except Exception:
                    continue
        except OSError:
            return []
        items.sort(key=lambda s: s.get("updated_at") or 0, reverse=True)
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            self.index_file.write_text(json.dumps({"sessions": items}, ensure_ascii=False, indent=1),
                                       encoding="utf-8")
        except OSError:
            pass
        return items

    def delete(self, session_id: str) -> bool:
        try:
            self._path(session_id).unlink(missing_ok=True)
        except OSError:
            return False
        items = [s for s in self._read_index() if s.get("id") != session_id]
        try:
            self.index_file.write_text(json.dumps({"sessions": items}, ensure_ascii=False, indent=1),
                                       encoding="utf-8")
        except OSError:
            pass
        return True

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
    ("history", "[mensajes]", "Ver y reabrir conversaciones anteriores", "conversación"),
    ("image", "<ruta>", "Escribir una imagen en el mensaje (también @ruta)", "conversación"),
    ("paste", "", "Escribir la imagen del portapapeles en el mensaje (Alt+V)", "conversación"),
    ("web", "[on|off]", "Búsqueda web durante las respuestas", "conversación"),
    ("copy", "", "Copiar la última respuesta al portapapeles", "conversación"),
    ("save", "[ruta]", "Guardar la conversación en un archivo Markdown", "conversación"),
    ("clear", "", "Vaciar el contexto y empezar de cero", "conversación"),
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

# El menú del prompt no puede pintar cabeceras de grupo, así que el grupo se
# codifica en el COLOR del nombre. Las clases van sin acentos: prompt_toolkit
# usa el nombre de clase como selector de estilo.
GROUP_CLASS = {
    "conversación": "class:cmd.conversacion",
    "agente": "class:cmd.agente",
    "cuenta": "class:cmd.cuenta",
    "sistema": "class:cmd.sistema",
}

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


# ── Archivos del workspace tras un `@` ──────────────────────────────────────
#
# Se busca en TODO el árbol por trozo de ruta, no carpeta a carpeta: escribir
# `@par` tiene que encontrar `src/utils/parser.py` sin saber dónde está. El
# árbol se cachea unos segundos: se consulta en cada tecla y recorrerlo cada vez
# se notaba al escribir en proyectos grandes.

_AT_TOKEN_RE = re.compile(r'@([^\s"]*)$')
MAX_PATH_COMPLETIONS = 30
MAX_INDEX_ENTRIES = 5000
INDEX_TTL_SECONDS = 30.0

_index_cache: dict[str, tuple[float, list[tuple[str, bool, int]]]] = {}


def _fmt_size(size: int) -> str:
    if size >= 1_000_000:
        return f"{size / 1_000_000:.1f} MB"
    if size >= 1000:
        return f"{size / 1000:.1f} kB"
    return f"{size} B"


def workspace_index(workspace: Path) -> list[tuple[str, bool, int]]:
    """Entradas `(ruta relativa, es carpeta, bytes)` del workspace, cacheadas."""
    import time


    key = str(workspace)
    cached = _index_cache.get(key)
    if cached and time.monotonic() - cached[0] < INDEX_TTL_SECONDS:
        return cached[1]

    entries: list[tuple[str, bool, int]] = []

    def walk(directory: Path, depth: int) -> None:
        if depth > 8 or len(entries) >= MAX_INDEX_ENTRIES:
            return
        try:
            items = sorted(directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            return
        for item in items:
            if len(entries) >= MAX_INDEX_ENTRIES:
                return
            rel = item.relative_to(workspace).as_posix()
            if item.is_dir():
                if item.name in IGNORED_TREE_DIRS:
                    continue
                entries.append((rel + "/", True, 0))
                walk(item, depth + 1)
            else:
                try:
                    size = item.stat().st_size
                except OSError:
                    size = 0
                entries.append((rel, False, size))

    walk(workspace, 1)
    _index_cache[key] = (time.monotonic(), entries)
    return entries


def search_workspace(workspace: Path, query: str,
                     limit: int = MAX_PATH_COMPLETIONS) -> list[tuple[str, bool, int]]:
    """Entradas cuyo camino contiene `query`; primero las que empiezan por él."""
    needle = query.replace("\\", "/").lower()
    show_hidden = needle.rsplit("/", 1)[-1].startswith(".")
    ranked = []
    for rel, is_dir, size in workspace_index(workspace):
        name = rel.rstrip("/").rsplit("/", 1)[-1]
        if name.startswith(".") and not show_hidden:
            continue
        lower = rel.lower()
        if needle and needle not in lower:
            continue
        rank = 0 if name.lower().startswith(needle) else (1 if lower.startswith(needle) else 2)
        ranked.append((rank, rel.count("/"), rel, is_dir, size))
    ranked.sort()
    return [(rel, is_dir, size) for _rank, _depth, rel, is_dir, size in ranked[:limit]]


def _path_completions(workspace: Path, token: str):
    from prompt_toolkit.completion import Completion


    for rel, is_dir, size in search_workspace(workspace, token):
        if is_dir:
            meta = "carpeta"
        else:
            kind = rel.rsplit(".", 1)[-1].lower() if "." in rel.rsplit("/", 1)[-1] else "archivo"
            meta = f"{_fmt_size(size)} {g('sep')} {kind}"
        text = f'"{rel}"' if " " in rel else rel  # el parser de @ admite comillas
        yield Completion(text, start_position=-len(token), display=rel, display_meta=meta)


def wants_completion(text: str) -> bool:
    """¿Hay algo que completar en lo escrito hasta el cursor?

    Lo consulta el prompt para abrir el menú (y reservarle hueco) solo cuando
    toca, en vez de dejar `complete_while_typing` reservándolo siempre.
    """
    if _AT_TOKEN_RE.search(text):
        return True
    if not text.startswith("/"):
        return False
    return " " not in text or text.startswith("/model ")


def make_marker_lexer():
    """Pinta los marcadores `[IMG#n]` del prompt como fichas.

    Solo restyla: los fragmentos tienen que medir lo mismo que el texto o el
    cursor deja de caer donde se escribe.
    """
    from prompt_toolkit.lexers import Lexer

    class MarkerLexer(Lexer):
        def lex_document(self, document):
            lines = document.lines

            def get_line(index: int) -> list:
                line = lines[index]
                fragments, position = [], 0
                for match in _IMG_MARKER_RE.finditer(line):
                    if match.start() > position:
                        fragments.append(("", line[position:match.start()]))
                    fragments.append(("class:img-marker", match.group(0)))
                    position = match.end()
                if position < len(line):
                    fragments.append(("", line[position:]))
                return fragments

            return get_line

    return MarkerLexer()


def slash_rprompt():
    """Recuento de comandos que casan con lo escrito, al margen derecho de la caja."""
    from prompt_toolkit.application import get_app

    text = get_app().current_buffer.text
    if not text.startswith("/") or " " in text:
        return ""
    return [("class:placeholder", f"{len(command_matches(text[1:]))} de {len(COMMAND_SPECS)} ")]


def make_completer(app):
    """Completer de prompt_toolkit: comandos con `/`, modelos y rutas con `@`."""
    from prompt_toolkit.completion import Completer, Completion

    class SlashCompleter(Completer):
        def get_completions(self, document, complete_event):
            text = document.text_before_cursor
            # El `@` va primero: puede aparecer en cualquier parte del mensaje.
            at_token = _AT_TOKEN_RE.search(text)
            if at_token:
                yield from _path_completions(app.workspace, at_token.group(1))
                return
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
                    (GROUP_CLASS.get(group, "class:cmd.name"),
                     f"/{name}".ljust(COMMAND_NAME_WIDTH + 1)),
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


# ── Adjuntos (@ruta) ────────────────────────────────────────────────────────

# La puntuación pegada («@logo.png,») no forma parte de la ruta.
_AT_PATH_RE = re.compile(r'@(?:"([^"]+)"|(\S+?))(?=[.,;:!?)\]]*(?:\s|$))')
MAX_TEXT_ATTACHMENT_BYTES = 64 * 1024


def _looks_like_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_EXTS


def parse_attachments(text: str, base_dir: Path) -> tuple[str, list[Path], list[tuple[str, str]], list[str]]:
    """Extrae los `@ruta` del mensaje.

    Devuelve (texto_limpio, imágenes, archivos de texto, errores). Una imagen
    viaja aparte (ChatMessage.images); un archivo de texto se adjunta como
    `(ruta, contenido)` para que el modelo lo tenga aunque esté en modo ask,
    donde no puede leerlo él. Un @token que no apunta a nada del disco se deja
    tal cual: puede ser un usuario o un handle.
    """
    images: list[Path] = []
    files: list[tuple[str, str]] = []
    errors: list[str] = []

    def _replace(match: re.Match) -> str:
        raw = match.group(1) or match.group(2)
        path = Path(raw)
        if not path.is_absolute():
            path = base_dir / path
        if _looks_like_image(path):
            if not path.exists():
                errors.append(f"No existe la imagen: {raw}")
                return ""
            images.append(path.resolve())
            return path.name  # el texto conserva el nombre para dar contexto al modelo
        if not path.is_file():
            return match.group(0)
        try:
            if path.stat().st_size > MAX_TEXT_ATTACHMENT_BYTES:
                errors.append(f"{raw} supera los 64 kB: pide al agente que lo lea por partes")
                return raw
            content = path.read_bytes().decode("utf-8").replace("\r\n", "\n")
        except UnicodeDecodeError:
            errors.append(f"{raw} no es un archivo de texto")
            return raw
        except OSError as exc:
            errors.append(f"No se pudo leer {raw}: {exc}")
            return raw
        files.append((raw, content))
        return raw

    clean = _AT_PATH_RE.sub(_replace, text).strip()
    return clean, images, files, errors


def attachments_block(files: list[tuple[str, str]]) -> str:
    """Los archivos adjuntos, listos para ir detrás del mensaje."""
    parts = []
    for name, content in files:
        fence = "````" if "```" in content else "```"
        parts.append(f"Archivo adjunto `{name}`:\n{fence}\n{content.rstrip()}\n{fence}")
    return "\n\n".join(parts)


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


def fmt_image_marker(index: int) -> str:
    """Marcador único de imagen adjunta: al pegar, al adjuntar y al enviar."""
    return f"[IMG#{index}]"


_IMG_MARKER_RE = re.compile(r"\[IMG#(\d+)\]", re.IGNORECASE)

# Solo el marcador pegado al cursor: lo usa el Backspace del prompt para
# borrarlo entero de una vez, en lugar de carácter a carácter.
IMG_MARKER_AT_END_RE = re.compile(r"\[IMG#\d+\]$", re.IGNORECASE)


def parse_image_markers(text: str, staged: list[Path]) -> list[Path]:
    """Imágenes de `staged` referenciadas por los marcadores del texto.

    El marcador ES el adjunto: si el usuario lo borra del mensaje, la imagen
    no se envía. El orden lo marca el texto, no la cola.
    """
    images: list[Path] = []
    for match in _IMG_MARKER_RE.finditer(text):
        index = int(match.group(1)) - 1
        if 0 <= index < len(staged) and staged[index] not in images:
            images.append(staged[index])
    return images

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
        # Razonamiento del último stream (modelos thinking); lo consume el loop
        # del agente para no perder las llamadas que el modelo deja ahí dentro.
        self._last_reasoning = ""
        # Estado del turno en curso: el rótulo "✦ Lixbon" se imprime una sola vez
        # y justo encima de la primera prosa, con el registro de acciones ya
        # arriba. `_turn_mark` recuerda cuántas líneas llevaba impresas el turno
        # para saber si hace falta aire entre el registro y la respuesta.
        self._spoke = False
        self._turn_mark = 0
        # Medida del turno para el rótulo y el resumen: cuándo empezó y cuántos
        # tokens ha costado (session_tokens es acumulado y no sirve aquí).
        self._turn_started = 0.0
        self._turn_tokens = 0
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
        self.prompt_prefill = ""  # marcadores de imagen que esperan al prompt
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
        self.status.remote = self.remote is not None
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
            self._turn_tokens += total
        # Recalibra la estimación chars/token con datos reales del server
        self.status.online = True  # ha respondido el servidor: hay red
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
                      plan=self.plan_name, workspace=self.workspace,
                      branch=self._branch(), mode=self.mode)

    def _branch(self) -> str:
        """Rama de git del workspace, si es un repo. Vacío si no lo es."""
        code, out = self._git("rev-parse", "--abbrev-ref", "HEAD", timeout=5)
        branch = out.strip().splitlines()[0] if out.strip() else ""
        return branch if code == 0 and branch != "HEAD" else ""

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
        """Igual que `_probe_account`, y además deja el punto de la barra al día."""
        state = self._probe_account()
        self.status.online = state != "offline"
        return state

    def _probe_account(self) -> str:
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
        self.prompt_prefill = ""
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
        self.prompt_prefill = ""
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
            # Sin código HTTP no hubo respuesta: es la red, y el punto de la
            # barra tiene que decirlo hasta que algo vuelva a funcionar.
            if exc.status is None:
                self.status.online = False
                self._paint_status()
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
        from prompt_toolkit.filters import completion_is_selected, has_selection
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

        @kb.add("escape", "enter")
        def _newline(event):
            # Alt+Enter (Esc+Enter): salto de línea sin enviar. Shift+Enter no
            # llega como tecla distinta a una terminal, así que este es el atajo.
            event.current_buffer.insert_text("\n")

        @kb.add("escape", "v")
        def _paste(event):
            # Alt+V llega como Esc+v. El marcador se escribe en el buffer para
            # que el usuario pueda moverlo o borrarlo (borrarlo = no enviar la
            # imagen); el error, en cambio, va por `run_in_terminal`, que
            # suspende el prompt: imprimir directo lo pisaría el repintado.
            marker, error = self._stage_clipboard_image()
            if marker:
                event.current_buffer.insert_text(marker)
                return
            from prompt_toolkit.application import run_in_terminal

            run_in_terminal(lambda: print_error(error))

        @kb.add("backspace", filter=~has_selection)
        def _backspace(event):
            # El marcador es UNA imagen, no ocho caracteres: si el cursor lo
            # tiene detrás, Backspace lo borra entero. Con selección no llega
            # aquí (el filtro deja pasar el binding de siempre).
            buff = event.current_buffer
            marker = IMG_MARKER_AT_END_RE.search(buff.document.text_before_cursor)
            if marker:
                buff.delete_before_cursor(count=len(marker.group(0)))
                self._drop_staged_image(marker.group(0))
                return
            buff.delete_before_cursor(count=event.arg)

        @kb.add("enter", filter=completion_is_selected)
        def _enter_selected(event):
            # El usuario navegó el menú con las flechas: Enter elige lo marcado.
            buff = event.current_buffer
            buff.apply_completion(buff.complete_state.current_completion)

        return kb

    def _autocomplete(self, buff) -> None:
        """Abre o cierra el menú según lo escrito (ver `_prompt_loop`)."""
        if wants_completion(buff.document.text_before_cursor):
            buff.start_completion(select_first=False)
        elif buff.complete_state is not None:
            buff.cancel_completion()

    def _prompt_loop(self) -> int:

        if not ui_capable():
            print_note("Interfaz simplificada: esta terminal no soporta la interfaz completa.")
            print_note("Para la experiencia completa usa Windows Terminal (o `winpty lixbon` en Git Bash).")
            return self._prompt_loop_plain()

        from prompt_toolkit import PromptSession
        from prompt_toolkit.history import FileHistory

        HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
        round_frame_border()  # antes de construir: el Frame lee los bordes al montar
        session = PromptSession(
            **input_box_kwargs(),
            style=pt_style(),
            completer=make_completer(self),
            complete_in_thread=True,  # el índice de @ recorre el workspace: fuera del hilo del teclado
            lexer=make_marker_lexer(),
            rprompt=slash_rprompt,
            key_bindings=self._completion_bindings(),
            history=FileHistory(str(HISTORY_FILE)),
            # Con la fila reservada la barra la pinta el CLI y queda fija; el
            # bottom_toolbar de prompt_toolkit solo vive mientras hay prompt
            # (por eso desaparecía al enviar), así que sería un duplicado.
            bottom_toolbar=None if status_line_active() else (lambda: self.status.pt_toolbar()),
            mouse_support=False,  # el mouse queda libre para scroll/selección en el transcript
        )
        session.default_buffer.on_text_changed += self._autocomplete
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
                prefill, self.prompt_prefill = self.prompt_prefill, ""
                text = session.prompt(default=f"{partial} {prefill}".strip()).strip()
            except KeyboardInterrupt:
                now = time.monotonic()
                repaint_status()
                if now - self._interrupt_hint_at < 2.5:
                    print_note("Hasta pronto.")
                    return 0
                self._interrupt_hint_at = now
                print_note("(Ctrl+C otra vez para salir)")
                continue
            except EOFError:
                print_note("Hasta pronto.")
                return 0

            # La caja se borra al enviar (erase_when_done), así que el eco de lo
            # escrito lo imprime el CLI: burbuja para un mensaje, rastro simple
            # para un comando (eso se lo dices al CLI, no al modelo).
            repaint_status()
            if text.startswith("/"):
                render_command_echo(self.console, text)
            elif text:
                render_user_message(self.console, text)

            if self._handle_input(text) is False:
                return 0

    def _prompt_loop_plain(self) -> int:
        """Loop sin prompt_toolkit (Git Bash/mintty): input() plano."""
        while True:
            self._refresh_status()
            try:
                text = input(f"  {g('dot')} ").strip()
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
        if self.prompt_prefill:
            # El prompt plano no admite texto precargado: el marcador se anexa
            # aquí para que /paste y /image sigan adjuntando en esas terminales.
            text = f"{text} {self.prompt_prefill}".strip()
            self.prompt_prefill = ""
        clean, at_images, files, errors = parse_attachments(text, self.workspace)
        for err in errors:
            print_error(err)
        if errors and not clean:
            return
        images = parse_image_markers(clean, self.pending_images) + at_images
        self.pending_images = []

        encoded: list[str] = []
        for path in images:
            try:
                encoded.append(encode_image(path))
            except ValueError as exc:
                print_error(str(exc))

        content = clean or text
        if files:
            # El contenido va al modelo, no al transcript: la burbuja ya
            # muestra la ruta y el archivo entero solo sería ruido en pantalla.
            content = f"{content}\n\n{attachments_block(files)}"
        user_msg: dict = {"role": "user", "content": content}
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
        self._turn_started = time.monotonic()
        self._turn_tokens = 0
        self.session["turn_stats"] = {"actions": 0, "files": set(), "adds": 0, "dels": 0}
        for name, body in files:
            # Abre el registro del turno: el adjunto es lo primero que "hizo".
            render_action(self.console, "adjuntó", name, readonly=True,
                          meta=f"{body.count(chr(10)) + 1} líneas")
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
            parts += [(f"{g('dot')} ", "lx.accent2"), (typed, "lx.primary"),
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

    def _turn_seconds(self) -> float:
        return time.monotonic() - self._turn_started if self._turn_started else 0.0

    def _speak_once(self) -> None:
        """Abre la zona de respuesta: rótulo `✦ Lixbon`, una vez por turno.

        Va justo encima de la primera prosa del turno, no al empezar a trabajar.
        Si el registro de acciones ya escribió algo, se cierra con el resumen
        del trabajo y se separa con una línea en blanco: la respuesta necesita
        aire propio para despegarse del canal.
        """
        if self._spoke:
            return
        self._spoke = True
        seconds = self._turn_seconds()
        stats = self.session.get("turn_stats") or {}
        if stats.get("actions"):
            files = stats.get("files") or set()
            render_turn_summary(
                self.console, actions=stats["actions"], files=len(files),
                adds=stats.get("adds", 0), dels=stats.get("dels", 0),
                seconds=seconds, hint="/diff para revisarlo" if files else "",
            )
        if self.console.writes > self._turn_mark:
            self.console.print()
        meta = [self.model] if self.model else []
        if seconds >= 0.1:
            meta.append(f"{seconds:.1f} s")
        if self._turn_tokens:
            meta.append(f"{fmt_tokens(self._turn_tokens)} tokens")
        render_speaker(self.console, meta=f"  {g('sep')}  ".join(meta))

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
        # El loop lo lee para rescatar las llamadas que el modelo dejó en su
        # razonamiento (ver run_agent_turn).
        self.session["last_reasoning"] = self._last_reasoning
        return text, self._last_tool_calls

    def _stream_assistant(self, messages: list[dict], tools: list[dict] | None = None) -> str:
        """Streamea una respuesta con Live: thinking en gris, contenido en Markdown."""
        from rich.console import Group
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
                # El razonamiento es trabajo, no respuesta: va en el canal, igual
                # que las acciones, para que en vivo se distinga de lo que dirá.
                tail = "".join(reasoning_parts).strip().splitlines()[-3:]
                blocks.append(two_col(
                    Text.assemble(rail_text(), (f"{g('spark_alt')} pensando…", "lx.dim")),
                    Text(f"{reasoning_seconds:.0f} s  {g('sep')}  Ctrl+C interrumpe",
                         style="lx.dim2"),
                    row_width(self.console),
                ))
                for line in tail:
                    blocks.append(Text.assemble(rail_text(), (line, "lx.thinking")))
            if content_parts:
                raw = "".join(content_parts)
                if self.mode == "agent":
                    # En vivo se muestra la prosa, no el JSON de las llamadas:
                    # las herramientas aparecen luego en el bloque de acciones.
                    prose = clean_prose(raw)
                    blocks.append(markdown(prose) if prose
                                  else Text(f"{g('spark_alt')} preparando acciones…", style="lx.dim"))
                else:
                    blocks.append(markdown(raw))
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
                    blocks.append(markdown(text))
            elif text:
                blocks.append(markdown(text))
            else:
                blocks.append(Text.assemble(
                    ("(sin respuesta)", "lx.dim2"),
                    (f"  {g('sep')}  el modelo no devolvió texto; /doctor revisa la conexión",
                     "lx.dim2"),
                ))
            if interrupted:
                blocks.append(Text.assemble(
                    ("— interrumpido —", "lx.warn"),
                    ("  el contexto se conserva: escribe «continúa» para seguir", "lx.dim2"),
                ))
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
                self.console.print("[lx.dim2]fuentes  " + esc(f"  {g('sep')}  ".join(
                    str(s.get("url") or s.get("title") or "?") for s in sources[:5])) + "[/]")
            self.console.print()

        if usage:
            self._register_usage(usage)
        self._refresh_status()  # tokens/contexto nuevos → repinta la barra fija
        # El razonamiento no se muestra como respuesta, pero el loop del agente
        # lo necesita: los modelos thinking (qwen3.5…) a veces meten la llamada
        # a la herramienta DENTRO del bloque de pensamiento, y sin mirarlo ahí
        # el turno parece vacío aunque el modelo sí había decidido qué hacer.
        self._last_reasoning = "".join(reasoning_parts).strip()
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
        self._speak_once()
        self.console.print(markdown(result.get("response", "(sin respuesta)")))
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
            # Cabecera de grupo: en el menú del prompt no cabe, pero aquí sí, y
            # es lo único que agrupa 31 comandos a la vista.
            options.append(Option(group, None, disabled=True))
            for name, args, desc, grp in COMMAND_SPECS:
                if grp != group:
                    continue
                label = f"/{name} {args}".strip()
                options.append(Option(label, name, desc))
        chosen = select(
            "Comandos", options, searchable=True, max_visible=14,
            hint=f"escribe para filtrar {g('sep')} ↑↓ mover {g('sep')} ↵ ejecutar {g('sep')} esc salir")
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
        self._queue_prefill(self._stage_image(path.resolve()))
        return True

    def cmd_paste(self, arg: str):
        marker, error = self._stage_clipboard_image()
        if error:
            print_error(error)
        self._queue_prefill(marker)
        return True

    def _stage_image(self, path: Path) -> str | None:
        """Encola la imagen y devuelve su marcador, o None si no sirve."""
        try:
            encode_image(path)  # valida formato y tamaño antes de prometer nada
        except ValueError as exc:
            print_error(str(exc))
            return None
        self.pending_images.append(path)
        return fmt_image_marker(len(self.pending_images))

    def _stage_clipboard_image(self) -> tuple[str | None, str]:
        """(marcador, error) de la imagen del portapapeles.

        Lo comparten `/paste` y el atajo Alt+V del prompt; el modelo la recibe
        igual que con `@ruta` (base64 en `ChatMessage.images`), así que solo
        funciona de verdad con un modelo multimodal.
        """
        path, error = paste_image(CONFIG_DIR)
        if path is None:
            return None, error or "el portapapeles no tiene ninguna imagen"
        return self._stage_image(path), ""

    def _drop_staged_image(self, marker: str) -> None:
        """Descarta el adjunto al borrar su marcador, si era el último.

        Borrar uno de en medio no puede descartarlo: los índices de los que
        vienen detrás ya están escritos en el mensaje y se desplazarían.
        """
        index = int("".join(ch for ch in marker if ch.isdigit()))
        if index == len(self.pending_images):
            self.pending_images.pop()

    def _queue_prefill(self, marker: str | None) -> None:
        """Deja el marcador escrito en el siguiente prompt, listo para editar.

        Alt+V lo inserta donde está el cursor; `/paste` y `/image` no pueden
        (su prompt ya se envió), así que el marcador espera al que viene.
        """
        if marker:
            self.prompt_prefill = f"{self.prompt_prefill} {marker}".strip()

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
        # Una ficha, no trece filas de una cosa cada una: lo que se consulta
        # junto va junto (el modo con sus permisos, la sesión con su clave).
        self.console.print()
        approve = "sin preguntar" if self.session.get("auto_approve") else "pide confirmación"
        commands = "sin preguntar" if self.session.get("auto_run_commands") else "pide confirmación"
        rows = [
            ("Modelo", self.model or "no configurado", ""),
            ("Plan", f"Lixbon {self.plan_name}" if self.plan_name else "desconocido", ""),
            ("Modo", self.mode, f"cambios {approve}  {g('sep')}  comandos {commands}"),
            ("Sesión", self._session_label(), f"clave {mask_key(self.cfg.get('api_key', ''))}"),
            ("Servidor", self.api.base_url, "conectado" if self.status.online else "sin conexión"),
            ("Workspace", short_path(self.workspace),
             "LIXBON.md cargado" if self.project_context else "sin LIXBON.md (/init)"),
            ("Ventana de contexto", f"{self.cfg.get('context_window', 8192)} tokens",
             "se envía el turno entero" if self.mode == "agent"
             else f"últimos {self.cfg.get('max_context_messages', 12)} mensajes"),
            ("Extras", f"búsqueda web {'on' if self.web_search else 'off'}",
             f"barra fija {'on' if status_line_active() else 'off'}"),
        ]
        for label, value, note in rows:
            line = f"  [lx.dim]{label:<20}[/] [lx.primary]{esc(value)}[/]"
            if note:
                line += f"[lx.dim2]  {g('sep')}  {esc(note)}[/]"
            self.console.print(line)
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
            print_warn("El contexto va lleno: /compact resume la conversación y libera espacio.")
        self.console.print()
        return True

    # ── agente ───────────────────────────────────────────────────────────

    def cmd_tools(self, arg: str):
        """Qué puede hacer el agente, y con qué nivel de permiso."""

        from rich.text import Text

        approve = "sin preguntar" if self.session.get("auto_approve") else "pide confirmación"
        commands = "sin preguntar" if self.session.get("auto_run_commands") else "siempre pregunta"

        self.console.print()
        self.console.print(f"  [lx.dim2]herramientas del modo agent {g('sep')} workspace {esc(short_path(self.workspace))}[/]")
        for name, args, desc in TOOL_SPECS:
            readonly = name in READ_ONLY_TOOLS
            # El permiso de cada herramienta va a la derecha, en su columna: es
            # lo que se viene a mirar aquí, y antes había que deducirlo del pie.
            if readonly:
                left = Text("  ")
                left.append(f"{g('dot_empty')} ", style="lx.dim2")
                permission = Text("solo lectura", style="lx.dim2")
            else:
                left = Text("  ")
                left.append(f"{g('dot')} ", style="lx.accent2")
                permission = Text(commands if name == "run_command" else approve,
                                  style="lx.warn" if name == "run_command" else "lx.beige")
            left.append(f"{name:<14}", style="bold lx.primary")
            left.append(args, style="lx.dim2")
            self.console.print(two_col(left, permission, row_width(self.console)))
            self.console.print(f"      [lx.dim]{esc(desc)}[/]")
        self.console.print()
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
        render_user_message(self.console, chosen)
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
        self._refresh_status()

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
            self._refresh_status()
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
                if text.startswith("/"):
                    render_command_echo(self.console, f"{text}  [remoto]")
                    self._remote_command(link, text)
                    continue
                # El eco del mensaje lo pone send_message con origin != local:
                # imprimirlo también aquí dejaba cada mensaje del móvil dos
                # veces en el transcript.
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
            headers={"Cache-Control": "no-cache", "Pragma": "no-cache",
                     "User-Agent": USER_AGENT},
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
        # Sin valor por defecto: el servidor titula la conversación tras el
        # primer intercambio (pasarlo aquí fija el nombre a mano).
        p.add_argument("--title", default="", help="Título fijo de la conversación")
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
