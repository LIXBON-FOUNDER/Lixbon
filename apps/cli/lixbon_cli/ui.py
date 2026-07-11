"""Primitivas de interfaz: header, selector con flechas/mouse, barra de estado."""
import sys
from dataclasses import dataclass, field

from lixbon_cli.term import g
from lixbon_cli.theme import PALETTE, make_console, pt_style


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
        f"[lx.accent]{spark}[/] [bold lx.primary]Lixbon Code[/] [lx.dim]{g('sep')} asistente de código en tu terminal[/]\n\n"
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
    """
    from prompt_toolkit.application import Application
    from prompt_toolkit.key_binding import KeyBindings
    from prompt_toolkit.layout import HSplit, Layout, Window
    from prompt_toolkit.layout.controls import FormattedTextControl
    from prompt_toolkit.mouse_events import MouseEventType

    options = [o if isinstance(o, Option) else Option(str(o)) for o in options]
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
            ("class:sel.title", f"? {title} "),
            ("class:sel.hint", f"({hint})\n"),
        ]
        for i, opt in enumerate(options):
            handler = _mouse_handler_for(i)
            active = i == state["index"]
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
