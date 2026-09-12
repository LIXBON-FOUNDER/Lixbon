"""
nodes_admin.py — CRUD de nodos GPU del cluster (rol admin, F6).
Los nodos viven en la tabla `nodes`; el orquestador se recarga tras cada cambio.

Además de los nodos por URL, gestiona los tokens de enrolamiento con los que
una máquina nueva se registra sola (ver nodes_link.py).
"""
from __future__ import annotations

import re
import secrets
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from core.config import PUBLIC_BASE_URL
from core.gateway import deps
from core.orchestration.node_link import registro
from core.persistence.queries import (
    create_enrollment,
    delete_node,
    get_node,
    list_enrollments,
    list_nodes,
    log_audit_event,
    revoke_enrollment,
    upsert_node,
)
from core.security.auth import admin_required

router = APIRouter(prefix="/api/admin/nodes", tags=["admin-nodes"])

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")


class NodePayload(BaseModel):
    id: str = Field(..., description="Slug del nodo, ej: gpu-01")
    name: str = Field(..., description="Nombre visible, ej: PC Gabriel RTX")
    agent_url: str | None = Field(None, description="URL del node_agent (modo URL). Vacío = el nodo se conecta solo")
    token: str | None = Field(None, description="Token del nodo; si se omite se genera uno nuevo")
    enabled: bool = True
    provider: str | None = Field(None, max_length=40)


class EnrollmentPayload(BaseModel):
    label: str | None = Field(None, max_length=80, description="Para qué es este token, ej: RunPod A100")
    ttl_hours: int = Field(24, ge=1, le=24 * 30)


def _comando_instalacion(token: str, request: Request) -> dict[str, str]:
    base = PUBLIC_BASE_URL or str(request.base_url).rstrip("/")
    return {
        "linux": f"curl -fsSL {base}/install-node.sh | LIXBON_ENROLL={token} bash",
        "docker_env": f"LIXBON_GATEWAY={base}\nLIXBON_ENROLL={token}",
        "manual": f"LIXBON_ENROLL={token} python -m core.node_agent.agent --connect {base}",
    }


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
    agent_url = (payload.agent_url or "").strip().rstrip("/") or None
    if agent_url and not agent_url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="agent_url debe ser una URL http(s)")

    # Editar sin token conserva el que hay: rotarlo sin querer dejaría fuera al
    # agente (en modo conexión la identidad vive en la máquina, no aquí).
    existente = get_node(payload.id, mask_token=False)
    token = payload.token or (existente["token"] if existente else secrets.token_urlsafe(32))
    nuevo_token = token != (existente or {}).get("token")
    node = upsert_node(
        node_id=payload.id,
        name=payload.name,
        agent_url=agent_url,
        token=token,
        enabled=payload.enabled,
        provider=payload.provider,
    )
    deps.orquestador.cargar_nodos()
    log_audit_event("node_upserted", user_id=admin["id"], node_id=payload.id)
    mensaje = (
        "Configura este token como NODE_SHARED_SECRET en el node_agent de esa PC."
        if agent_url else
        "Guarda este secreto como LIXBON_NODE_SECRET en la máquina (o usa un token de enrolamiento)."
    ) + " No se volverá a mostrar completo."
    return {"node": {**node, "token": None}, "token": token if nuevo_token else None, "message": mensaje}


@router.get("/enrollments")
async def get_enrollments(_admin: dict[str, Any] = Depends(admin_required)) -> dict[str, Any]:
    return {"enrollments": list_enrollments()}


@router.post("/enrollments")
async def new_enrollment(
    payload: EnrollmentPayload,
    request: Request,
    admin: dict[str, Any] = Depends(admin_required),
) -> dict[str, Any]:
    """Genera un token de enrolamiento y el comando listo para pegar en la máquina.
    El token completo solo se devuelve aquí."""
    enrollment = create_enrollment(payload.label, admin["id"], payload.ttl_hours)
    log_audit_event("node_enrollment_created", user_id=admin["id"], enrollment_id=enrollment["id"])
    return {
        "enrollment": enrollment,
        "commands": _comando_instalacion(enrollment["token"], request),
    }


@router.delete("/enrollments/{enrollment_id}")
async def drop_enrollment(enrollment_id: str, admin: dict[str, Any] = Depends(admin_required)) -> dict[str, Any]:
    if not revoke_enrollment(enrollment_id):
        raise HTTPException(status_code=404, detail="Token de enrolamiento no existe")
    log_audit_event("node_enrollment_revoked", user_id=admin["id"], enrollment_id=enrollment_id)
    return {"revoked": True, "id": enrollment_id}


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
    link = registro.get(node_id)
    if link is not None:
        link.cerrar()
        try:
            await link.ws.close(code=4403)
        except Exception:
            pass
    deps.orquestador.cargar_nodos()
    log_audit_event("node_deleted", user_id=admin["id"], node_id=node_id)
    return {"deleted": True, "node_id": node_id}
