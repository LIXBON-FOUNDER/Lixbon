"""
admin.py — Endpoints de administración de FOLAX DTC.
Incluye: dashboard, health, estado del sistema, nodos y uso.
"""
from __future__ import annotations
from typing import Any

from fastapi import APIRouter, Depends, Request


from core.gateway import deps
from core.config import OLLAMA_BASE_URL, RATE_LIMIT_PER_MIN
from core.persistence.queries import (
    get_usage_summary,
    list_api_keys,
    list_audit_events,
    list_clients_usage,
    list_recent_conversations,
    validate_api_key,
)
from core.security.auth import cookie_auth_required
from core.gateway.utils import fetch_models

router = APIRouter()


# ── Dashboard API ──────────────────────────────────────────────────────────

@router.get("/api/dashboard/init")
async def dashboard_init(
    request: Request,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    user_id = user_data["id"]
    return {
        "user": user_data,
        "usage": get_usage_summary(user_id),
        "conversations": list_recent_conversations(user_id=user_id),
        "clients": list_clients_usage(user_id=user_id),
        "keys": list_api_keys(user_id=user_id),
        "models": await fetch_models(),
        "ollama_url": OLLAMA_BASE_URL,
        "rate_limit_per_min": RATE_LIMIT_PER_MIN,
        "server_base_url": str(request.base_url).rstrip("/"),
    }


# ── API de estado ──────────────────────────────────────────────────────────

@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "FOLAX DTC"}


@router.get("/api/status")
async def api_status(user_data: dict[str, Any] = Depends(cookie_auth_required)):
    models = await fetch_models()
    ollama_ok = not (models and str(models[0].get("id", "")).startswith("error:"))
    return {
        "user": user_data,
        "ollama_ok": ollama_ok,
        "ollama_url": OLLAMA_BASE_URL,
        "rate_limit_per_min": RATE_LIMIT_PER_MIN,
    }


@router.get("/api/usage")
async def api_usage(user_data: dict[str, Any] = Depends(cookie_auth_required)):
    return get_usage_summary(user_data["id"])


# ── API de nodos ───────────────────────────────────────────────────────────

@router.get("/api/nodes")
async def api_nodos(user_data: dict[str, Any] = Depends(cookie_auth_required)):
    """Lista todos los nodos con su estado y métricas actuales."""
    return {"nodos": deps.orquestador.estado_nodos()}


@router.get("/api/nodes/best")
async def api_mejor_nodo(user_data: dict[str, Any] = Depends(cookie_auth_required)):
    """Muestra cuál sería el nodo elegido en este momento."""
    nodo = deps.orquestador.best_node()
    if not nodo:
        return {"nodo": None, "mensaje": "Sin nodos online. Se usará Ollama local."}
    return {"nodo": nodo}


@router.post("/api/nodes/reload")
async def api_reload_nodes(user_data: dict[str, Any] = Depends(cookie_auth_required)):
    """Recarga los nodos desde la BD en caliente, sin reiniciar el servidor."""
    deps.orquestador.cargar_nodos()
    return {"reloaded": True, "nodos": len(deps.orquestador._nodos)}


# ── API de audit log ───────────────────────────────────────────────────────

@router.get("/api/audit")
async def api_audit(
    limit: int = 50,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    """Devuelve los últimos eventos del audit log del usuario."""
    return {"events": list_audit_events(user_id=user_data["id"], limit=limit)}
