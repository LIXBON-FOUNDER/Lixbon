"""
nodes_admin.py — CRUD de nodos GPU del cluster (solo admin).
Los nodos viven en la tabla `nodes`; el orquestador se recarga tras cada cambio.
El panel visual llega en F6; estos endpoints son su API.
"""
from __future__ import annotations

import re
import secrets
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core.gateway import deps
from core.persistence.queries import delete_node, list_nodes, upsert_node
from core.security.auth import require_admin_token

router = APIRouter(prefix="/api/admin/nodes", tags=["admin-nodes"])

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")


class NodePayload(BaseModel):
    id: str = Field(..., description="Slug del nodo, ej: gpu-01")
    name: str = Field(..., description="Nombre visible, ej: PC Gabriel RTX")
    agent_url: str = Field(..., description="URL del node_agent, ej: https://gpu-01.datacentgbx.online")
    token: str | None = Field(None, description="Token del nodo; si se omite se genera uno nuevo")
    enabled: bool = True


@router.get("")
async def get_nodes(_: None = Depends(require_admin_token)) -> dict[str, Any]:
    """Lista los nodos registrados (token enmascarado) + estado en vivo del orquestador."""
    return {
        "nodes": list_nodes(mask_token=True),
        "live_status": deps.orquestador.estado_nodos(),
    }


@router.post("")
async def create_or_update_node(
    payload: NodePayload,
    _: None = Depends(require_admin_token),
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
    return {
        "node": {**node, "token": None},
        "token": token,
        "message": "Configura este token como NODE_SHARED_SECRET en el node_agent de esa PC. No se volverá a mostrar completo.",
    }


@router.delete("/{node_id}")
async def remove_node(node_id: str, _: None = Depends(require_admin_token)) -> dict[str, Any]:
    deleted = delete_node(node_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Nodo '{node_id}' no existe")
    deps.orquestador.cargar_nodos()
    return {"deleted": True, "node_id": node_id}
