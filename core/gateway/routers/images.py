"""Generación de imágenes en un nodo con modelo de difusión (agente ≥ 4.1).

- GET  /api/images/status   : si hay algún nodo online que genere imágenes y con qué modelo
- POST /api/images/generate : una imagen (JPEG base64); opcionalmente se guarda en
                              una conversación como mensaje con la imagen en Markdown

El nodo se elige por score entre los que anuncian `image_model`; la petición
viaja por el enlace WS igual que un chat. Aún no hay tarifa por imagen: se
registra como uso del plan con un equivalente en tokens.
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core.billing.quota import ensure_can_chat, ensure_can_use_visuals, record_tokens
from core.gateway import deps
from core.orchestration.node_link import LOAD_TIMEOUT, NodeLinkError, registro
from core.persistence.queries import ensure_conversation, get_plan_for_user, save_message
from core.security.auth import web_or_api_key_auth

logger = logging.getLogger("lixbon.images")
router = APIRouter(tags=["images"])

IMAGE_TOKEN_EQUIV = 2000  # lo que cuenta una imagen en la cuota del plan mientras no haya tarifa propia


class ImageRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=2000)
    negative_prompt: str | None = Field(None, max_length=1000)
    width: int = Field(1024, ge=256, le=2048)
    height: int = Field(1024, ge=256, le=2048)
    steps: int | None = Field(None, ge=1, le=60)
    seed: int | None = None
    guidance: float | None = Field(None, ge=0, le=30)
    conversation_id: str | None = None
    source: str | None = None


def image_nodes() -> list[dict[str, Any]]:
    """Nodos online que generan imágenes, del mejor al peor score."""
    out = []
    for nodo in deps.orquestador.estado_nodos():
        modelo = (nodo.get("metricas") or {}).get("image_model")
        if nodo.get("online") and modelo:
            out.append({"id": nodo["id"], "name": nodo.get("name"), "score": nodo.get("score") or 0,
                        "model": modelo, "error": (nodo.get("metricas") or {}).get("image_error")})
    return sorted(out, key=lambda n: -n["score"])


@router.get("/api/images/status")
async def api_images_status(_user: dict[str, Any] = Depends(web_or_api_key_auth)):
    nodos = image_nodes()
    return {"available": bool(nodos), "model": nodos[0]["model"] if nodos else None,
            "nodes": [{"id": n["id"], "name": n["name"], "model": n["model"]} for n in nodos]}


@router.post("/api/images/generate")
async def api_images_generate(
    payload: ImageRequest,
    user_data: dict[str, Any] = Depends(web_or_api_key_auth),
):
    nodos = image_nodes()
    if not nodos:
        raise HTTPException(status_code=503, detail={
            "code": "no_image_node",
            "message": "Ningún nodo online genera imágenes ahora mismo.",
        })
    plan = get_plan_for_user(user_data["id"])
    if (payload.source or "visuals") == "visuals":
        ensure_can_use_visuals(user_data, plan)
    ensure_can_chat(user_data["id"], plan)

    ultimo_error = "sin nodos"
    resultado: dict[str, Any] | None = None
    for nodo in nodos:
        link = registro.get(nodo["id"])
        if link is None:
            continue
        try:
            resp = await link.request("POST", "/images/generate", {
                "prompt": payload.prompt, "negative_prompt": payload.negative_prompt or "",
                "width": payload.width, "height": payload.height, "steps": payload.steps,
                "seed": payload.seed, "guidance": payload.guidance,
            }, connect_timeout=LOAD_TIMEOUT)
            cuerpo = b"".join([trozo async for trozo in resp.chunks(600.0)])
            datos = json.loads(cuerpo.decode("utf-8") or "{}")
            if resp.status != 200:
                ultimo_error = str(datos.get("error") or f"HTTP {resp.status}")
                logger.warning(f"[images] nodo {nodo['id']} respondió {resp.status}: {ultimo_error}")
                continue
            resultado = {**datos, "node": nodo["id"]}
            break
        except NodeLinkError as exc:
            ultimo_error = str(exc)
            logger.warning(f"[images] nodo {nodo['id']} falló: {exc}")
    if resultado is None:
        raise HTTPException(status_code=502, detail={"code": "image_failed", "message": ultimo_error})

    record_tokens(user_data["id"], IMAGE_TOKEN_EQUIV)

    conv_id = payload.conversation_id
    if conv_id and user_data.get("auth_via") == "session":
        # La imagen queda en la conversación como Markdown: al reabrirla se ve.
        if ensure_conversation(conv_id, user_data["id"], None, "web", source=payload.source or "visuals"):
            save_message(conv_id, "user", payload.prompt, model=resultado.get("model"))
            data_url = f"data:{resultado.get('mime', 'image/jpeg')};base64,{resultado['image_base64']}"
            save_message(conv_id, "assistant", f"![{payload.prompt[:80]}]({data_url})", model=resultado.get("model"))
        else:
            conv_id = None
    return {**resultado, "conversation_id": conv_id or str(uuid.uuid4()), "at": time.time()}
