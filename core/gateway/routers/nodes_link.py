"""
nodes_link.py — Lado gateway de los nodos por conexión inversa.

- POST /api/nodes/enroll : una máquina nueva canjea un token de enrolamiento
  (generado por el admin) por su `node_id` + secreto. Sin sesión: el token es
  la credencial.
- WS   /api/nodes/ws     : el node_agent se autentica con `hello` y se queda
  conectado; por ese socket empuja métricas y atiende la inferencia.
- GET  /install-node.sh, /node-agent.py : instalador de un comando y el agente
  en sí, para que una máquina nueva no necesite clonar el repo.
"""
from __future__ import annotations

import json
import logging
import re
import secrets
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from core.config import PUBLIC_BASE_URL
from core.gateway import deps
from core.orchestration.node_link import NodeLink, registro
from core.persistence.queries import (
    consume_enrollment,
    get_node,
    log_audit_event,
    touch_node,
    upsert_node,
)

logger = logging.getLogger("lixbon.nodes_link")
router = APIRouter(tags=["nodes-link"])

METRICS_INTERVAL = 10
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")
_RAIZ = Path(__file__).resolve().parents[3]
_INSTALADOR = _RAIZ / "infra" / "node" / "install-node.sh"
_AGENTE = _RAIZ / "core" / "node_agent" / "agent.py"


class EnrollPayload(BaseModel):
    enroll_token: str = Field(..., min_length=8)
    name: str | None = Field(None, max_length=80)
    hostname: str | None = Field(None, max_length=120)
    provider: str | None = Field(None, max_length=40)
    agent_version: str | None = Field(None, max_length=20)
    # Id fijo opcional: un pod que se reinicia con la misma plantilla vuelve a
    # ser el mismo nodo en vez de dejar uno huérfano por arranque.
    node_id: str | None = Field(None, max_length=42)


def _base(request: Request) -> str:
    return PUBLIC_BASE_URL or str(request.base_url).rstrip("/")


def _ws_url(request: Request) -> str:
    return re.sub(r"^http", "ws", _base(request)) + "/api/nodes/ws"


@router.get("/install-node.sh", response_class=PlainTextResponse, include_in_schema=False)
async def install_script(request: Request) -> str:
    script = _INSTALADOR.read_text(encoding="utf-8").replace("\r\n", "\n")
    return script.replace("__GATEWAY__", _base(request))


@router.get("/node-agent.py", response_class=PlainTextResponse, include_in_schema=False)
async def agent_source() -> str:
    return _AGENTE.read_text(encoding="utf-8")


@router.post("/api/nodes/enroll")
async def enroll_node(payload: EnrollPayload, request: Request) -> dict[str, Any]:
    enrollment = await run_in_threadpool(consume_enrollment, payload.enroll_token)
    if enrollment is None:
        raise HTTPException(status_code=401, detail="Token de enrolamiento inválido, caducado o revocado")

    if payload.node_id:
        node_id = payload.node_id.lower()
        if not _SLUG_RE.fullmatch(node_id):
            raise HTTPException(status_code=400, detail="node_id inválido: minúsculas, números y guiones")
        existente = await run_in_threadpool(get_node, node_id)
        if existente and existente["agent_url"]:
            raise HTTPException(status_code=409, detail=f"'{node_id}' ya existe como nodo por URL")
    else:
        node_id = "gpu-" + secrets.token_hex(2)
        while await run_in_threadpool(get_node, node_id):
            node_id = "gpu-" + secrets.token_hex(2)

    secreto = secrets.token_urlsafe(32)
    nombre = (payload.name or payload.hostname or node_id).strip()[:80]
    node = await run_in_threadpool(
        upsert_node, node_id, nombre, None, secreto, True, payload.provider, payload.hostname,
    )
    deps.orquestador.cargar_nodos()
    log_audit_event(
        "node_enrolled", node_id=node_id, enrollment_id=enrollment["id"],
        ip_address=request.client.host if request.client else None,
    )
    logger.info(f"Nodo enrolado: {node_id} ({nombre}) vía {enrollment['id']}")
    return {
        "node_id": node["id"],
        "name": node["name"],
        "secret": secreto,
        "ws_url": _ws_url(request),
        "metrics_interval": METRICS_INTERVAL,
    }


async def _autenticar(ws: WebSocket) -> dict[str, Any] | None:
    try:
        hello = json.loads(await ws.receive_text())
    except (WebSocketDisconnect, ValueError):
        return None
    if hello.get("type") != "hello":
        await ws.send_text(json.dumps({"type": "error", "code": "bad_hello", "message": "Se esperaba hello"}))
        return None
    node_id = str(hello.get("node_id") or "")
    secreto = str(hello.get("secret") or "")
    node = await run_in_threadpool(get_node, node_id, False) if node_id else None
    if not node or not secrets.compare_digest(node["token"], secreto):
        await ws.send_text(json.dumps({"type": "error", "code": "unauthorized", "message": "Nodo o secreto inválidos"}))
        return None
    if node["agent_url"]:
        await ws.send_text(json.dumps({"type": "error", "code": "url_node", "message": "Este nodo está registrado por URL"}))
        return None
    if not node["enabled"]:
        await ws.send_text(json.dumps({"type": "error", "code": "disabled", "message": "Nodo deshabilitado por el administrador"}))
        return None
    return {**hello, "node_id": node_id}


@router.websocket("/api/nodes/ws")
async def ws_node(ws: WebSocket) -> None:
    await ws.accept()
    hello = await _autenticar(ws)
    if hello is None:
        await ws.close(code=4401)
        return

    node_id = hello["node_id"]
    info = {k: hello.get(k) for k in ("hostname", "agent_version", "provider")}
    link = NodeLink(node_id, ws, info)
    anterior = registro.registrar(link)
    if anterior is not None:
        anterior.cerrar()
        try:
            await anterior.ws.close(code=4409)
        except Exception:
            pass
    deps.orquestador.nodo_conectado(node_id, info)
    await run_in_threadpool(touch_node, node_id, info.get("hostname"))
    await link.enviar({"type": "welcome", "node_id": node_id, "metrics_interval": METRICS_INTERVAL})

    try:
        while True:
            try:
                msg = json.loads(await ws.receive_text())
            except ValueError:
                continue
            tipo = msg.get("type")
            if tipo == "metrics":
                deps.orquestador.actualizar_metricas(node_id, msg.get("data") or {})
            elif tipo in ("response", "chunk", "end", "error"):
                link.entregar(msg)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning(f"[{node_id}] socket cerrado con error: {exc}")
    finally:
        link.cerrar()
        registro.quitar(link)
        if registro.get(node_id) is None:
            deps.orquestador.nodo_desconectado(node_id)
        try:
            await run_in_threadpool(touch_node, node_id)
        except Exception:
            pass
