"""
conversations.py — Historial de conversaciones de la web (F4).
Listar, retomar, renombrar, borrar y auto-título con el modelo pequeño.
Todos los endpoints exigen sesión (cookie) y verifican pertenencia.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from core.gateway.routers.chat import _routed_chat
from core.gateway.utils import fetch_models
from core.delegation.embeddings import pick_classifier_model
from core.persistence.queries import (
    delete_conversation,
    get_conversation,
    list_conversations,
    list_messages,
    rename_conversation,
)
from core.security.auth import cookie_auth_required

logger = logging.getLogger("folax.conversations")
router = APIRouter()

TITLE_PROMPT = (
    "Genera un título corto (máximo 6 palabras) que resuma la conversación. "
    "Responde SOLO con el título, sin comillas ni punto final, en el idioma del usuario."
)


class RenamePayload(BaseModel):
    title: str = Field(..., min_length=1, max_length=120)


@router.get("/api/conversations")
async def api_list_conversations(
    q: str | None = Query(default=None, max_length=120),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    items = list_conversations(user_data["id"], limit=limit, offset=offset, q=q)
    return {"conversations": items, "limit": limit, "offset": offset}


@router.get("/api/conversations/{conversation_id}/messages")
async def api_conversation_messages(
    conversation_id: str,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    messages = list_messages(conversation_id, user_data["id"])
    if messages is None:
        raise HTTPException(status_code=404, detail="Conversación no encontrada")
    conv = get_conversation(conversation_id, user_data["id"])
    return {"conversation": conv, "messages": messages}


@router.patch("/api/conversations/{conversation_id}")
async def api_rename_conversation(
    conversation_id: str,
    payload: RenamePayload,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    if not rename_conversation(conversation_id, user_data["id"], payload.title.strip()):
        raise HTTPException(status_code=404, detail="Conversación no encontrada")
    return {"id": conversation_id, "title": payload.title.strip()}


@router.delete("/api/conversations/{conversation_id}")
async def api_delete_conversation(
    conversation_id: str,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    if not delete_conversation(conversation_id, user_data["id"]):
        raise HTTPException(status_code=404, detail="Conversación no encontrada")
    return {"deleted": conversation_id}


@router.post("/api/conversations/{conversation_id}/generate-title")
async def api_generate_title(
    conversation_id: str,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    """
    Auto-título tras el primer intercambio: pide un título corto al modelo
    pequeño del cluster. Solo escribe si la conversación sigue sin título.
    """
    conv = get_conversation(conversation_id, user_data["id"])
    if not conv:
        raise HTTPException(status_code=404, detail="Conversación no encontrada")
    if conv.get("title"):
        return {"id": conversation_id, "title": conv["title"], "generated": False}

    messages = list_messages(conversation_id, user_data["id"]) or []
    if not messages:
        raise HTTPException(status_code=400, detail="La conversación no tiene mensajes")

    # Primer intercambio (recortado) como contexto para el título
    excerpt = "\n".join(
        f"{m['role']}: {m['content'][:400]}" for m in messages[:2]
    )
    available = [
        m["id"] for m in await fetch_models()
        if not str(m.get("id", "")).startswith("error:")
    ]
    model = pick_classifier_model(available)
    if not model:
        raise HTTPException(status_code=503, detail="No hay modelos disponibles")

    try:
        resp, _ = await _routed_chat(model, [
            {"role": "system", "content": TITLE_PROMPT},
            {"role": "user", "content": excerpt},
        ])
        title = (resp.get("message", {}).get("content") or "").strip().strip('"').strip()
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning(f"[autotitle] Falló la generación ({exc})")
        raise HTTPException(status_code=502, detail="No se pudo generar el título") from exc

    # Limpieza: los modelos pequeños a veces devuelven markdown ('# Título', '**x**')
    title = " ".join(title.split()).strip("#*`_ ").strip()[:80] or "Sin título"
    rename_conversation(conversation_id, user_data["id"], title, only_if_untitled=True)
    # Releer por si otra petición tituló primero
    conv = get_conversation(conversation_id, user_data["id"])
    return {"id": conversation_id, "title": (conv or {}).get("title", title), "generated": True}
