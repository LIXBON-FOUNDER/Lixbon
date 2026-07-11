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
