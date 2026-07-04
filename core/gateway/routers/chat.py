"""
chat.py — Endpoints de chat y completions (compatibles con OpenAI API).
Cubre: /v1/models, /v1/chat/completions, /v1/completions, /api/chat, /api/delegate
"""
from __future__ import annotations
import json
import logging
import time
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from core.gateway import deps
from core.config import OLLAMA_BASE_URL
from core.persistence.queries import ensure_conversation, find_similar_tasks, save_message, save_task_embedding
from core.delegation.embeddings import classify_request, get_embedding, pick_classifier_model, route_request
from core.security.auth import api_key_required, cookie_auth_required, validate_model_access
from core.gateway.utils import fetch_models

logger = logging.getLogger("folax.chat")
router = APIRouter()


# ── Modelos Pydantic ───────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    model: str = Field(..., description="Modelo de Ollama")
    messages: list[ChatMessage]
    conversation_id: str | None = None
    title: str | None = None
    client_id: str | None = None
    stream: bool = False


class UIChatRequest(BaseModel):
    model: str
    message: str
    conversation_id: str | None = None
    title: str | None = None


class CompletionRequest(BaseModel):
    model: str = Field(..., description="Modelo de Ollama")
    prompt: str
    conversation_id: str | None = None
    title: str | None = None
    client_id: str | None = None
    stream: bool = False


class DelegateRequest(BaseModel):
    user_input: str = Field(..., description="Solicitud del usuario en lenguaje natural")
    conversation_id: str | None = None


# ── Helpers internos de Ollama ─────────────────────────────────────────────

async def _ollama_chat(model: str, messages: list[dict]) -> dict[str, Any]:
    url = f"{OLLAMA_BASE_URL}/api/chat"
    payload = {"model": model, "messages": messages, "stream": False}
    try:
        client = deps.http_client_chat or httpx.AsyncClient(timeout=120.0)
        resp = await client.post(url, json=payload)
        resp.raise_for_status()
        return resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"Error de Ollama: {exc.response.text}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"No se pudo conectar con Ollama: {exc}") from exc


async def _ollama_chat_stream(model: str, messages: list[dict]):
    """Generador SSE para streaming de respuestas de Ollama."""
    url = f"{OLLAMA_BASE_URL}/api/chat"
    payload = {"model": model, "messages": messages, "stream": True}
    chat_id = f"chatcmpl-{uuid.uuid4()}"

    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as client:
        async with client.stream("POST", url, json=payload) as response:
            response.raise_for_status()
            last_keepalive = time.time()

            async for chunk in response.aiter_lines():
                now = time.time()
                # Keep-alive cada 5s para evitar timeouts de proxies (Cloudflare)
                if now - last_keepalive >= 5:
                    yield ": keep-alive\n\n"
                    last_keepalive = now
                if not chunk:
                    continue
                try:
                    data = json.loads(chunk)
                    content = data.get("message", {}).get("content", "")
                    done = data.get("done", False)
                    openai_chunk = {
                        "id": chat_id,
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": model,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {"content": content} if not done else {},
                                "finish_reason": "stop" if done else None,
                            }
                        ],
                    }
                    last_keepalive = time.time()
                    yield f"data: {json.dumps(openai_chunk)}\n\n"
                except Exception:
                    pass
        yield "data: [DONE]\n\n"


# ── Endpoints ──────────────────────────────────────────────────────────────

@router.get("/v1/models")
async def models(user_data: dict[str, Any] = Depends(api_key_required)):
    return {"object": "list", "data": await fetch_models()}


@router.post("/api/chat")
async def api_chat(
    payload: UIChatRequest,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    """Chat desde el dashboard web (sin Bearer token)."""
    conv_id = payload.conversation_id or str(uuid.uuid4())
    ensure_conversation(conv_id, user_data["id"], payload.title, "dashboard")
    save_message(conv_id, "user", payload.message, model=payload.model)

    started_at = time.perf_counter()
    ollama_resp = await _ollama_chat(payload.model, [{"role": "user", "content": payload.message}])
    latency_ms = int((time.perf_counter() - started_at) * 1000)

    assistant_text = ollama_resp.get("message", {}).get("content", "")
    prompt_tokens = int(ollama_resp.get("prompt_eval_count") or 0)
    completion_tokens = int(ollama_resp.get("eval_count") or 0)
    save_message(
        conv_id, "assistant", assistant_text,
        model=payload.model,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        latency_ms=latency_ms,
    )
    return {
        "conversation_id": conv_id,
        "model": payload.model,
        "message": assistant_text,
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
        "latency_ms": latency_ms,
    }


@router.post("/v1/chat/completions")
async def chat_completions(
    payload: ChatCompletionRequest,
    user_data: dict[str, Any] = Depends(api_key_required),
):
    """Endpoint compatible con OpenAI — chat con modelos Ollama."""
    validate_model_access(user_data, payload.model)

    conv_id = payload.conversation_id or str(uuid.uuid4())
    ensure_conversation(conv_id, user_data["id"], payload.title, payload.client_id)

    if payload.messages and payload.messages[-1].role == "user":
        save_message(conv_id, "user", payload.messages[-1].content, model=payload.model)

    nodo = deps.orquestador.best_node_for_model(payload.model)
    started_at = time.perf_counter()
    logger.info(f"[chat] model='{payload.model}' stream={payload.stream} node={nodo.get('id') if nodo else 'local'}")

    if payload.stream:
        async def _stream_with_fallback():
            try:
                if nodo:
                    async for chunk in deps.orquestador.proxy_chat_stream(
                        nodo["ollama_url"], payload.model,
                        [m.model_dump() for m in payload.messages],
                        deps.http_client_chat,
                    ):
                        yield chunk
                    return
            except Exception as exc:
                logger.warning(f"[stream] Nodo '{nodo.get('id')}' falló ({exc}), usando fallback local")
            async for chunk in _ollama_chat_stream(payload.model, [m.model_dump() for m in payload.messages]):
                yield chunk

        return StreamingResponse(_stream_with_fallback(), media_type="text/event-stream")

    # Modo sin streaming
    if nodo:
        try:
            ollama_resp = await deps.orquestador.proxy_chat(
                nodo["ollama_url"], payload.model,
                [m.model_dump() for m in payload.messages],
                deps.http_client_chat,
            )
            origen = nodo["id"]
        except Exception:
            ollama_resp = await _ollama_chat(payload.model, [m.model_dump() for m in payload.messages])
            origen = "local-fallback"
    else:
        ollama_resp = await _ollama_chat(payload.model, [m.model_dump() for m in payload.messages])
        origen = "local"

    latency_ms = int((time.perf_counter() - started_at) * 1000)
    assistant_text = ollama_resp.get("message", {}).get("content", "")
    prompt_tokens = int(ollama_resp.get("prompt_eval_count") or 0)
    completion_tokens = int(ollama_resp.get("eval_count") or 0)
    save_message(
        conv_id, "assistant", assistant_text,
        model=payload.model,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        latency_ms=latency_ms,
    )

    return JSONResponse({
        "id": f"chatcmpl-{uuid.uuid4().hex[:16]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": payload.model,
        "conversation_id": conv_id,
        "node": origen,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": assistant_text},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
        "latency_ms": latency_ms,
    })


@router.post("/v1/completions")
async def completions(
    payload: CompletionRequest,
    user_data: dict[str, Any] = Depends(api_key_required),
):
    """Endpoint compatible con OpenAI — text completions."""
    validate_model_access(user_data, payload.model)

    conv_id = payload.conversation_id or str(uuid.uuid4())
    ensure_conversation(conv_id, user_data["id"], payload.title, payload.client_id)
    save_message(conv_id, "user", payload.prompt, model=payload.model)

    nodo = deps.orquestador.best_node()
    started_at = time.perf_counter()

    if nodo:
        try:
            ollama_resp = await deps.orquestador.proxy_chat(
                nodo["ollama_url"], payload.model,
                [{"role": "user", "content": payload.prompt}],
                deps.http_client_chat,
            )
            origen = nodo["id"]
        except Exception:
            ollama_resp = await _ollama_chat(payload.model, [{"role": "user", "content": payload.prompt}])
            origen = "local-fallback"
    else:
        ollama_resp = await _ollama_chat(payload.model, [{"role": "user", "content": payload.prompt}])
        origen = "local"

    latency_ms = int((time.perf_counter() - started_at) * 1000)
    assistant_text = ollama_resp.get("message", {}).get("content", "")
    prompt_tokens = int(ollama_resp.get("prompt_eval_count") or 0)
    completion_tokens = int(ollama_resp.get("eval_count") or 0)
    save_message(
        conv_id, "assistant", assistant_text,
        model=payload.model,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        latency_ms=latency_ms,
    )

    return JSONResponse({
        "id": f"cmpl-{uuid.uuid4().hex[:16]}",
        "object": "text_completion",
        "created": int(time.time()),
        "model": payload.model,
        "conversation_id": conv_id,
        "node": origen,
        "choices": [{"index": 0, "text": assistant_text, "finish_reason": "stop"}],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
        "latency_ms": latency_ms,
    })


@router.post("/api/delegate")
async def delegate_request(
    payload: DelegateRequest,
    request: Request,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    """
    Flujo de delegación inteligente:
    1. Genera embedding de la solicitud
    2. Busca tareas similares en historial del usuario
    3. Clasifica: intent, complexity, domain, riskLevel
    4. Enruta al modelo más adecuado (determinístico)
    5. Ejecuta y guarda resultado con embedding
    """
    user_id = user_data["id"]
    started_at = time.perf_counter()

    try:
        embedding = await get_embedding(payload.user_input, OLLAMA_BASE_URL)
    except Exception:
        embedding = []

    similar_tasks = find_similar_tasks(user_id, embedding) if embedding else []
    available_models = [
        m["id"] for m in await fetch_models()
        if not str(m.get("id", "")).startswith("error:")
    ]
    classifier_model = pick_classifier_model(available_models)
    classification = await classify_request(
        payload.user_input, similar_tasks, OLLAMA_BASE_URL, classifier_model
    )
    routing = route_request(classification, available_models)

    response_text = ""
    success = False
    if routing["type"] == "DELEGUE":
        response_text = routing["message"]
        success = True
    else:
        messages = [
            {"role": "system", "content": routing["system_prompt"]},
            {"role": "user", "content": payload.user_input},
        ]
        try:
            resp = await _ollama_chat(routing["model"], messages)
            response_text = resp.get("message", {}).get("content", "")
            success = True
        except Exception as exc:
            response_text = f"Error al ejecutar el modelo: {exc}"

    execution_ms = int((time.perf_counter() - started_at) * 1000)
    save_task_embedding(
        user_id=user_id,
        user_input=payload.user_input,
        classification=classification,
        router_used=routing["type"],
        model_called=routing.get("model"),
        response_summary=response_text[:500],
        success=success,
        embedding=embedding,
    )

    return {
        "response": response_text,
        "classification": classification,
        "routing": {"type": routing["type"], "model": routing.get("model")},
        "similar_tasks": similar_tasks[:3],
        "execution_time_ms": execution_ms,
    }
