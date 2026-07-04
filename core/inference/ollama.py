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

logger = logging.getLogger("folax.inference")

KEEPALIVE_SECONDS = 5
STREAM_TIMEOUT = httpx.Timeout(300.0, connect=15.0)


async def chat(
    base_url: str,
    model: str,
    messages: list[dict],
    headers: dict | None = None,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """Chat sin streaming. Retorna la respuesta cruda de Ollama. Lanza httpx.HTTPError si falla."""
    url = f"{base_url.rstrip('/')}/api/chat"
    payload = {"model": model, "messages": messages, "stream": False}
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


async def stream_chat_openai(
    base_url: str,
    model: str,
    messages: list[dict],
    headers: dict | None = None,
    collector: dict | None = None,
) -> AsyncIterator[str]:
    """
    Chat en streaming, convertido a chunks SSE en formato OpenAI.
    Si se pasa `collector` (dict), al terminar contiene:
      content (texto completo), prompt_tokens, completion_tokens
    para que el caller persista el mensaje y el uso.
    """
    url = f"{base_url.rstrip('/')}/api/chat"
    payload = {"model": model, "messages": messages, "stream": True}
    chat_id = f"chatcmpl-{uuid.uuid4()}"
    parts: list[str] = []

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

                content = data.get("message", {}).get("content", "")
                done = data.get("done", False)
                if content:
                    parts.append(content)
                if done and collector is not None:
                    collector["prompt_tokens"] = int(data.get("prompt_eval_count") or 0)
                    collector["completion_tokens"] = int(data.get("eval_count") or 0)

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
                yield f"data: {json.dumps(openai_chunk)}\n\n"

    if collector is not None:
        collector["content"] = "".join(parts)
    yield "data: [DONE]\n\n"
