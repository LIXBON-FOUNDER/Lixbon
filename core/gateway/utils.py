"""
utils.py — Utilidades compartidas entre routers de LIXBON DTC.
"""
from __future__ import annotations
from typing import Any

import httpx

from core.gateway import deps
from core.config import OLLAMA_BASE_URL


async def fetch_models() -> list[dict[str, Any]]:
    """
    Obtiene la lista de modelos disponibles.
    Prioriza modelos de nodos online; fallback al Ollama local.
    """
    modelos_nodos = deps.orquestador.todos_los_modelos()
    if modelos_nodos:
        return modelos_nodos

    url = f"{OLLAMA_BASE_URL}/api/tags"
    try:
        client = deps.http_client_fast or httpx.AsyncClient(timeout=10.0)
        resp = await client.get(url)
        resp.raise_for_status()
        data = resp.json()
        return [
            {
                "id": m.get("name"),
                "object": "model",
                "owned_by": "ollama",
                "size": m.get("size", 0),
                "modified_at": m.get("modified_at"),
            }
            for m in data.get("models", [])
        ]
    except Exception as exc:
        return [{"id": f"error: {exc}", "object": "model", "owned_by": "system"}]
