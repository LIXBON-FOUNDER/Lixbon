"""Historial persistente de sesiones del CLI (~/.lixbon/sessions/).

Antes no existía: `/history` listaba los mensajes de la sesión EN CURSO para
reenviar uno, y al cerrar el CLI se perdía todo. Cada conversación es ahora un
archivo propio con sus mensajes, sus llamadas a herramientas y sus fechas, y se
puede volver a abrir tal cual — igual que en Claude, ChatGPT o Gemini.

Formato: un JSON por sesión más un `index.json` con las cabeceras, para poder
listar sin abrir (ni cargar en memoria) conversaciones enteras. El índice es
caché reconstruible: si se pierde o se corrompe, `rebuild_index()` lo rehace
leyendo los archivos.
"""
import json
import time
import uuid
from pathlib import Path

# Tope por mensaje al guardar: un `read_file` de un archivo grande no tiene por
# qué ocupar megas en disco para siempre. Es mucho más de lo que se le manda al
# modelo, así que el transcript se lee entero sin sorpresas.
MAX_STORED_CHARS = 20000

MAX_SESSIONS = 200  # las más antiguas se van borrando solas


def _now() -> float:
    return time.time()


def new_session_id() -> str:
    return str(uuid.uuid4())


def relative_time(timestamp: float) -> str:
    """«ahora», «hace 5 horas», «hace 2 días» — como en cualquier app de chat."""
    delta = max(0, int(_now() - (timestamp or 0)))
    if delta < 60:
        return "ahora"
    if delta < 3600:
        minutes = delta // 60
        return f"hace {minutes} min"
    if delta < 86400:
        hours = delta // 3600
        return f"hace {hours} hora{'s' if hours > 1 else ''}"
    days = delta // 86400
    if days < 30:
        return f"hace {days} día{'s' if days > 1 else ''}"
    months = days // 30
    if months < 12:
        return f"hace {months} mes{'es' if months > 1 else ''}"
    years = days // 365
    return f"hace {years} año{'s' if years > 1 else ''}"


def _trim(messages: list[dict]) -> list[dict]:
    out = []
    for msg in messages:
        content = msg.get("content") or ""
        if len(content) > MAX_STORED_CHARS:
            msg = {**msg, "content": content[:MAX_STORED_CHARS] + "\n…[truncado al guardar]"}
        # Las imágenes en base64 no se persisten: multiplicarían el tamaño del
        # archivo por diez y no se pueden reenviar sin el original de todos modos.
        if msg.get("images"):
            msg = {k: v for k, v in msg.items() if k != "images"}
            msg["content"] = (msg.get("content") or "") + " [imagen adjunta]"
        out.append(msg)
    return out


def derive_title(messages: list[dict]) -> str:
    """Título de emergencia a partir del primer mensaje del usuario.

    El bueno lo pone el servidor (`/api/conversations/{id}/generate-title`); este
    es el que evita una lista de conversaciones todas llamadas «Sin título».
    """
    for msg in messages:
        if msg.get("role") != "user":
            continue
        text = " ".join((msg.get("content") or "").split())
        if not text or text.startswith("TOOL_RESULT"):
            continue
        return text[:60] + ("…" if len(text) > 60 else "")
    return "Sin título"


class SessionStore:
    """Sesiones guardadas en disco. Ninguna operación puede tumbar el CLI: el
    historial es una comodidad, no algo por lo que valga la pena perder un turno."""

    def __init__(self, base_dir: Path):
        self.dir = Path(base_dir) / "sessions"
        self.index_file = self.dir / "index.json"

    # ── lectura ──────────────────────────────────────────────────────────

    def _read_index(self) -> list[dict]:
        try:
            data = json.loads(self.index_file.read_text(encoding="utf-8-sig"))
            return [s for s in data.get("sessions", []) if isinstance(s, dict) and s.get("id")]
        except Exception:
            return []

    def list_sessions(self, limit: int = 50) -> "list[dict]":
        """Cabeceras de las sesiones, la más reciente primero."""
        items = self._read_index()
        if not items and self.dir.is_dir():
            items = self.rebuild_index()
        items.sort(key=lambda s: s.get("updated_at") or 0, reverse=True)
        return items[:limit]

    def load(self, session_id: str) -> dict | None:
        """Sesión completa (con sus mensajes) o None si ya no está."""
        path = self._path(session_id)
        try:
            return json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception:
            return None

    # ── escritura ────────────────────────────────────────────────────────

    def _path(self, session_id: str) -> Path:
        return self.dir / f"{session_id}.json"

    def save(self, session_id: str, messages: list[dict], *, title: str = "",
             model: str = "", mode: str = "", workspace: str = "",
             tokens: int = 0) -> None:
        """Crea o actualiza una sesión. Sin mensajes reales no se guarda nada:
        abrir el CLI y cerrarlo no debe dejar una conversación vacía en la lista."""
        real = [m for m in messages
                if m.get("role") in ("user", "assistant") and (m.get("content") or "").strip()
                and not (m.get("content") or "").lstrip().startswith("TOOL_RESULT")]
        if not real:
            return
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            existing = self.load(session_id) or {}
            created = existing.get("created_at") or _now()
            record = {
                "id": session_id,
                "title": title or existing.get("title") or derive_title(messages),
                "created_at": created,
                "updated_at": _now(),
                "model": model or existing.get("model", ""),
                "mode": mode or existing.get("mode", ""),
                "workspace": workspace or existing.get("workspace", ""),
                "tokens": tokens or existing.get("tokens", 0),
                "messages": _trim(messages),
            }
            tmp = self._path(session_id).with_suffix(".tmp")
            tmp.write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")
            tmp.replace(self._path(session_id))  # atómico: nunca un JSON a medias
            self._update_index(record)
        except OSError:
            pass  # disco lleno o sin permisos: el turno sigue igual

    def _header(self, record: dict) -> dict:
        """Lo que va al índice: todo menos los mensajes."""
        counts = {"user": 0, "assistant": 0, "tool": 0}
        for msg in record.get("messages", []):
            role = msg.get("role")
            if role == "tool" or msg.get("tool_calls"):
                counts["tool"] += 1
            elif role in counts:
                counts[role] += 1
        return {
            "id": record["id"],
            "title": record["title"],
            "created_at": record["created_at"],
            "updated_at": record["updated_at"],
            "model": record.get("model", ""),
            "mode": record.get("mode", ""),
            "workspace": record.get("workspace", ""),
            "tokens": record.get("tokens", 0),
            "messages": counts["user"] + counts["assistant"],
            "user_messages": counts["user"],
            "tools": counts["tool"],
        }

    def _update_index(self, record: dict) -> None:
        items = [s for s in self._read_index() if s.get("id") != record["id"]]
        items.append(self._header(record))
        items.sort(key=lambda s: s.get("updated_at") or 0, reverse=True)
        for stale in items[MAX_SESSIONS:]:
            try:
                self._path(stale["id"]).unlink(missing_ok=True)
            except OSError:
                pass
        items = items[:MAX_SESSIONS]
        try:
            tmp = self.index_file.with_suffix(".tmp")
            tmp.write_text(json.dumps({"sessions": items}, ensure_ascii=False, indent=1),
                           encoding="utf-8")
            tmp.replace(self.index_file)
        except OSError:
            pass

    def rebuild_index(self) -> list[dict]:
        """Rehace el índice leyendo los archivos (arranque tras una versión que
        no lo escribía, o índice corrupto)."""
        items = []
        try:
            for path in self.dir.glob("*.json"):
                if path.name == "index.json":
                    continue
                try:
                    items.append(self._header(json.loads(path.read_text(encoding="utf-8-sig"))))
                except Exception:
                    continue
        except OSError:
            return []
        items.sort(key=lambda s: s.get("updated_at") or 0, reverse=True)
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            self.index_file.write_text(json.dumps({"sessions": items}, ensure_ascii=False, indent=1),
                                       encoding="utf-8")
        except OSError:
            pass
        return items

    def delete(self, session_id: str) -> bool:
        try:
            self._path(session_id).unlink(missing_ok=True)
        except OSError:
            return False
        items = [s for s in self._read_index() if s.get("id") != session_id]
        try:
            self.index_file.write_text(json.dumps({"sessions": items}, ensure_ascii=False, indent=1),
                                       encoding="utf-8")
        except OSError:
            pass
        return True
