"""
nodes_admin.py — CRUD de nodos GPU del cluster (rol admin, F6).
Los nodos viven en la tabla `nodes`; el orquestador se recarga tras cada cambio.
"""
from __future__ import annotations

import re
import secrets
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from core.gateway import deps
from core.persistence.queries import delete_node, list_nodes, log_audit_event, upsert_node
from core.security.auth import admin_required

router = APIRouter(prefix="/api/admin/nodes", tags=["admin-nodes"])

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")


class NodePayload(BaseModel):
    id: str = Field(..., description="Slug del nodo, ej: gpu-01")
    name: str = Field(..., description="Nombre visible, ej: PC Gabriel RTX")
    agent_url: str = Field(..., description="URL del node_agent, ej: https://gpu-01.lixbon.com")
    token: str | None = Field(None, description="Token del nodo; si se omite se genera uno nuevo")
    enabled: bool = True


@router.get("")
async def get_nodes(_admin: dict[str, Any] = Depends(admin_required)) -> dict[str, Any]:
    """Lista los nodos registrados (token enmascarado) + estado en vivo del orquestador."""
    return {
        "nodes": list_nodes(mask_token=True),
        "live_status": deps.orquestador.estado_nodos(),
    }


@router.post("")
async def create_or_update_node(
    payload: NodePayload,
    admin: dict[str, Any] = Depends(admin_required),
) -> dict[str, Any]:
    """
    Registra o actualiza un nodo. Si no se envía token, se genera uno nuevo y se
    retorna UNA vez: configúralo como NODE_SHARED_SECRET en el node_agent de esa PC.
    """
    if not _SLUG_RE.fullmatch(payload.id):
        raise HTTPException(status_code=400, detail="id inválido: usa minúsculas, números y guiones (ej: gpu-01)")
    if not payload.agent_url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="agent_url debe ser una URL http(s)")

    token = payload.token or secrets.token_urlsafe(32)
    node = upsert_node(
        node_id=payload.id,
        name=payload.name,
        agent_url=payload.agent_url.rstrip("/"),
        token=token,
        enabled=payload.enabled,
    )
    deps.orquestador.cargar_nodos()
    log_audit_event("node_upserted", user_id=admin["id"], node_id=payload.id)
    return {
        "node": {**node, "token": None},
        "token": token,
        "message": "Configura este token como NODE_SHARED_SECRET en el node_agent de esa PC. No se volverá a mostrar completo.",
    }


@router.post("/{node_id}/retry")
async def retry_node(node_id: str, admin: dict[str, Any] = Depends(admin_required)) -> dict[str, Any]:
    """Fuerza un reintento inmediato del nodo, ignorando el backoff del circuit breaker."""
    if node_id not in {n["id"] for n in list_nodes(mask_token=True)}:
        raise HTTPException(status_code=404, detail=f"Nodo '{node_id}' no existe")
    online = await run_in_threadpool(deps.orquestador.reintentar_nodo, node_id)
    log_audit_event("node_retry", user_id=admin["id"], node_id=node_id)
    return {"node_id": node_id, "online": online}


@router.delete("/{node_id}")
async def remove_node(node_id: str, admin: dict[str, Any] = Depends(admin_required)) -> dict[str, Any]:
    deleted = delete_node(node_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Nodo '{node_id}' no existe")
    deps.orquestador.cargar_nodos()
    log_audit_event("node_deleted", user_id=admin["id"], node_id=node_id)
    return {"deleted": True, "node_id": node_id}
