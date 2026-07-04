"""
keys.py — Endpoints de gestión de API keys en FOLAX DTC.
"""
from __future__ import annotations
from typing import Any

from fastapi import APIRouter, Depends, Request

from core.persistence.queries import create_api_key, deactivate_key, log_audit_event
from core.security.auth import api_key_required, cookie_auth_required

router = APIRouter()


@router.post("/api/keys")
async def create_api_key_endpoint(
    payload: dict[str, Any],
    request: Request,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    """Crea una nueva API key (opcionalmente restringida a un modelo)."""
    name = (payload.get("name") or "").strip()
    model = (payload.get("model") or "").strip() or None
    if not name:
        name = model or "Nueva Key"
    ip = request.client.host if request.client else None
    raw_key, key_data = create_api_key(name, user_data["id"], model)
    log_audit_event(
        "api_key_created",
        user_id=user_data["id"],
        key_id=key_data["id"],
        ip_address=ip,
    )
    return {"api_key": raw_key, "data": key_data}


@router.delete("/api/keys/{key_id}")
async def delete_api_key(
    key_id: int,
    request: Request,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    """Soft-delete de una API key. Solo keys del propio usuario (anti-IDOR)."""
    from fastapi import HTTPException
    ip = request.client.host if request.client else None
    if not deactivate_key(key_id, user_id=user_data["id"]):
        raise HTTPException(status_code=404, detail="La key no existe o no te pertenece")
    log_audit_event(
        "api_key_deleted",
        user_id=user_data["id"],
        key_id=key_id,
        ip_address=ip,
    )
    return {"deleted": True, "key_id": key_id}


@router.get("/api/key/info")
async def api_key_info(user_data: dict[str, Any] = Depends(api_key_required)):
    """Devuelve información de la API key actual (usuario y modelo vinculado)."""
    return {
        "user": user_data.get("username"),
        "key_model": user_data.get("key_model"),
    }
