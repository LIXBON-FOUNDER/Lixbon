"""
El host (IDE/CLI) mantiene un SSE de comandos y publica eventos por POST;
los controllers (app móvil / web) mantienen un SSE de eventos y publican
comandos por POST. Transporte uniforme SSE+POST porque el CLI es stdlib puro
(sin cliente WebSocket) y todos los clientes ya hablan SSE.

Seguridad:
- Host y listados: sesión web o API key del dueño (session_or_api_key).
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
import time
from typing import Any

from fastapi import APIRouter, Cookie, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response, StreamingResponse

from core.config import PUBLIC_BASE_URL
from core.gateway import deps
from core.gateway.push import push_task
from core.gateway.remote_hub import HOST_GRACE_SECONDS, hub
from core.persistence.queries import (
    claim_remote_session,
    count_remote_events,
    create_remote_session,
    end_remote_session,
    get_remote_session,
    list_remote_events,
    list_remote_sessions,
    log_audit_event,
    register_device_token,
    save_remote_events,
    touch_remote_session,
    update_remote_session_meta,
)
from core.security.auth import authenticate, session_or_api_key
from core.security.ratelimit import check_auth_rate_limit, record_failed_auth

router = APIRouter()
log = logging.getLogger("lixbon")

SSE_PING_SECONDS = 15
SSE_HEADERS = {"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"}
WS_PING_SECONDS = 15
WS_AUTH_SECONDS = 10
# El móvil en segundo plano queda congelado por Android y no puede contestar:
# su conexión se mantiene varios minutos para retomarla tal cual al volver.
CONTROLLER_IDLE_SECONDS = 600
HOST_IDLE_SECONDS = 60
TOUCH_EVERY_SECONDS = 30
MAX_EVENTS_PER_BATCH = 200
AGENTS = ("lixbon", "claude")
CONTROLLER_COMMANDS = ("prompt", "interrupt", "approve", "request_snapshot", "files", "orch", "config")
# Lo que un controller puede pedirle al orquestador del host. El host vuelve a
# validar cada acción: esto solo evita reenviar basura.
ORCH_ACTIONS = ("refresh", "enable", "settings", "stop", "remove_run", "diff", "term", "agents")
MAX_ORCH_ARGS = 4_000
MAX_ATTACHMENTS = 6
MAX_DOC_CHARS = 20_000
# Las imágenes viajan en base64 por la cola del host: ~6 MB entre todas.
MAX_IMAGES_B64 = 8 * 1024 * 1024
MAX_MENTIONS = 20
AGENT_LABEL = {"lixbon": "Lixbon", "claude": "Claude Code"}


def _public_base(request: Request) -> str:
    if PUBLIC_BASE_URL:
        return PUBLIC_BASE_URL
    return str(request.base_url).rstrip("/")


def _agent(value: Any) -> str | None:
    return value if value in AGENTS else None


def _clean_attachments(raw: Any) -> list[dict[str, Any]]:
    """Adjuntos de un prompt remoto: documentos ya convertidos a texto (los
    extrae /api/attachments en el cliente) e imágenes en base64 que el host
    pasa tal cual a su agente."""
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_ATTACHMENTS:
        raise HTTPException(status_code=422, detail=f"Máximo {MAX_ATTACHMENTS} adjuntos por mensaje")
    out: list[dict[str, Any]] = []
    image_bytes = 0
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "adjunto")[:200]
        if item.get("kind") == "image":
            data = item.get("base64")
            if not isinstance(data, str) or not data:
                continue
            image_bytes += len(data)
            out.append({"kind": "image", "name": name, "base64": data,
                        "mime": str(item.get("mime") or "image/jpeg")[:40]})
        elif item.get("kind") == "doc":
            text = item.get("text")
            if not isinstance(text, str) or not text.strip():
                continue
            out.append({"kind": "doc", "name": name, "text": text[:MAX_DOC_CHARS]})
    if image_bytes > MAX_IMAGES_B64:
        raise HTTPException(status_code=413, detail={
            "code": "too_large", "message": "Las imágenes pesan demasiado para enviarlas juntas.",
        })
    return out


def _clean_mentions(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw[:MAX_MENTIONS]:
        if isinstance(item, dict) and isinstance(item.get("path"), str):
            out.append({k: str(item.get(k) or "")[:500] for k in ("path", "name", "rel")})
    return out


def _session_or_404(session_id: str) -> dict[str, Any]:
    sess = get_remote_session(session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Sesión remota no encontrada")
    return sess


def _owner_required(session_id: str, lixbon_session: str | None, authorization: str | None) -> dict[str, Any]:
    # Sin rate limit: el host publica eventos varias veces por segundo mientras
    # el agente escribe y el tope general (120/min por API key) los frenaba
    # con 429, retrasando el texto en el móvil hasta el minuto siguiente.
    user = authenticate(lixbon_session, authorization, rate_limit=False)
    sess = _session_or_404(session_id)
    if sess["user_id"] != user["id"]:
        raise HTTPException(status_code=404, detail="Sesión remota no encontrada")
    return sess


async def _owner(session_id: str, lixbon_session: str | None, authorization: str | None) -> dict[str, Any]:
    return await asyncio.to_thread(_owner_required, session_id, lixbon_session, authorization)




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
        if ev is None:
            return
        yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        if ev.get("type") in ("session_ended", "bye"):
            return


@router.post("/api/remote/sessions")
async def create_session_endpoint(
    payload: dict[str, Any],
    request: Request,
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    """Crea una sesión remota (host). Devuelve el share token EN CLARO solo aquí."""
    user = session_or_api_key(lixbon_session, authorization)
    source = payload.get("source") if payload.get("source") in ("cli", "ide") else "cli"
    title = (payload.get("title") or "").strip() or "Sesión remota"
    machine = (payload.get("machine") or "").strip() or socket.gethostname()
    agent = _agent(payload.get("agent"))
    workspace = (payload.get("workspace") or "").strip() or None

    raw_token, sess = create_remote_session(user["id"], source, title, machine, agent, workspace)
    hub.channel(sess["id"], user["id"])

    ip = request.client.host if request.client else None
    log_audit_event("remote_session_created", user_id=user["id"], ip_address=ip,
                    session_id=sess["id"], source=source)

    share_url = f"{_public_base(request)}/remote/{raw_token}"
    hub.notify_user(user["id"], {"type": "session_created", "session": sess})
    push_task(
        user["id"],
        f"{AGENT_LABEL.get(agent or '', 'Sesión')} en remoto",
        " · ".join(filter(None, [title, workspace if workspace != title else None, machine])),
        {"kind": "remote_session", "session_id": sess["id"]},
    )
    return {"session": sess, "share_token": raw_token, "share_url": share_url}


@router.get("/api/remote/sessions")
async def list_sessions_endpoint(
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    user = session_or_api_key(lixbon_session, authorization)
    sessions = list_remote_sessions(user["id"])
    # Cuántos eventos guardados tiene cada una: la app marca así las sesiones
    # terminadas que todavía se pueden abrir para releer la conversación.
    counts = count_remote_events(user["id"])
    # El estado real de conexión lo da el hub, no la BD (que solo se refresca
    # cuando el host publica eventos o pasa el barrido).
    for sess in sessions:
        ch = hub.get(sess["id"])
        connected = bool(ch and hub.host_online(ch))
        sess["host_connected"] = connected
        sess["controllers"] = len(ch.controllers) if ch else 0
        sess["transcript_events"] = counts.get(sess["id"], 0)
        if connected and sess["status"] != "ended":
            sess["status"] = "online"
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
    user = session_or_api_key(lixbon_session, authorization)
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


# ── Lógica común del relay (SSE+POST y WebSocket) ───────────────────────────

_background: set[asyncio.Task] = set()


def _spawn(coro) -> None:
    task = asyncio.get_running_loop().create_task(coro)
    _background.add(task)
    task.add_done_callback(_background.discard)


async def _host_attached(ch, sess: dict[str, Any], last_cmd: int | None) -> tuple[int, asyncio.Queue]:
    was_online = hub.host_online(ch)
    gen_id, queue = hub.attach_host(ch, last_cmd)
    if not was_online:
        await asyncio.to_thread(touch_remote_session, sess["id"], "online")
        hub.notify_user(sess["user_id"], {"type": "session_online", "session_id": sess["id"]})
    return gen_id, queue


def _host_detached(ch, sess: dict[str, Any], gen_id: int) -> None:
    # Un stream jubilado por una reconexión no cuenta. Y el vigente tampoco
    # marca offline al instante: si el host vuelve dentro del margen, para el
    # móvil nunca se desconectó.
    if not hub.detach_host(ch, gen_id):
        return

    async def later():
        await asyncio.sleep(HOST_GRACE_SECONDS + 1)
        if hub.get(sess["id"]) is not ch or ch.host_gen != gen_id or ch.host_connected:
            return
        hub.announce_host(ch)
        hub.notify_user(sess["user_id"], {"type": "session_offline", "session_id": sess["id"]})
        await asyncio.to_thread(touch_remote_session, sess["id"], "offline")

    _spawn(later())


async def _publish(ch, sess: dict[str, Any], events: Any) -> int:
    """Reparte un lote de eventos del host, lo guarda y reacciona a hello/bye."""
    if not isinstance(events, list) or len(events) > MAX_EVENTS_PER_BATCH:
        raise HTTPException(status_code=422, detail="Lote de eventos inválido")
    session_id = sess["id"]
    clean = [ev for ev in events if isinstance(ev, dict)]
    last_seq = hub.publish_events(ch, clean)
    now = time.time()
    if now - ch.last_touch > TOUCH_EVERY_SECONDS:
        ch.last_touch = now
        await asyncio.to_thread(touch_remote_session, session_id)
    # El transcript se guarda DESPUÉS de repartirlo: el relay manda, la BD es
    # lo que hace que la conversación siga ahí cuando la sesión termine.
    try:
        await asyncio.to_thread(save_remote_events, session_id, clean)
    except Exception as exc:
        log.warning(f"[remote] no se pudo guardar el transcript de {session_id}: {exc}")

    for ev in clean:
        if ev.get("type") == "hello":
            updated = await asyncio.to_thread(
                update_remote_session_meta, session_id,
                ev.get("title"), _agent(ev.get("agent")), ev.get("workspace"),
            )
            if updated:
                hub.notify_user(sess["user_id"], {"type": "session_updated", "session": updated})
        if ev.get("type") == "approval_request":
            push_task(
                sess["user_id"],
                f"{AGENT_LABEL.get(sess.get('agent') or '', 'El agente')} pide permiso",
                f"{ev.get('tool', 'herramienta')} en {sess['title']}",
                {"kind": "remote_approval", "session_id": session_id},
            )
        elif ev.get("type") == "bye":
            await asyncio.to_thread(end_remote_session, session_id)
            hub.drop(session_id)
            hub.notify_user(sess["user_id"], {"type": "session_ended", "session_id": session_id})
    return last_seq


async def _controller_first(ch, sess: dict[str, Any], from_seq: int) -> list[dict[str, Any]]:
    status_ev = {
        **hub.host_status(ch),
        "session": {k: v for k, v in sess.items() if k != "user_id"},
        "meta": ch.meta,
        "orch": ch.orch,
    }
    # Replay: primero lo guardado (sobrevive al reinicio del gateway y a las
    # sesiones de días), luego lo que el buffer en memoria tenga por encima.
    buffered = hub.replay(ch, from_seq)
    oldest_buffered = buffered[0].get("seq", 0) if buffered else None
    stored = await asyncio.to_thread(list_remote_events, sess["id"], from_seq)
    if oldest_buffered is not None:
        stored = [ev for ev in stored if ev.get("seq", 0) < oldest_buffered]
    # Si el controller llega sin nada que mostrar, el host reemite un snapshot
    # completo (solo tiene sentido si sigue conectado).
    if from_seq == 0 and ch.host_connected and not stored:
        hub.push_command(ch, {"type": "request_snapshot", "from_seq": 0})
    return [status_ev] + stored + buffered


def _queue_command(ch, payload: dict[str, Any], rid: Any = None) -> None:
    """Valida un comando del controller y lo encola para el host."""
    kind = payload.get("type")
    if kind not in CONTROLLER_COMMANDS:
        raise HTTPException(status_code=422, detail=f"Comando no soportado: {kind}")
    attachments = _clean_attachments(payload.get("attachments")) if kind == "prompt" else []
    if kind == "prompt" and not (payload.get("text") or "").strip() and not attachments:
        raise HTTPException(status_code=422, detail="El prompt está vacío")
    if not hub.host_online(ch):
        raise HTTPException(status_code=409, detail="El host no está conectado ahora mismo")
    if hub.seen_request(ch, rid):
        return
    command = {k: payload.get(k) for k in ("type", "text", "id", "decision", "from_seq") if k in payload}
    if kind == "prompt":
        if attachments:
            command["attachments"] = attachments
        mentions = _clean_mentions(payload.get("mentions"))
        if mentions:
            command["mentions"] = mentions
    if kind == "files":
        command["query"] = str(payload.get("query") or "")[:200]
    if kind == "config":
        # Modelo y/o esfuerzo de la sesión; el host solo acepta los que ofrece.
        for key in ("model", "effort"):
            value = payload.get(key)
            if isinstance(value, str) and len(value) <= 120:
                command[key] = value
        if "model" not in command and "effort" not in command:
            raise HTTPException(status_code=422, detail="Nada que cambiar")
    if kind == "orch":
        action = payload.get("action")
        args = payload.get("args") or {}
        if action not in ORCH_ACTIONS or not isinstance(args, dict):
            raise HTTPException(status_code=422, detail="Acción del orquestador no soportada")
        if len(json.dumps(args, default=str)) > MAX_ORCH_ARGS:
            raise HTTPException(status_code=413, detail="Argumentos del orquestador demasiado grandes")
        command["action"] = action
        command["args"] = args
    if not hub.push_command(ch, command):
        raise HTTPException(status_code=429, detail="El host tiene demasiados comandos pendientes")


# ── SSE + POST (CLI y clientes anteriores al WebSocket) ─────────────────────

@router.get("/api/remote/sessions/{session_id}/commands")
async def host_commands_stream(
    session_id: str,
    last_cmd: int | None = None,
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    """SSE de larga duración con los comandos que el host debe ejecutar."""
    sess = await _owner(session_id, lixbon_session, authorization)
    if sess["status"] == "ended":
        raise HTTPException(status_code=410, detail="La sesión remota ya terminó")
    ch = hub.channel(session_id, sess["user_id"])
    gen_id, queue = await _host_attached(ch, sess, last_cmd)

    async def gen():
        try:
            # cmd_seq actual: si el gateway se reinició el contador vuelve a
            # empezar y el host debe olvidar su último comando visto.
            async for chunk in _sse(queue, first=[{"type": "channel", "cmd_seq": ch.cmd_seq}]):
                yield chunk
        finally:
            _host_detached(ch, sess, gen_id)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/api/remote/sessions/{session_id}/events")
async def host_publish_events(
    session_id: str,
    payload: dict[str, Any],
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    """El host publica un lote de eventos del transcript."""
    sess = await _owner(session_id, lixbon_session, authorization)
    ch = hub.channel(session_id, sess["user_id"])
    return {"seq": await _publish(ch, sess, payload.get("events") or [])}


@router.get("/api/remote/sessions/{session_id}/stream")
async def controller_events_stream(
    session_id: str,
    from_seq: int = 0,
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    """SSE con el transcript en vivo (+replay desde from_seq). Solo el dueño."""
    sess = await _owner(session_id, lixbon_session, authorization)
    if sess["status"] == "ended":
        raise HTTPException(status_code=410, detail="La sesión remota ya terminó")
    ch = hub.channel(session_id, sess["user_id"])
    cid, queue = hub.attach_controller(ch)
    first = await _controller_first(ch, sess, from_seq)

    async def gen():
        try:
            async for chunk in _sse(queue, first=first):
                yield chunk
        finally:
            hub.detach_controller(ch, cid)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.get("/api/remote/sessions/{session_id}/transcript")
async def controller_transcript(
    session_id: str,
    from_seq: int = 0,
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    """Transcript guardado de la sesión, sin SSE.

    Es la vista de lectura de una sesión ya terminada: el host se fue, no hay
    canal en vivo, pero la conversación sigue estando.
    """
    sess = await _owner(session_id, lixbon_session, authorization)
    events = await asyncio.to_thread(list_remote_events, session_id, from_seq)
    return {
        "session": {k: v for k, v in sess.items() if k != "user_id"},
        "events": events,
        "last_seq": events[-1].get("seq", from_seq) if events else from_seq,
    }


@router.post("/api/remote/sessions/{session_id}/commands")
async def controller_send_command(
    session_id: str,
    payload: dict[str, Any],
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    """El controller manda un comando al host: prompt | interrupt | approve |
    request_snapshot | files (buscar archivos del workspace para mencionarlos)."""
    sess = await _owner(session_id, lixbon_session, authorization)
    if sess["status"] == "ended":
        raise HTTPException(status_code=410, detail="La sesión remota ya terminó")
    _queue_command(hub.channel(session_id, sess["user_id"]), payload, payload.get("rid"))
    return {"queued": True}


# ── WebSocket ───────────────────────────────────────────────────────────────
# Una sola conexión por lado: el móvil recibe eventos y manda comandos (con
# acuse por `rid`); el host recibe comandos y publica eventos. Sin una
# petición HTTP por mensaje, el texto llega a medida que el agente lo escribe.

WS_CLOSE = {401: 4401, 404: 4404, 410: 4410}


async def _ws_session(ws: WebSocket, session_id: str) -> dict[str, Any] | None:
    cookie = ws.cookies.get("lixbon_session")
    authorization = ws.headers.get("authorization")
    # Un WebSocket de navegador (web, IDE) no puede mandar cabeceras y la API
    # key no va en la URL (queda en los logs): llega en el primer mensaje.
    if not cookie and not authorization:
        try:
            hello = json.loads(await asyncio.wait_for(ws.receive_text(), timeout=WS_AUTH_SECONDS))
        except (asyncio.TimeoutError, ValueError, WebSocketDisconnect):
            hello = None
        token = hello.get("token") if isinstance(hello, dict) and hello.get("op") == "auth" else None
        if isinstance(token, str) and token:
            authorization = f"Bearer {token}"
    try:
        sess = await _owner(session_id, cookie, authorization)
    except HTTPException as exc:
        await ws.close(code=WS_CLOSE.get(exc.status_code, 4400), reason=str(exc.detail)[:120])
        return None
    if sess["status"] == "ended":
        await ws.close(code=4410, reason="La sesión remota ya terminó")
        return None
    return sess


async def _ws_run(ws: WebSocket, pump, listen, idle: float) -> str:
    """Corre emisor y receptor hasta que uno acaba. Devuelve por qué."""
    lock = asyncio.Lock()

    async def send(ev: dict[str, Any]) -> None:
        async with lock:
            await ws.send_text(json.dumps(ev, ensure_ascii=False))

    async def receive():
        while True:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=idle)
            except asyncio.TimeoutError:
                return "idle"
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get("op") == "ping":
                await send({"type": "pong"})
            else:
                await listen(msg, send)

    tasks = [asyncio.ensure_future(pump(send)), asyncio.ensure_future(receive())]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        task = done.pop()
        return "error" if task.exception() else (task.result() or "closed")
    finally:
        for t in tasks:
            t.cancel()


async def _ws_pump(queue: asyncio.Queue, send, first: list[dict[str, Any]]) -> str:
    for ev in first:
        await send(ev)
    while True:
        try:
            ev = await asyncio.wait_for(queue.get(), timeout=WS_PING_SECONDS)
        except asyncio.TimeoutError:
            await send({"type": "ping"})
            continue
        if ev is None:
            return "replaced"
        await send(ev)
        if ev.get("type") in ("session_ended", "bye"):
            return "ended"


async def _ws_close(ws: WebSocket, why: str) -> None:
    code = {"ended": 4410, "replaced": 4409, "idle": 4408}.get(why, 1000)
    try:
        await ws.close(code=code)
    except Exception:
        pass


@router.websocket("/api/remote/sessions/{session_id}/ws")
async def controller_ws(ws: WebSocket, session_id: str, from_seq: int = 0) -> None:
    await ws.accept()
    sess = await _ws_session(ws, session_id)
    if sess is None:
        return
    ch = hub.channel(session_id, sess["user_id"])
    cid, queue = hub.attach_controller(ch)
    first = await _controller_first(ch, sess, from_seq)

    async def listen(msg: dict[str, Any], send) -> None:
        if msg.get("op") != "cmd":
            return
        rid = msg.get("rid")
        try:
            if hub.get(session_id) is not ch:
                raise HTTPException(status_code=410, detail="La sesión remota ya terminó")
            _queue_command(ch, msg.get("command") or {}, rid)
            await send({"type": "ack", "rid": rid, "ok": True})
        except HTTPException as exc:
            detail = exc.detail.get("message") if isinstance(exc.detail, dict) else exc.detail
            await send({"type": "ack", "rid": rid, "ok": False, "status": exc.status_code, "detail": detail})

    why = "error"
    try:
        why = await _ws_run(ws, lambda send: _ws_pump(queue, send, first), listen, CONTROLLER_IDLE_SECONDS)
    except WebSocketDisconnect:
        pass
    finally:
        hub.detach_controller(ch, cid)
        await _ws_close(ws, why)


@router.websocket("/api/remote/sessions/{session_id}/host")
async def host_ws(ws: WebSocket, session_id: str, last_cmd: int | None = None) -> None:
    await ws.accept()
    sess = await _ws_session(ws, session_id)
    if sess is None:
        return
    ch = hub.channel(session_id, sess["user_id"])
    gen_id, queue = await _host_attached(ch, sess, last_cmd)

    async def listen(msg: dict[str, Any], send) -> None:
        if msg.get("op") != "events":
            return
        rid = msg.get("rid")
        try:
            # Un lote reenviado tras un corte (el acuse no llegó) no se repite.
            seq = ch.last_seq if hub.seen_request(ch, rid) else await _publish(ch, sess, msg.get("events") or [])
            await send({"type": "ack", "rid": rid, "ok": True, "seq": seq})
        except HTTPException as exc:
            await send({"type": "ack", "rid": rid, "ok": False, "status": exc.status_code, "detail": exc.detail})

    why = "error"
    try:
        first = [{"type": "channel", "cmd_seq": ch.cmd_seq}]
        why = await _ws_run(ws, lambda send: _ws_pump(queue, send, first), listen, HOST_IDLE_SECONDS)
    except WebSocketDisconnect:
        pass
    finally:
        _host_detached(ch, sess, gen_id)
        await _ws_close(ws, why)


@router.get("/api/remote/subscribe")
async def subscribe_sessions_stream(
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    """SSE de avisos: sesión creada / online / offline / terminada."""
    user = session_or_api_key(lixbon_session, authorization)
    queue = hub.subscribe_user(user["id"])

    async def gen():
        try:
            async for chunk in _sse(queue):
                yield chunk
        finally:
            hub.unsubscribe_user(user["id"], queue)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/api/remote/devices")
async def register_device_endpoint(
    payload: dict[str, Any],
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    user = session_or_api_key(lixbon_session, authorization)
    token = (payload.get("token") or payload.get("expo_push_token") or "").strip()
    if not token or len(token) > 300:
        raise HTTPException(status_code=422, detail="Push token inválido")
    register_device_token(user["id"], token, (payload.get("platform") or "").strip() or None)
    return {"registered": True}


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
    session_or_api_key(lixbon_session, authorization)
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
