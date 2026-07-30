"""Host del control remoto (/remote): la sesión CLI se controla desde la app.

Transporte stdlib puro, igual que el resto del CLI:
- Bajada: SSE de larga duración con los comandos del móvil/web (hilo lector).
- Subida: POST de lotes de eventos del transcript (hilo flusher, ~4 Hz).
El gateway solo releva; este proceso sigue siendo quien ejecuta todo.
"""
import json
import queue
import threading
import time
import uuid

from lixbon_cli.api import ApiError

REMOTE_FLUSH_SECONDS = 0.25
REMOTE_RECONNECT_MAX_S = 30
REMOTE_RESULT_CHARS = 600  # tamaño máximo del resumen de un tool_result

# Comandos que el host acepta desde la app, publicados en el `hello` para que
# el móvil pueda ofrecerlos sin conocer de antemano quién está al otro lado
# (CLI e IDE no tienen por qué ofrecer los mismos). Solo entran los que se
# resuelven con un argumento: en remoto no hay teclado para un selector.
REMOTE_COMMANDS: list[tuple[str, str, str]] = [
    ("help", "", "Ver los comandos disponibles aquí"),
    ("new", "", "Empezar una conversación nueva"),
    ("model", "[nombre]", "Ver o cambiar el modelo"),
    ("mode", "[ask|agent|delegate]", "Ver o cambiar el modo de trabajo"),
    ("approve", "[on|off]", "Auto-aprobar herramientas del agente"),
    ("web", "[on|off]", "Búsqueda web durante las respuestas"),
    ("status", "", "Estado de la sesión y del host"),
    ("cost", "", "Tokens y contexto consumidos"),
    ("workspace", "", "Carpeta de trabajo del agente"),
]


def _args_summary(tool: str, args: dict) -> str:
    """Resumen compacto y legible de los argumentos de una herramienta."""
    if tool == "run_command":
        return str(args.get("command", ""))[:200]
    if tool == "rename_file":
        return f"{args.get('src', '?')} → {args.get('dst', '?')}"
    if tool == "search":
        return f"«{args.get('pattern', '')}» en {args.get('path', '.')}"
    if tool == "edit_file":
        old = str(args.get("old_text", ""))
        return f"{args.get('path', '?')} (reemplaza {len(old)} chars)"
    if tool in ("write_file", "append_file"):
        content = str(args.get("content", ""))
        return f"{args.get('path', '?')} ({len(content)} chars)"
    return str(args.get("path") or args.get("pattern") or args)[:200]


class RemoteLink:
    """Canal del host contra el gateway. Los hilos internos solo tocan la red;
    la ejecución de prompts/herramientas sigue en el hilo principal del CLI."""

    def __init__(self, api, source: str = "cli", title: str = "", machine: str = ""):
        self.api = api  # ApiClient
        self.source = source
        self.title = title
        self.machine = machine
        self.session_id = ""
        self.share_url = ""
        self.commands: queue.Queue = queue.Queue()  # prompt/bye hacia el loop principal
        self.interrupt_requested = False
        self.ended = False
        self.snapshot_provider = None  # callable -> list[dict] (lo pone ChatApp)
        self._buffer: list[dict] = []
        self._buf_lock = threading.Lock()
        self._stop = threading.Event()
        self._approvals: dict[str, str] = {}
        self._approval_cv = threading.Condition()
        self._threads: list[threading.Thread] = []

    # ── ciclo de vida ────────────────────────────────────────────────────

    def start(self, mode: str = "", model: str = "") -> dict:
        """Crea la sesión en el gateway y arranca lector y flusher."""
        resp = self.api.remote_create(self.source, self.title, self.machine)
        self.session_id = resp["session"]["id"]
        self.share_url = resp.get("share_url", "")
        self.emit("hello", source=self.source, title=self.title,
                  machine=self.machine, mode=mode, model=model,
                  commands=[{"name": n, "args": a, "description": d}
                            for n, a, d in REMOTE_COMMANDS])
        for target, name in ((self._reader_loop, "remote-reader"),
                             (self._flusher_loop, "remote-flusher")):
            t = threading.Thread(target=target, daemon=True, name=name)
            t.start()
            self._threads.append(t)
        return resp

    def stop(self, end_session: bool = True) -> None:
        """Corta hilos, hace un último flush y (opcional) termina la sesión."""
        self._stop.set()
        with self._approval_cv:
            self._approval_cv.notify_all()
        if end_session and not self.ended:
            try:
                self.emit("bye", reason="host_closed")
                self._flush_now()
                self.api.remote_end(self.session_id)
            except ApiError:
                pass
        self.ended = True

    def qr_text(self) -> str:
        """QR unicode (half-blocks) del share_url, generado por el gateway."""
        try:
            return self.api.remote_qr_txt(self.share_url)
        except ApiError:
            return ""

    # ── eventos (host → controllers) ─────────────────────────────────────

    def emit(self, event_type: str, **fields) -> None:
        ev = {"type": event_type, **fields}
        with self._buf_lock:
            self._buffer.append(ev)

    def emit_snapshot(self) -> None:
        if self.snapshot_provider is None:
            return
        try:
            messages = self.snapshot_provider()
        except Exception:
            return
        self.emit("snapshot", messages=messages)

    def _flush_now(self) -> None:
        with self._buf_lock:
            batch, self._buffer = self._buffer, []
        if not batch:
            return
        try:
            self.api.remote_events(self.session_id, batch)
        except ApiError as exc:
            if exc.status in (404, 410):
                self.ended = True
                self.commands.put({"type": "bye", "reason": "gone"})
                return
            # Fallo transitorio: devolver el lote al frente para reintentar
            with self._buf_lock:
                self._buffer = batch + self._buffer
                # Tope defensivo: nunca acumular sin límite si el server no vuelve
                if len(self._buffer) > 2000:
                    self._buffer = self._buffer[-1000:]

    def _flusher_loop(self) -> None:
        while not self._stop.is_set():
            time.sleep(REMOTE_FLUSH_SECONDS)
            self._flush_now()

    # ── comandos (controllers → host) ────────────────────────────────────

    def _reader_loop(self) -> None:
        backoff = 2
        while not self._stop.is_set() and not self.ended:
            try:
                response = self.api.remote_commands_stream(self.session_id)
                backoff = 2
                self._consume_commands(response)
            except ApiError as exc:
                if exc.status in (404, 410):
                    self.ended = True
                    self.commands.put({"type": "bye", "reason": "gone"})
                    return
            except Exception:
                pass
            if not self._stop.is_set() and not self.ended:
                time.sleep(backoff)
                backoff = min(backoff * 2, REMOTE_RECONNECT_MAX_S)

    def _consume_commands(self, response) -> None:
        try:
            for raw in response:
                if self._stop.is_set():
                    return
                line = raw.decode("utf-8", errors="replace").strip()
                if not line.startswith("data:"):
                    continue
                try:
                    cmd = json.loads(line[len("data:"):].strip())
                except json.JSONDecodeError:
                    continue
                self._dispatch(cmd)
        finally:
            try:
                response.close()
            except Exception:
                pass

    def _dispatch(self, cmd: dict) -> None:
        kind = cmd.get("type")
        if kind == "prompt":
            self.commands.put(cmd)
        elif kind == "interrupt":
            self.interrupt_requested = True
        elif kind == "approve":
            with self._approval_cv:
                self._approvals[str(cmd.get("id"))] = cmd.get("decision") or "deny"
                self._approval_cv.notify_all()
        elif kind == "request_snapshot":
            self.emit_snapshot()
        elif kind == "bye":
            self.ended = True
            with self._approval_cv:
                self._approval_cv.notify_all()
            self.commands.put(cmd)

    # ── aprobaciones remotas ─────────────────────────────────────────────

    def request_approval(self, tool: str, summary: str, risk: str) -> str:
        """Emite approval_request y bloquea hasta la decisión del móvil/web.
        Devuelve "allow" | "deny" (fin de sesión ⇒ deny)."""
        approval_id = uuid.uuid4().hex[:10]
        self.emit("approval_request", id=approval_id, tool=tool, summary=summary, risk=risk)
        with self._approval_cv:
            while approval_id not in self._approvals:
                if self.ended or self._stop.is_set():
                    return "deny"
                self._approval_cv.wait(timeout=1.0)
        decision = self._approvals.pop(approval_id)
        self.emit("approval_resolved", id=approval_id, decision=decision)
        return "allow" if decision == "allow" else "deny"
