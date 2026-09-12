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

        from lixbon_cli.term import is_mintty, status_line_active

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
