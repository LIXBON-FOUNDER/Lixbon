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
