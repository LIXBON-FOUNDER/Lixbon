"""
remote.py — Control remoto de sesiones IDE/CLI (/remote).

El host (IDE/CLI) mantiene un SSE de comandos y publica eventos por POST;
los controllers (app móvil / web) mantienen un SSE de eventos y publican
comandos por POST. Transporte uniforme SSE+POST porque el CLI es stdlib puro
(sin cliente WebSocket) y todos los clientes ya hablan SSE.

Seguridad:
- Host y listados: sesión web o API key del dueño (cookie_auth_required).
- Controllers: SIEMPRE el dueño autenticado. El token del link/QR NO da acceso
  por sí solo: solo identifica la sesión; el claim exige iniciar sesión con la
  cuenta dueña (la web redirige a /auth y vuelve). Cada claim queda en
  audit_events.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import socket
from typing import Any

from fastapi import APIRouter, Cookie, Header, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from core.config import PUBLIC_BASE_URL
from core.gateway import deps
from core.gateway.remote_hub import hub
from core.persistence.queries import (
    claim_remote_session,
    create_remote_session,
    delete_device_token,
    end_remote_session,
    get_remote_session,
    list_device_tokens,
    list_remote_sessions,
    log_audit_event,
    register_device_token,
    touch_remote_session,
)
from core.security.auth import cookie_auth_required
from core.security.ratelimit import check_auth_rate_limit, record_failed_auth

router = APIRouter()
log = logging.getLogger("lixbon")

SSE_PING_SECONDS = 15
MAX_EVENTS_PER_BATCH = 200
EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"


def _public_base(request: Request) -> str:
    if PUBLIC_BASE_URL:
        return PUBLIC_BASE_URL
    return str(request.base_url).rstrip("/")


def _session_or_404(session_id: str) -> dict[str, Any]:
    sess = get_remote_session(session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Sesión remota no encontrada")
    return sess


def _owner_required(session_id: str, lixbon_session: str | None, authorization: str | None) -> dict[str, Any]:
    user = cookie_auth_required(lixbon_session, authorization)
    sess = _session_or_404(session_id)
    if sess["user_id"] != user["id"]:
        raise HTTPException(status_code=404, detail="Sesión remota no encontrada")
    return sess




async def _sse(queue: asyncio.Queue, first: list[dict[str, Any]] | None = None):
    """Generador SSE: replay inicial + cola en vivo + keepalives."""
    yield ": connected\n\n"
    for ev in first or []:
        yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
    while True:
        try:
            ev = await asyncio.wait_for(queue.get(), timeout=SSE_PING_SECONDS)
        except asyncio.TimeoutError:
            yield ": ping\n\n"
            continue
        yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        if ev.get("type") in ("session_ended", "bye"):
            return


# ── Push (Expo) ────────────────────────────────────────────────────────────

async def _send_push(user_id: int, title: str, body: str, data: dict[str, Any]) -> None:
    """Notificación push best-effort a los dispositivos del usuario."""
    tokens = await asyncio.to_thread(list_device_tokens, user_id)
    if not tokens or deps.http_client_fast is None:
        return
    messages = [
        {"to": t, "title": title, "body": body, "data": data, "priority": "high"}
        for t in tokens
    ]
    try:
        resp = await deps.http_client_fast.post(EXPO_PUSH_URL, json=messages)
        for token, ticket in zip(tokens, resp.json().get("data", [])):
            details = (ticket or {}).get("details") or {}
            if details.get("error") == "DeviceNotRegistered":
                await asyncio.to_thread(delete_device_token, token)
    except Exception as exc:
        log.debug(f"[remote] push fallido: {exc}")


def _push_task(user_id: int, title: str, body: str, data: dict[str, Any]) -> None:
    try:
        asyncio.get_running_loop().create_task(_send_push(user_id, title, body, data))
    except RuntimeError:
        pass


# ── Ciclo de vida de sesiones ──────────────────────────────────────────────

@router.post("/api/remote/sessions")
async def create_session_endpoint(
    payload: dict[str, Any],
    request: Request,
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    """Crea una sesión remota (host). Devuelve el share token EN CLARO solo aquí."""
    user = cookie_auth_required(lixbon_session, authorization)
    source = payload.get("source") if payload.get("source") in ("cli", "ide") else "cli"
    title = (payload.get("title") or "").strip() or "Sesión remota"
    machine = (payload.get("machine") or "").strip() or socket.gethostname()

    raw_token, sess = create_remote_session(user["id"], source, title, machine)
    hub.channel(sess["id"], user["id"])

    ip = request.client.host if request.client else None
    log_audit_event("remote_session_created", user_id=user["id"], ip_address=ip,
                    session_id=sess["id"], source=source)

    share_url = f"{_public_base(request)}/remote/{raw_token}"
    hub.notify_user(user["id"], {"type": "session_created", "session": sess})
    _push_task(
        user["id"],
        "Sesión remota activa",
        f"{title} · {machine} está listo para controlarse desde la app",
        {"kind": "remote_session", "session_id": sess["id"]},
    )
    return {"session": sess, "share_token": raw_token, "share_url": share_url}


@router.get("/api/remote/sessions")
async def list_sessions_endpoint(
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    user = cookie_auth_required(lixbon_session, authorization)
    sessions = list_remote_sessions(user["id"])
    # El estado real de conexión lo da el hub, no la BD
    for sess in sessions:
        ch = hub.get(sess["id"])
        sess["host_connected"] = bool(ch and ch.host_connected)
        sess["controllers"] = len(ch.controllers) if ch else 0
    return {"sessions": sessions}


@router.delete("/api/remote/sessions/{session_id}")
async def end_session_endpoint(
    session_id: str,
    request: Request,
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    ip = request.client.host if request.client else None
    sess = _owner_required(session_id, lixbon_session, authorization)
    end_remote_session(session_id)
    ch = hub.get(session_id)
    if ch:
        # El host (si sigue vivo) recibe el fin por su SSE de comandos
        hub.push_command(ch, {"type": "bye", "reason": "ended"})
        hub.publish_events(ch, [{"type": "bye", "reason": "ended"}])
    hub.drop(session_id)
    hub.notify_user(sess["user_id"], {"type": "session_ended", "session_id": session_id})
    log_audit_event("remote_session_ended", user_id=sess["user_id"], ip_address=ip,
                    session_id=session_id)
    return {"ended": True}


@router.post("/api/remote/claim")
async def claim_endpoint(
    payload: dict[str, Any],
    request: Request,
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    """Resuelve el token del link/QR a su sesión. El token NO es una llave:
    exige estar autenticado como el DUEÑO de la sesión (la web manda a /auth
    primero). Un token válido de otra cuenta responde 404, no revela nada."""
    user = cookie_auth_required(lixbon_session, authorization)
    ip = request.client.host if request.client else None
    if ip:
        check_auth_rate_limit(ip)
    token = (payload.get("token") or "").strip()
    sess = claim_remote_session(token) if token else None
    if not sess or sess["user_id"] != user["id"]:
        if ip:
            record_failed_auth(ip)
        raise HTTPException(status_code=404, detail="Link inválido, expirado o revocado")
    log_audit_event("remote_session_claimed", user_id=user["id"], ip_address=ip,
                    user_agent=request.headers.get("user-agent"),
                    session_id=sess["id"])
    sess.pop("user_id", None)
    return {"session": sess}


# ── Canal del host ─────────────────────────────────────────────────────────

@router.get("/api/remote/sessions/{session_id}/commands")
async def host_commands_stream(
    session_id: str,
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    """SSE de larga duración con los comandos que el host debe ejecutar."""
    sess = _owner_required(session_id, lixbon_session, authorization)
    if sess["status"] == "ended":
        raise HTTPException(status_code=410, detail="La sesión remota ya terminó")
    ch = hub.channel(session_id, sess["user_id"])
    ch.host_connected = True
    touch_remote_session(session_id, status="online")
    hub.notify_user(sess["user_id"], {"type": "session_online", "session_id": session_id})

    async def gen():
        try:
            async for chunk in _sse(ch.host_queue):
                yield chunk
        finally:
            ch.host_connected = False
            touch_remote_session(session_id, status="offline")
            hub.notify_user(sess["user_id"], {"type": "session_offline", "session_id": session_id})

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.post("/api/remote/sessions/{session_id}/events")
async def host_publish_events(
    session_id: str,
    payload: dict[str, Any],
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    """El host publica un lote de eventos del transcript."""
    sess = _owner_required(session_id, lixbon_session, authorization)
    events = payload.get("events") or []
    if not isinstance(events, list) or len(events) > MAX_EVENTS_PER_BATCH:
        raise HTTPException(status_code=422, detail="Lote de eventos inválido")
    ch = hub.channel(session_id, sess["user_id"])
    last_seq = hub.publish_events(ch, [ev for ev in events if isinstance(ev, dict)])
    touch_remote_session(session_id)

    for ev in events:
        if ev.get("type") == "approval_request":
            _push_task(
                sess["user_id"],
                "El agente pide permiso",
                f"{ev.get('tool', 'herramienta')} en {sess['title']}",
                {"kind": "remote_approval", "session_id": session_id},
            )
        elif ev.get("type") == "bye":
            end_remote_session(session_id)
            hub.drop(session_id)
            hub.notify_user(sess["user_id"], {"type": "session_ended", "session_id": session_id})
    return {"seq": last_seq}


# ── Canal de los controllers ───────────────────────────────────────────────

@router.get("/api/remote/sessions/{session_id}/stream")
async def controller_events_stream(
    session_id: str,
    from_seq: int = 0,
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    """SSE con el transcript en vivo (+replay desde from_seq). Solo el dueño."""
    sess = _owner_required(session_id, lixbon_session, authorization)
    if sess["status"] == "ended":
        raise HTTPException(status_code=410, detail="La sesión remota ya terminó")
    ch = hub.channel(session_id, sess["user_id"])
    attached = hub.attach_controller(ch)
    if attached is None:
        raise HTTPException(status_code=409, detail="Demasiados dispositivos conectados a esta sesión")
    cid, queue = attached

    status_ev = {
        "type": "channel_status",
        "seq": ch.last_seq,
        "host_connected": ch.host_connected,
        "session": {k: v for k, v in sess.items() if k != "user_id"},
        "meta": ch.meta,
    }
    first = [status_ev] + hub.replay(ch, from_seq)
    # Si el controller llega sin historial, el host reemite un snapshot completo
    if from_seq == 0 and ch.host_connected:
        hub.push_command(ch, {"type": "request_snapshot", "from_seq": 0})

    async def gen():
        try:
            async for chunk in _sse(queue, first=first):
                yield chunk
        finally:
            hub.detach_controller(ch, cid)

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.post("/api/remote/sessions/{session_id}/commands")
async def controller_send_command(
    session_id: str,
    payload: dict[str, Any],
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    """El controller manda un comando al host: prompt | interrupt | approve | request_snapshot."""
    sess = _owner_required(session_id, lixbon_session, authorization)
    if sess["status"] == "ended":
        raise HTTPException(status_code=410, detail="La sesión remota ya terminó")
    kind = payload.get("type")
    if kind not in ("prompt", "interrupt", "approve", "request_snapshot"):
        raise HTTPException(status_code=422, detail=f"Comando no soportado: {kind}")
    if kind == "prompt" and not (payload.get("text") or "").strip():
        raise HTTPException(status_code=422, detail="El prompt está vacío")

    ch = hub.channel(session_id, sess["user_id"])
    if not ch.host_connected:
        raise HTTPException(status_code=409, detail="El host no está conectado ahora mismo")
    command = {k: payload.get(k) for k in ("type", "text", "id", "decision", "from_seq") if k in payload}
    if not hub.push_command(ch, command):
        raise HTTPException(status_code=429, detail="El host tiene demasiados comandos pendientes")
    return {"queued": True}


# ── Suscripción a la lista de sesiones (pantalla Remote de la app) ─────────

@router.get("/api/remote/subscribe")
async def subscribe_sessions_stream(
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    """SSE de avisos: sesión creada / online / offline / terminada."""
    user = cookie_auth_required(lixbon_session, authorization)
    queue = hub.subscribe_user(user["id"])

    async def gen():
        try:
            async for chunk in _sse(queue):
                yield chunk
        finally:
            hub.unsubscribe_user(user["id"], queue)

    return StreamingResponse(gen(), media_type="text/event-stream")


# ── Dispositivos (push) ────────────────────────────────────────────────────

@router.post("/api/remote/devices")
async def register_device_endpoint(
    payload: dict[str, Any],
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    user = cookie_auth_required(lixbon_session, authorization)
    token = (payload.get("expo_push_token") or "").strip()
    if not token or len(token) > 200:
        raise HTTPException(status_code=422, detail="expo_push_token inválido")
    register_device_token(user["id"], token, (payload.get("platform") or "").strip() or None)
    return {"registered": True}


# ── QR ─────────────────────────────────────────────────────────────────────

@router.get("/api/remote/qr")
async def qr_endpoint(
    data: str,
    fmt: str = "png",
    scale: int = 6,
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    """Genera el QR del share_url. `fmt=txt` devuelve unicode para terminal
    (half-blocks), `png`/`svg` para IDE y web. Requiere sesión: no es un
    generador de QR público."""
    cookie_auth_required(lixbon_session, authorization)
    if len(data) > 500:
        raise HTTPException(status_code=422, detail="Dato demasiado largo para el QR")
    try:
        import segno
    except ImportError:
        raise HTTPException(status_code=501, detail="Generación de QR no disponible (falta segno)")
    qr = segno.make(data, error="m")
    if fmt == "txt":
        buf = io.StringIO()
        qr.terminal(out=buf, compact=True, border=2)
        return Response(buf.getvalue(), media_type="text/plain; charset=utf-8")
    if fmt == "svg":
        buf_b = io.BytesIO()
        qr.save(buf_b, kind="svg", scale=max(1, min(scale, 20)), border=2)
        return Response(buf_b.getvalue(), media_type="image/svg+xml")
    buf_b = io.BytesIO()
    qr.save(buf_b, kind="png", scale=max(1, min(scale, 20)), border=2)
    return Response(buf_b.getvalue(), media_type="image/png")
