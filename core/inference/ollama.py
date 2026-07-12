"""
ollama.py — Cliente único de inferencia contra Ollama (directo o vía node_agent).
Única implementación de chat y streaming SSE del proyecto.

- `base_url` puede ser el Ollama local (http://127.0.0.1:11434) o el proxy del
  node_agent (https://gpu-01.dominio/ollama); la API es la misma.
- El keep-alive del streaming es REAL: se basa en tiempo transcurrido sin chunks
  (cola async con timeout), no en la llegada de un chunk. Protege contra cortes
  de Cloudflare/Railway cuando el modelo tarda en producir el primer token.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Any, AsyncIterator

import httpx

logger = logging.getLogger("lixbon.inference")

KEEPALIVE_SECONDS = 5
STREAM_TIMEOUT = httpx.Timeout(300.0, connect=15.0)


async def chat(
    base_url: str,
    model: str,
    messages: list[dict],
    headers: dict | None = None,
    client: httpx.AsyncClient | None = None,
    num_ctx: int | None = None,
) -> dict[str, Any]:
    """Chat sin streaming. Retorna la respuesta cruda de Ollama. Lanza httpx.HTTPError si falla.
    `num_ctx`: ventana de contexto (Ollama usa 4096 por defecto aunque el modelo
    soporte más; súbela para archivos/conversaciones grandes — cuesta VRAM)."""
    url = f"{base_url.rstrip('/')}/api/chat"
    payload: dict = {"model": model, "messages": messages, "stream": False}
    if num_ctx:
        payload["options"] = {"num_ctx": int(num_ctx)}
    if client is not None:
        resp = await client.post(url, json=payload, headers=headers, timeout=STREAM_TIMEOUT)
        resp.raise_for_status()
        return resp.json()
    async with httpx.AsyncClient(timeout=STREAM_TIMEOUT) as own:
        resp = await own.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        return resp.json()


async def generate(
    base_url: str,
    model: str,
    prompt: str,
    suffix: str = "",
    options: dict | None = None,
    headers: dict | None = None,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """Completado con /api/generate. Con `suffix` activa fill-in-the-middle (FIM)
    para modelos que lo soportan (qwen2.5-coder, codellama, deepseek-coder…):
    Ollama aplica el template FIM del modelo. Retorna la respuesta cruda
    ({response, prompt_eval_count, eval_count, …}). Lanza httpx.HTTPError si falla."""
    url = f"{base_url.rstrip('/')}/api/generate"
    payload: dict = {"model": model, "prompt": prompt, "stream": False}
    if suffix:
        payload["suffix"] = suffix
    if options:
        payload["options"] = options
    if client is not None:
        resp = await client.post(url, json=payload, headers=headers, timeout=STREAM_TIMEOUT)
        resp.raise_for_status()
        return resp.json()
    async with httpx.AsyncClient(timeout=STREAM_TIMEOUT) as own:
        resp = await own.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        return resp.json()


async def embed(
    base_url: str,
    text: str,
    model: str,
    headers: dict | None = None,
) -> list[float]:
    """Genera un embedding. Retorna [] si el modelo no devuelve vectores."""
    url = f"{base_url.rstrip('/')}/api/embed"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, json={"model": model, "input": text}, headers=headers)
        resp.raise_for_status()
        embeddings = resp.json().get("embeddings", [])
        return embeddings[0] if embeddings else []


async def embed_many(
    base_url: str,
    model: str,
    texts: list[str],
    headers: dict | None = None,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """Embeddings en lote (/api/embed con input=lista). Retorna la respuesta
    cruda de Ollama ({embeddings: [[...]], prompt_eval_count, model})."""
    url = f"{base_url.rstrip('/')}/api/embed"
    payload = {"model": model, "input": texts}
    if client is not None:
        resp = await client.post(url, json=payload, headers=headers, timeout=STREAM_TIMEOUT)
        resp.raise_for_status()
        return resp.json()
    async with httpx.AsyncClient(timeout=60.0) as own:
        resp = await own.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        return resp.json()


async def list_models(base_url: str, headers: dict | None = None) -> list[dict]:
    """Lista los modelos instalados (/api/tags)."""
    url = f"{base_url.rstrip('/')}/api/tags"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url, headers=headers)
        resp.raise_for_status()
        return resp.json().get("models", [])


# ── Streaming con keep-alive real ──────────────────────────────────────────

async def _lines_with_keepalive(
    aiter: AsyncIterator[str],
    interval: float,
) -> AsyncIterator[tuple[str, Any]]:
    """
    Envuelve un iterador de líneas: emite ('line', str) al llegar datos y
    ('keepalive', None) cuando pasan `interval` segundos sin nada.
    Un task de bombeo alimenta una cola; el consumidor espera con timeout —
    así el keep-alive se emite aunque el origen esté en silencio total.
    """
    queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()

    async def _pump() -> None:
        try:
            async for line in aiter:
                await queue.put(("line", line))
        except Exception as exc:
            await queue.put(("error", exc))
        finally:
            await queue.put(("end", None))

    pump_task = asyncio.create_task(_pump())
    try:
        while True:
            try:
                kind, value = await asyncio.wait_for(queue.get(), timeout=interval)
            except asyncio.TimeoutError:
                yield ("keepalive", None)
                continue
            if kind == "end":
                return
            if kind == "error":
                raise value
            yield ("line", value)
    finally:
        pump_task.cancel()


def _ollama_tool_calls_to_openai(raw_calls: list[dict]) -> list[dict]:
    """Convierte los tool_calls de Ollama (arguments = objeto) al formato OpenAI
    (arguments = string JSON), que es lo que esperan los clientes."""
    out = []
    for i, call in enumerate(raw_calls or []):
        fn = call.get("function", {}) or {}
        args = fn.get("arguments", {})
        if not isinstance(args, str):
            args = json.dumps(args, ensure_ascii=False)
        out.append({
            "index": i,
            "id": call.get("id") or f"call_{uuid.uuid4().hex[:8]}",
            "type": "function",
            "function": {"name": fn.get("name", ""), "arguments": args},
        })
    return out


async def stream_chat_openai(
    base_url: str,
    model: str,
    messages: list[dict],
    headers: dict | None = None,
    collector: dict | None = None,
    tools: list[dict] | None = None,
    num_ctx: int | None = None,
) -> AsyncIterator[str]:
    """
    Chat en streaming, convertido a chunks SSE en formato OpenAI.
    Si se pasa `collector` (dict), al terminar contiene:
      content (texto completo), prompt_tokens, completion_tokens, tool_calls
    para que el caller persista el mensaje y el uso.
    `tools`: definiciones de funciones (passthrough a Ollama para tool-calling
    nativo); si es None el comportamiento no cambia (retrocompatible con la web).
    `num_ctx`: ventana de contexto (Ollama usa 4096 por defecto aunque el modelo
    soporte más). Súbela para no truncar en archivos/conversaciones grandes.
    """
    url = f"{base_url.rstrip('/')}/api/chat"
    payload: dict = {"model": model, "messages": messages, "stream": True}
    if tools:
        payload["tools"] = tools
    if num_ctx:
        payload["options"] = {"num_ctx": int(num_ctx)}
    chat_id = f"chatcmpl-{uuid.uuid4()}"
    parts: list[str] = []
    collected_tool_calls: list[dict] = []

    async with httpx.AsyncClient(timeout=STREAM_TIMEOUT) as client:
        async with client.stream("POST", url, json=payload, headers=headers) as response:
            response.raise_for_status()

            async for kind, line in _lines_with_keepalive(response.aiter_lines(), KEEPALIVE_SECONDS):
                if kind == "keepalive":
                    yield ": keep-alive\n\n"
                    continue
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except Exception:
                    logger.warning(f"Chunk no-JSON de Ollama ignorado: {line[:80]}")
                    continue

                msg = data.get("message", {}) or {}
                content = msg.get("content", "")
                thinking = msg.get("thinking", "")
                raw_tool_calls = msg.get("tool_calls") or []
                done = data.get("done", False)
                if content:
                    parts.append(content)

                delta: dict = {}
                if not done:
                    delta["content"] = content
                    if thinking:
                        # Razonamiento del modelo (modelos thinking de Ollama):
                        # se reenvía como reasoning_content para que el cliente
                        # lo muestre en segundo plano.
                        delta["reasoning_content"] = thinking
                    if raw_tool_calls:
                        # Tool-calling nativo: Ollama entrega los tool_calls
                        # completos en un chunk (no incrementales como OpenAI).
                        oa_calls = _ollama_tool_calls_to_openai(raw_tool_calls)
                        delta["tool_calls"] = oa_calls
                        collected_tool_calls.extend(oa_calls)

                openai_chunk = {
                    "id": chat_id,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "delta": delta,
                            "finish_reason": (
                                "tool_calls" if (done and collected_tool_calls)
                                else "stop" if done else None
                            ),
                        }
                    ],
                }
                if done:
                    prompt_tokens = int(data.get("prompt_eval_count") or 0)
                    completion_tokens = int(data.get("eval_count") or 0)
                    if collector is not None:
                        collector["prompt_tokens"] = prompt_tokens
                        collector["completion_tokens"] = completion_tokens
                    openai_chunk["usage"] = {
                        "prompt_tokens": prompt_tokens,
                        "completion_tokens": completion_tokens,
                        "total_tokens": prompt_tokens + completion_tokens,
                    }
                yield f"data: {json.dumps(openai_chunk)}\n\n"

    if collector is not None:
        collector["content"] = "".join(parts)
        if collected_tool_calls:
            collector["tool_calls"] = collected_tool_calls
    yield "data: [DONE]\n\n"
