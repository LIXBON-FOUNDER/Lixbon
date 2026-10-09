"""Gateway simulado para probar la app en un emulador (e2e/run.sh).

Solo stdlib. Responde lo que la app pide al arrancar y simula dos sesiones
/remote en vivo (Claude Code y Lixbon) y una terminada del CLI. Los comandos que
manda la app se registran en prompts.jsonl para comprobarlos después.
"""
from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(os.environ.get("MOCK_PORT", "8765"))
LOG = os.environ.get("MOCK_LOG", "prompts.jsonl")


def iso(minutes_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()


USER = {"id": 1, "email": "ana@lixbon.com", "first_name": "Ana", "last_name": "Prueba", "plan": "pro"}

SESSIONS = [
    {"id": "claude01", "source": "ide", "agent": "claude", "title": "Arreglar el login con Google",
     "workspace": "lixbon", "machine": "Lixbon IDE", "status": "online", "host_connected": True,
     "created_at": iso(40), "last_seen_at": iso(1), "transcript_events": 9},
    {"id": "lixbon01", "source": "ide", "agent": "lixbon", "title": "Refactor del reducer remoto",
     "workspace": "lixbon-mobile", "machine": "Lixbon IDE", "status": "online", "host_connected": True,
     "created_at": iso(90), "last_seen_at": iso(6), "transcript_events": 4},
    {"id": "cli01", "source": "cli", "agent": None, "title": "api-server", "workspace": None,
     "machine": "gabriel-pc", "status": "ended", "host_connected": False,
     "created_at": iso(60 * 26), "last_seen_at": iso(60 * 25), "transcript_events": 3},
]

FILES = [
    {"name": "auth.py", "rel": "core/security/auth.py", "path": "/repo/core/security/auth.py"},
    {"name": "AuthScreen.js", "rel": "apps/mobile/src/screens/AuthScreen.js", "path": "/repo/apps/mobile/src/screens/AuthScreen.js"},
    {"name": "app.config.js", "rel": "apps/mobile/app.config.js", "path": "/repo/apps/mobile/app.config.js"},
    {"name": "api.js", "rel": "apps/mobile/src/api.js", "path": "/repo/apps/mobile/src/api.js"},
]

CAPS = ["attachments", "images", "mentions", "files"]

HELLOS = {
    "claude01": {
        "type": "hello", "source": "ide", "agent": "claude", "title": "Arreglar el login con Google",
        "workspace": "lixbon", "machine": "Lixbon IDE", "mode": "default", "model": "sonnet",
        "capabilities": CAPS,
        "commands": [
            {"name": "new", "args": "", "description": "Nueva conversación", "group": "lixbon"},
            {"name": "undo", "args": "", "description": "Revertir el último cambio de Claude", "group": "lixbon"},
            {"name": "status", "args": "", "description": "Versión, cuenta, modelo, modo y MCP de esta sesión", "group": "claude"},
            {"name": "cost", "args": "", "description": "Gasto de la sesión, contexto y cupo del plan", "group": "claude"},
            {"name": "compact", "args": "", "description": "Resumir la conversación para liberar contexto", "group": "claude"},
            {"name": "code-review", "args": "", "description": "Revisar el diff actual en busca de errores", "group": "claude"},
            {"name": "context", "args": "", "description": "Qué está ocupando el contexto ahora mismo", "group": "claude"},
            {"name": "orquestar", "args": "<objetivo>", "description": "Coordinar un equipo de agentes", "group": "skill"},
        ],
    },
    "lixbon01": {
        "type": "hello", "source": "ide", "agent": "lixbon", "title": "Refactor del reducer remoto",
        "workspace": "lixbon-mobile", "machine": "Lixbon IDE", "mode": "agent", "model": "qwen3:8b",
        "capabilities": CAPS,
        "commands": [
            {"name": "new", "args": "", "description": "Nueva conversación", "group": "lixbon"},
            {"name": "plan", "args": "", "description": "Modo Plan: investiga y propone", "group": "lixbon"},
            {"name": "undo", "args": "", "description": "Revertir el último cambio", "group": "lixbon"},
            {"name": "help", "args": "", "description": "Comandos disponibles", "group": "lixbon"},
        ],
    },
}

TRANSCRIPTS = {
    "claude01": [
        {"type": "snapshot", "messages": [
            {"role": "user", "content": "--- Documento adjunto: informe-errores.pdf ---\nEl login con Google devuelve 400.\n\n---\n\n¿Por qué falla el login con Google?",
             "images": 1, "mentions": ["auth.py"]},
            {"role": "tool", "tool": "Read", "content": "core/security/auth.py · 212 líneas", "ok": True},
            {"role": "assistant", "content": "El callback de Google compara el `state` antes de decodificarlo, así que **nunca coincide**. Propongo decodificarlo primero en `auth.py`."},
        ]},
        {"type": "user_msg", "text": "Hazlo y corre los tests", "origin": "local"},
        {"type": "status", "state": "thinking"},
        {"type": "tool_use", "tool": "Bash", "summary": "pytest core/security -q", "readonly": False},
        {"type": "tool_result", "tool": "Bash", "result": "12 passed in 1.84s", "error": False},
        {"type": "approval_request", "id": "a1", "tool": "Edit", "summary": "core/security/auth.py", "risk": "edit"},
    ],
    "lixbon01": [
        {"type": "snapshot", "messages": [
            {"role": "user", "content": "Separa el reducer en archivos"},
            {"role": "assistant", "content": "Listo: `remote.js` ahora solo tiene el reducer."},
        ]},
        {"type": "status", "state": "idle"},
        {"type": "background", "tasks": [
            {"id": "b1", "type": "local_bash", "description": "npm test -- --watch=false", "since": time.time() * 1000 - 95000},
        ]},
    ],
    "cli01": [
        {"type": "hello", "source": "cli", "title": "api-server", "machine": "gabriel-pc"},
        {"type": "user_msg", "text": "¿Qué endpoints faltan por documentar?", "origin": "local"},
        {"type": "assistant_done", "text": "Faltan `/api/remote/claim` y `/api/remote/qr`."},
    ],
}

streams: dict[str, list[queue.Queue]] = {}
subscribers: list[queue.Queue] = []
lock = threading.Lock()


def push(session_id: str, event: dict) -> None:
    with lock:
        for q in streams.get(session_id, []):
            q.put(event)


def log_command(session_id: str, command: dict) -> None:
    slim = dict(command)
    for att in slim.get("attachments") or []:
        if "base64" in att:
            att["base64"] = f"<{len(att['base64'])} chars>"
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"session": session_id, **slim}, ensure_ascii=False) + "\n")


def handle_command(session_id: str, command: dict) -> None:
    log_command(session_id, command)
    kind = command.get("type")
    if kind == "files":
        q = (command.get("query") or "").lower()
        items = [f for f in FILES if q in f["rel"].lower()] if q else FILES
        push(session_id, {"type": "files", "query": command.get("query") or "", "items": items})
    elif kind == "prompt":
        atts = command.get("attachments") or []
        text = command.get("text") or ""
        docs = [a for a in atts if a.get("kind") == "doc"]
        if docs:
            text = "\n\n".join(f"--- Documento adjunto: {d['name']} ---\n{d['text']}" for d in docs) + "\n\n---\n\n" + (text or "Analiza este documento.")
        push(session_id, {"type": "user_msg", "text": text, "origin": "remote",
                          "images": sum(1 for a in atts if a.get("kind") == "image"),
                          "mentions": [m.get("name") for m in command.get("mentions") or []]})
        if text.strip() == "/status":
            push(session_id, {"type": "command_result", "name": "status", "args": "", "text": "", "rows": [
                {"label": "Versión", "detail": "2.1.0 (Claude Code)"},
                {"label": "Modelo", "detail": "opus"},
                {"label": "Cuenta", "detail": "ana@lixbon.com · max", "tone": "ok"},
                {"label": "MCP", "detail": "railway: falló", "tone": "bad"},
            ]})
        else:
            push(session_id, {"type": "assistant_done", "text": "Recibido desde el teléfono."})
    elif kind == "approve":
        push(session_id, {"type": "approval_resolved", "id": command.get("id")})


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # CORS: la misma simulación sirve para probar la build web en local.
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("[mock] " + fmt % args + "\n")

    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return {}

    def _chunk(self, text: str) -> None:
        data = text.encode("utf-8")
        self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
        self.wfile.flush()

    def _sse(self, session_id: str | None, first: list[dict]):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        q: queue.Queue = queue.Queue()
        with lock:
            if session_id:
                streams.setdefault(session_id, []).append(q)
            else:
                subscribers.append(q)
        try:
            self._chunk(": connected\n\n")
            for ev in first:
                self._chunk(f"data: {json.dumps(ev, ensure_ascii=False)}\n\n")
            while True:
                try:
                    ev = q.get(timeout=10)
                    self._chunk(f"data: {json.dumps(ev, ensure_ascii=False)}\n\n")
                except queue.Empty:
                    self._chunk(": ping\n\n")
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            with lock:
                (streams.get(session_id, []) if session_id else subscribers).remove(q)

    def do_GET(self):
        url = urlparse(self.path)
        path = url.path
        if path == "/api/auth/me":
            return self._json({"user": USER})
        if path == "/api/auth/oauth/providers":
            return self._json({"providers": []})
        if path == "/v1/models":
            return self._json({"data": [{"id": "qwen3:8b"}, {"id": "llama3.2"}]})
        if path == "/api/conversations":
            return self._json({"conversations": [
                {"id": "c1", "title": "Plan de lanzamiento", "updated_at": iso(30), "source": "mobile"},
                {"id": "c2", "title": "Resumen del informe", "updated_at": iso(60 * 30), "source": "mobile"},
            ]})
        if path == "/api/remote/sessions":
            return self._json({"sessions": SESSIONS})
        if path == "/api/remote/subscribe":
            return self._sse(None, [])
        parts = path.strip("/").split("/")
        if len(parts) == 5 and parts[:3] == ["api", "remote", "sessions"]:
            sid, tail = parts[3], parts[4]
            sess = next((s for s in SESSIONS if s["id"] == sid), None)
            if not sess:
                return self._json({"detail": "Sesión remota no encontrada"}, 404)
            if tail == "transcript":
                events = [dict(ev, seq=i + 1) for i, ev in enumerate(TRANSCRIPTS.get(sid, []))]
                return self._json({"session": sess, "events": events, "last_seq": len(events)})
            if tail == "stream":
                from_seq = int(parse_qs(url.query).get("from_seq", ["0"])[0])
                status = {"type": "channel_status", "seq": 0, "host_connected": True, "session": sess, "meta": {}}
                events = [HELLOS[sid]] + TRANSCRIPTS.get(sid, []) if from_seq == 0 else []
                return self._sse(sid, [status] + [dict(ev, seq=i + 1) for i, ev in enumerate(events)])
        return self._json({})

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._body()
        if path == "/api/auth/login":
            return self._json({"api_key": "lxb_e2e_key", "user": USER})
        if path == "/__e2e/new_session":
            # Lo que hace el gateway cuando un IDE ejecuta /remote.
            sess = {**SESSIONS[0], "id": "claude02", "title": "Revisar las notificaciones push",
                    "created_at": iso(0), "last_seen_at": iso(0)}
            if not any(sx["id"] == "claude02" for sx in SESSIONS):
                SESSIONS.insert(0, sess)
                HELLOS["claude02"] = {**HELLOS["claude01"], "title": sess["title"]}
            with lock:
                for q in subscribers:
                    q.put({"type": "session_created", "session": sess})
            return self._json({"subscribers": len(subscribers)})
        parts = path.strip("/").split("/")
        if len(parts) == 5 and parts[:3] == ["api", "remote", "sessions"] and parts[4] == "commands":
            handle_command(parts[3], body)
            return self._json({"queued": True})
        return self._json({})

    def do_PATCH(self):
        self._body()
        return self._json({})

    def do_DELETE(self):
        return self._json({})


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    print(f"[mock] gateway simulado en :{PORT}", flush=True)
    server.serve_forever()
