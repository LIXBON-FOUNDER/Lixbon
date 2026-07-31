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

from lixbon_cli.term import IS_WINDOWS

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
