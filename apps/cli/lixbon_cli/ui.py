"""Primitivas de interfaz: header, selector con flechas/mouse, barra de estado."""
import sys
from dataclasses import dataclass, field

from lixbon_cli.term import UNICODE_OK, attach_status_repaint, g, repaint_status
from lixbon_cli.theme import PALETTE, make_console, pt_style


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
    from lixbon_cli.term import ui_capable

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
