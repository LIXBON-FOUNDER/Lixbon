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

        from lixbon_cli.term import is_mintty

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
