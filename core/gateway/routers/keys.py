"""
keys.py — Endpoints de gestión de API keys en lixbon DTC.
"""
from __future__ import annotations
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from core.persistence.queries import (
    count_active_keys,
    create_api_key,
    deactivate_key,
    get_plan_for_user,
    list_api_keys,
    log_audit_event,
)
from core.security.auth import api_key_required, cookie_auth_required

router = APIRouter()


@router.get("/api/keys")
async def list_keys_endpoint(user_data: dict[str, Any] = Depends(cookie_auth_required)):
    """API keys del usuario (sin exponer la key: solo prefijo y metadatos)."""
    return {"keys": list_api_keys(user_id=user_data["id"])}


@router.post("/api/keys")
async def create_api_key_endpoint(
    payload: dict[str, Any],
    request: Request,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    """Crea una nueva API key (opcionalmente restringida a un modelo)."""
    # F5: tope de keys activas según el plan
    plan = get_plan_for_user(user_data["id"])
    max_keys = int(plan.get("max_api_keys", 1))
    if max_keys != -1 and count_active_keys(user_data["id"]) >= max_keys:
        raise HTTPException(status_code=403, detail={
            "code": "keys_quota",
            "scope": "api_keys",
            "message": f"El plan {plan['name']} permite máximo {max_keys} API key(s) activa(s). "
                       "Desactiva una o mejora tu plan.",
        })

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
