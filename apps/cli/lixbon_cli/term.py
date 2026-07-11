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


def is_interactive() -> bool:
    return bool(sys.stdout.isatty() and sys.stdin.isatty())
