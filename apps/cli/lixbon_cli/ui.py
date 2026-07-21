"""Primitivas de interfaz: header, selector con flechas/mouse, barra de estado."""
import sys
from dataclasses import dataclass, field

from lixbon_cli.term import g
from lixbon_cli.theme import PALETTE, make_console, pt_style


def esc(text: object) -> str:
    """Escapa texto dinámico para que rich no lo interprete como markup."""
    from rich.markup import escape

    return escape(str(text))


# ── Cabecera de identidad ───────────────────────────────────────────────────

# Ancho del bloque del ícono (2 facetas + destello): el texto de las tres
# líneas se alinea contra este margen.
LOGO_WIDTH = 3


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

        ◢◣   Lixbon CLI v2.1.0
        ◥◤✦  qwen2.5-coder:7b · Lixbon Pro
             ~/proyectos/api

    Se imprime una vez al arrancar (y tras /clear): sube con el transcript en
    lugar de robar espacio permanente. Los datos vivos (contexto, tokens,
    modo) viven en la barra inferior, que sí es fija.
    """
    from rich.text import Text

    top = g("logo_top")
    bottom = g("logo_bottom")
    indent = " " * (LOGO_WIDTH + 2)

    # Text.assemble en vez de markup: el logo ASCII de respaldo contiene `\`,
    # que rich interpretaría como escape del cierre de etiqueta.
    console.print()
    console.print(Text.assemble(
        (top, "lx.facet.top"), " " * (LOGO_WIDTH - len(top) + 2),
        ("Lixbon CLI", "lx.brand"), " ", (f"v{version}", "lx.dim2"),
    ))
    line2 = [
        (bottom, "lx.facet.bottom"), (g("spark"), "lx.primary"), "  ",
        (model or "sin modelo", "lx.beige"),
    ]
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

    parts = [
        (g("logo_top"), "lx.facet.top"), (g("logo_bottom"), "lx.facet.bottom"), " ",
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
        f"Ctrl+C dos veces para salir[/]"
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

    def __post_init__(self):
        if self.value is None:
            self.value = self.label


def select(title: str, options: list, default: int = 0, hint: str = "clic o flechas para elegir"):
    """Selector inline estilo Claude Code. Devuelve Option.value o None (Esc).

    Navegación: ↑/↓ (también j/k), Enter confirma, Esc/Ctrl+C cancela.
    Mouse: hover mueve la selección, clic confirma.
    En terminales sin soporte (Git Bash/mintty) degrada a texto plano.
    """
    from lixbon_cli.term import ui_capable

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

    def rich_line(self, compact: bool = False):
        """La misma barra como línea rich (pie del Live durante el stream)."""
        from rich.text import Text

        text = Text()
        for style_cls, chunk in (self._compact_parts() if compact else self._parts()):
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
