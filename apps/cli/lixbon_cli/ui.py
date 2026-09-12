"""Primitivas de interfaz: header, selector con flechas/mouse, barra de estado."""
import sys
from dataclasses import dataclass, field

from lixbon_cli.inputq import suspend_input
from lixbon_cli.term import UNICODE_OK, attach_status_repaint, g, repaint_status
from lixbon_cli.theme import PALETTE, make_console, pt_style


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
    from lixbon_cli.theme import PAD_LEFT, PAD_RIGHT

    return max(24, console.width - PAD_LEFT - PAD_RIGHT)


def inner_width() -> int:
    """El mismo ancho para lo que pinta prompt_toolkit (que no pasa por rich)."""
    from lixbon_cli.term import term_size
    from lixbon_cli.theme import PAD_LEFT, PAD_RIGHT

    return max(24, term_size()[0] - PAD_LEFT - PAD_RIGHT)


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
    ("Ctrl+J", "nueva línea (o \\ y ↵)"),
    ("Ctrl+C", "interrumpir"),
    ("Ctrl+C ×2", "salir"),
)
TIP_COLUMNS = 3


def render_tips(console) -> None:
    """Atajos de arranque en rejilla, sin panel (el panel era una caja más que
    competía visualmente con el chat)."""
    from rich.text import Text

    width = row_width(console)
    key_width = max(len(key) for key, _desc in TIPS) + 2
    # Celda = tecla + descripción más larga + hueco; menos columnas antes que
    # dejar que dos atajos se pisen en una terminal estrecha.
    cell_width = key_width + max(len(desc) for _key, desc in TIPS) + 3
    columns = max(1, min(TIP_COLUMNS, (width - 2) // cell_width))
    column = max(cell_width, (width - 2) // columns)
    for start in range(0, len(TIPS), columns):
        line = Text("  ")
        for key, desc in TIPS[start:start + columns]:
            cell = Text()
            cell.append(f"{key:<{key_width}}", style="lx.accent2")
            cell.append(desc, style="lx.dim")
            cell.pad_right(max(1, column - cell.cell_len))
            line.append_text(cell)
        console.print(line)


def rule(console, label: str = "") -> None:
    """Separador horizontal con etiqueta opcional: divide zonas del CLI
    (arranque │ conversación) sin encerrar nada en un recuadro."""
    from lixbon_cli.theme import PAD_LEFT, PAD_RIGHT

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
    "find_files": "buscó archivos", "run_command": "ejecutó",
    "fetch_url": "descargó", "web_search": "buscó en la web",
    "read_output": "leyó salida", "stop_command": "detuvo", "outline": "esquematizó",
    "todo": "planificó", "ask_user": "preguntó", "multi_edit": "editó", "insert_at_line": "editó",
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
    from lixbon_cli.term import ui_capable

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


def confirm_command(detail: str, prefix: str):
    """Aprobación de un comando: 'yes' | 'prefix' | 'always' | 'no' | None.
    `prefix` es lo que quedaría permitido para el resto de sesiones."""
    options = [Option("Sí", "yes", "ejecutar y seguir")]
    if prefix:
        options.append(Option(f"Sí, y siempre para «{prefix}»", "prefix",
                              "se guarda: no volverá a preguntar por ese comando"))
    options += [
        Option("Sí, y no preguntar más", "always", "auto-ejecutar cualquier comando esta sesión"),
        Option("No", "no", "rechazar y decirle al agente que no"),
    ]
    return select("¿Ejecutar este comando?", options, detail=detail, rail_mode=True,
                  hint=f"↑↓ mover {g('sep')} ↵ elegir {g('sep')} esc = No")


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
        from lixbon_cli.term import term_size

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


def make_prompt_session(**kwargs):
    """`PromptSession` con la caja sujeta a su alto natural.

    El renderer de prompt_toolkit (sin pantalla completa) pinta el layout con
    TODO el alto que queda bajo el cursor, y el `Frame` de `show_frame` se
    estira para llenarlo: nada más arrancar, la caja llegaba hasta el pie de la
    terminal. Se fija el alto del marco a lo que mide su contenido (una fila de
    texto, o las del menú cuando está abierto) y el resto del layout queda en
    blanco, como con el prompt de una línea de siempre.
    """
    from prompt_toolkit import PromptSession
    from prompt_toolkit.application import get_app
    from prompt_toolkit.layout.dimension import Dimension

    class LixbonPrompt(PromptSession):
        def _create_layout(self):
            layout = super()._create_layout()
            try:
                # HSplit del Frame: [borde superior, VSplit(│, cuerpo, │), borde inferior]
                frame = layout.container.children[0].content
                body = frame.children[1].children[1]
            except (AttributeError, IndexError):
                self.show_frame = False  # la estructura cambió: mejor sin caja que a lo alto
                return layout

            def frame_height():
                size = get_app().output.get_size()
                rows = body.preferred_height(size.columns - 2, size.rows).preferred + 2
                return Dimension(preferred=rows, max=rows)

            frame.height = frame_height
            return layout

    return LixbonPrompt(**kwargs)


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
