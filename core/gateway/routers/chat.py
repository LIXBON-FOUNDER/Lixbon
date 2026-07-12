"""
chat.py — Endpoints de chat y completions (compatibles con OpenAI API).
Cubre: /v1/models, /v1/chat/completions, /v1/completions, /api/chat, /api/delegate

F2: TODA la inferencia se enruta por el orquestador (ollama_target), que elige
el mejor nodo GPU y cae al Ollama local del gateway solo si no hay nodos.
El streaming persiste el mensaje del asistente y los tokens al terminar.
"""
from __future__ import annotations
import json
import logging
import time
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from core.gateway import deps
from core.config import OLLAMA_BASE_URL
from core.billing import credits
from core.billing.quota import ensure_can_chat, record_tokens
from core.persistence.queries import (
    ensure_conversation,
    find_similar_tasks,
    get_plan_for_user,
    get_user_settings,
    record_model_usage,
    save_message,
    save_task_embedding,
)
from core.delegation.embeddings import classify_request, get_embedding, pick_classifier_model, route_request
from core.inference.ollama import chat as ollama_chat, stream_chat_openai
from core.inference import websearch
from core.security.auth import (
    api_key_required,
    cookie_auth_required,
    validate_model_access,
    web_or_api_key_auth,
)
from core.gateway.utils import fetch_models

logger = logging.getLogger("lixbon.chat")
router = APIRouter()


# ── Modelos Pydantic ───────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str
    content: str = ""  # los mensajes 'assistant' con solo tool_calls van sin content
    # Imágenes en base64 (passthrough a Ollama para modelos multimodales).
    # No se persisten en el historial: solo viajan al modelo.
    images: list[str] | None = None
    # Tool-calling nativo (round-trip): el assistant devuelve tool_calls y el
    # cliente responde con role="tool". Passthrough a Ollama; no se persisten.
    tool_calls: list[dict] | None = None
    tool_call_id: str | None = None
    name: str | None = None


class ChatCompletionRequest(BaseModel):
    model: str = Field(..., description="Modelo de Ollama")
    messages: list[ChatMessage]
    conversation_id: str | None = None
    title: str | None = None
    client_id: str | None = None
    stream: bool = False
    web_search: bool = False  # "modo investigar": busca en internet e inyecta contexto
    # Definiciones de funciones para tool-calling nativo (passthrough a Ollama).
    # None ⇒ comportamiento clásico (la web nunca las envía).
    tools: list[dict] | None = None
    tool_choice: Any | None = None


def _normalize_for_ollama(messages: list[dict]) -> list[dict]:
    """Adapta los mensajes OpenAI al formato que espera Ollama en /api/chat:
    los tool_calls llevan `arguments` como string JSON en OpenAI, pero Ollama
    los quiere como objeto. Se ignoran campos que Ollama no entiende."""
    out = []
    for m in messages:
        calls = m.get("tool_calls")
        if calls:
            fixed = []
            for c in calls:
                fn = (c.get("function") or {})
                args = fn.get("arguments", {})
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except Exception:
                        args = {}
                fixed.append({"function": {"name": fn.get("name", ""), "arguments": args}})
            m = {**m, "tool_calls": fixed}
            m.pop("tool_call_id", None)
            m.pop("name", None)
        out.append(m)
    return out


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


# ── Helper: chat no-streaming con fallback local ───────────────────────────

async def _routed_chat(model: str, messages: list[dict]) -> tuple[dict[str, Any], str]:
    """
    Ejecuta un chat por el mejor nodo; si el nodo falla, fallback al Ollama local.
    Retorna (respuesta_ollama, origen).
    """
    base, headers, origen = deps.orquestador.ollama_target(model)
    try:
        resp = await ollama_chat(base, model, messages, headers=headers, client=deps.http_client_chat)
        return resp, origen
    except httpx.HTTPStatusError as exc:
        if origen == "local":
            raise HTTPException(status_code=502, detail=f"Error de Ollama: {exc.response.text}") from exc
        logger.warning(f"[chat] Nodo '{origen}' respondió error ({exc}); fallback local")
    except Exception as exc:
        if origen == "local":
            raise HTTPException(status_code=502, detail=f"No se pudo conectar con Ollama: {exc}") from exc
        logger.warning(f"[chat] Nodo '{origen}' inaccesible ({exc}); fallback local")

    try:
        resp = await ollama_chat(OLLAMA_BASE_URL, model, messages, client=deps.http_client_chat)
        return resp, "local-fallback"
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Sin nodos disponibles y sin Ollama local: {exc}") from exc


def _persist_assistant(conv_id: str, model: str, text: str,
                       prompt_tokens: int, completion_tokens: int, latency_ms: int,
                       user_id: int | None = None, save_history: bool = True,
                       bill_credits: bool = False) -> None:
    if save_history:
        save_message(
            conv_id, "assistant", text,
            model=model,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            latency_ms=latency_ms,
        )
    elif user_id is not None:
        # Privacidad: sin historial no se persiste contenido, pero el uso
        # (tokens por modelo) sí se contabiliza.
        record_model_usage(user_id, model, prompt_tokens, completion_tokens, latency_ms)
    if user_id is not None:
        if bill_credits:
            # Tráfico Bearer: se cobra del saldo prepago, no de la cuota del plan
            credits.debit_usage(user_id, model, prompt_tokens, completion_tokens)
        else:
            record_tokens(user_id, prompt_tokens + completion_tokens)  # cuota mensual (F5)


# ── Endpoints ──────────────────────────────────────────────────────────────

@router.get("/v1/models")
async def models(user_data: dict[str, Any] = Depends(web_or_api_key_auth)):
    return {"object": "list", "data": await fetch_models()}


@router.post("/api/chat")
async def api_chat(
    payload: UIChatRequest,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    """Chat desde el dashboard web. Enrutado por el orquestador (F2)."""
    plan = get_plan_for_user(user_data["id"])
    ensure_can_chat(user_data["id"], plan, payload.model)  # F5: límites del plan
    save_history = get_user_settings(user_data["id"])["save_history"]

    conv_id = payload.conversation_id or str(uuid.uuid4())
    if save_history:
        if not ensure_conversation(conv_id, user_data["id"], payload.title, "dashboard"):
            raise HTTPException(status_code=404, detail="Conversación no encontrada")
        save_message(conv_id, "user", payload.message, model=payload.model)

    started_at = time.perf_counter()
    ollama_resp, origen = await _routed_chat(payload.model, [{"role": "user", "content": payload.message}])
    latency_ms = int((time.perf_counter() - started_at) * 1000)

    assistant_text = ollama_resp.get("message", {}).get("content", "")
    prompt_tokens = int(ollama_resp.get("prompt_eval_count") or 0)
    completion_tokens = int(ollama_resp.get("eval_count") or 0)
    _persist_assistant(conv_id, payload.model, assistant_text, prompt_tokens, completion_tokens,
                       latency_ms, user_id=user_data["id"], save_history=save_history)

    return {
        "conversation_id": conv_id if save_history else None,
        "model": payload.model,
        "node": origen,
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
    user_data: dict[str, Any] = Depends(web_or_api_key_auth),
):
    """Endpoint compatible con OpenAI — chat con modelos del cluster."""
    validate_model_access(user_data, payload.model)
    plan = get_plan_for_user(user_data["id"])
    is_api = user_data.get("auth_via") == "api_key"
    if is_api:
        credits.ensure_can_use_api(user_data["id"], plan, payload.model)  # prepago por tokens
    else:
        ensure_can_chat(user_data["id"], plan, payload.model)  # F5: límites del plan
    save_history = get_user_settings(user_data["id"])["save_history"]

    conv_id = payload.conversation_id or str(uuid.uuid4())
    if save_history:
        if not ensure_conversation(conv_id, user_data["id"], payload.title, payload.client_id):
            raise HTTPException(status_code=404, detail="Conversación no encontrada")
        if payload.messages and payload.messages[-1].role == "user":
            save_message(conv_id, "user", payload.messages[-1].content, model=payload.model)

    messages = [m.model_dump(exclude_none=True) for m in payload.messages]
    if payload.tools:
        messages = _normalize_for_ollama(messages)

    # "Modo investigar": busca en internet e inyecta el contexto antes de responder.
    web_sources: list[dict] = []
    if payload.web_search and messages and messages[-1]["role"] == "user":
        web_sources = await websearch.search(messages[-1]["content"])
        context = websearch.build_context(messages[-1]["content"], web_sources)
        messages.insert(len(messages) - 1, {"role": "system", "content": context})

    base, headers, origen = deps.orquestador.ollama_target(payload.model)
    started_at = time.perf_counter()
    logger.info(f"[chat] model='{payload.model}' stream={payload.stream} target={origen} web={payload.web_search}")

    if payload.stream:
        async def _stream_and_persist():
            collector: dict[str, Any] = {}
            streamed_something = False
            # Primero, las fuentes (si hubo búsqueda) para que el UI las muestre.
            if web_sources:
                import json as _json
                yield f"data: {_json.dumps({'lixbon_sources': web_sources})}\n\n"
            try:
                try:
                    async for chunk in stream_chat_openai(base, payload.model, messages,
                                                          headers=headers, collector=collector,
                                                          tools=payload.tools):
                        streamed_something = True
                        yield chunk
                except Exception as exc:
                    # Fallback local solo si el nodo falló ANTES de emitir contenido
                    # (reintentar a mitad de stream duplicaría texto en el cliente)
                    if origen != "local" and not streamed_something:
                        logger.warning(f"[stream] Nodo '{origen}' falló ({exc}); fallback local")
                        async for chunk in stream_chat_openai(OLLAMA_BASE_URL, payload.model, messages,
                                                              collector=collector, tools=payload.tools):
                            yield chunk
                    else:
                        logger.error(f"[stream] Falló el streaming ({exc})")
                        raise
            finally:
                text = collector.get("content", "")
                if text:
                    latency_ms = int((time.perf_counter() - started_at) * 1000)
                    _persist_assistant(
                        conv_id, payload.model, text,
                        collector.get("prompt_tokens", 0),
                        collector.get("completion_tokens", 0),
                        latency_ms,
                        user_id=user_data["id"],
                        save_history=save_history,
                        bill_credits=is_api,
                    )

        return StreamingResponse(_stream_and_persist(), media_type="text/event-stream")

    # Modo sin streaming
    ollama_resp, origen = await _routed_chat(payload.model, messages)
    latency_ms = int((time.perf_counter() - started_at) * 1000)
    assistant_text = ollama_resp.get("message", {}).get("content", "")
    prompt_tokens = int(ollama_resp.get("prompt_eval_count") or 0)
    completion_tokens = int(ollama_resp.get("eval_count") or 0)
    _persist_assistant(conv_id, payload.model, assistant_text, prompt_tokens, completion_tokens,
                       latency_ms, user_id=user_data["id"], save_history=save_history,
                       bill_credits=is_api)

    return JSONResponse({
        "id": f"chatcmpl-{uuid.uuid4().hex[:16]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": payload.model,
        "conversation_id": conv_id if save_history else None,
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
    """Endpoint compatible con OpenAI — text completions. Solo API key (Bearer):
    se cobra del saldo prepago de créditos."""
    validate_model_access(user_data, payload.model)
    plan = get_plan_for_user(user_data["id"])
    credits.ensure_can_use_api(user_data["id"], plan, payload.model)
    save_history = get_user_settings(user_data["id"])["save_history"]

    conv_id = payload.conversation_id or str(uuid.uuid4())
    if save_history:
        if not ensure_conversation(conv_id, user_data["id"], payload.title, payload.client_id):
            raise HTTPException(status_code=404, detail="Conversación no encontrada")
        save_message(conv_id, "user", payload.prompt, model=payload.model)

    started_at = time.perf_counter()
    ollama_resp, origen = await _routed_chat(
        payload.model, [{"role": "user", "content": payload.prompt}]
    )
    latency_ms = int((time.perf_counter() - started_at) * 1000)
    assistant_text = ollama_resp.get("message", {}).get("content", "")
    prompt_tokens = int(ollama_resp.get("prompt_eval_count") or 0)
    completion_tokens = int(ollama_resp.get("eval_count") or 0)
    _persist_assistant(conv_id, payload.model, assistant_text, prompt_tokens, completion_tokens,
                       latency_ms, user_id=user_data["id"], save_history=save_history,
                       bill_credits=True)

    return JSONResponse({
        "id": f"cmpl-{uuid.uuid4().hex[:16]}",
        "object": "text_completion",
        "created": int(time.time()),
        "model": payload.model,
        "conversation_id": conv_id if save_history else None,
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
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    """
    Delegación inteligente. Todo el pipeline (embedding, clasificación y ejecución)
    se enruta por el orquestador hacia el mejor nodo GPU (F2).
    """
    user_id = user_data["id"]
    plan = get_plan_for_user(user_id)
    ensure_can_chat(user_id, plan)  # F5: cuenta el mensaje; el modelo se decide después

    started_at = time.perf_counter()

    # Destino para las tareas auxiliares (embedding + clasificación): el mejor nodo disponible
    aux_base, aux_headers, _ = deps.orquestador.ollama_target()

    try:
        embedding = await get_embedding(payload.user_input, aux_base, headers=aux_headers)
    except Exception:
        embedding = []

    similar_tasks = find_similar_tasks(user_id, embedding) if embedding else []
    available_models = [
        m["id"] for m in await fetch_models()
        if not str(m.get("id", "")).startswith("error:")
    ]
    classifier_model = pick_classifier_model(available_models)
    try:
        classification = await classify_request(
            payload.user_input, similar_tasks, aux_base, classifier_model, headers=aux_headers
        )
    except Exception:
        classification = {
            "intent": "learn", "complexity": 0.5, "domain": "backend",
            "riskLevel": "low", "requiresApproval": False,
        }
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
            resp, _ = await _routed_chat(routing["model"], messages)
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
