"""
utils.py — Utilidades compartidas entre routers de lixbon DTC.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from core.config import MODELS_CACHE_TTL_S, OLLAMA_BASE_URL
from core.gateway import deps
from core.inference.ollama import show_capabilities

# Caché corta del catálogo. La resolución de roles consulta el catálogo en cada
# petición y /api/fim dispara una por pulsación de tecla: sin esto se martillea
# /api/tags. TTL de segundos, así que un `ollama pull` aparece casi al instante.
_models_cache: dict[str, Any] = {"at": 0.0, "models": []}

# Capabilities del Ollama local, cacheadas por (modelo, digest). Contra un nodo
# esto ya viene resuelto por el node_agent en /metrics; este camino es el de
# desarrollo, donde precisamente más falta hace la autodetección por capacidad.
_local_caps: dict[str, tuple[str, list[str] | None]] = {}
_LOCAL_CAPS_PER_CALL = 8


async def _local_models() -> list[dict[str, Any]]:
    url = f"{OLLAMA_BASE_URL}/api/tags"
    client = deps.http_client_fast or httpx.AsyncClient(timeout=10.0)
    resp = await client.get(url)
    resp.raise_for_status()
    crudos = resp.json().get("models", [])

    pendientes = [
        m for m in crudos
        if _local_caps.get(m.get("name", ""), ("", None))[0] != (m.get("digest") or "")
    ][:_LOCAL_CAPS_PER_CALL]
    if pendientes:
        async def _resolver(m: dict) -> None:
            caps = await show_capabilities(OLLAMA_BASE_URL, m["name"], client=client)
            _local_caps[m["name"]] = (m.get("digest") or "", caps)

        await asyncio.gather(*(_resolver(m) for m in pendientes if m.get("name")))

    salida: list[dict[str, Any]] = []
    for m in crudos:
        nombre = m.get("name")
        if not nombre:
            continue
        entrada: dict[str, Any] = {
            "id": nombre,
            "object": "model",
            "owned_by": "ollama",
            "size": m.get("size", 0),
            "modified_at": m.get("modified_at"),
        }
        caps = _local_caps.get(nombre, ("", None))[1]
        if caps:   # clave omitida = capabilities desconocidas, no "ninguna"
            entrada["capabilities"] = caps
        salida.append(entrada)
    return salida


async def fetch_models() -> list[dict[str, Any]]:
    """
    Obtiene la lista de modelos disponibles, con `capabilities` cuando se conocen.
    Prioriza modelos de nodos online; fallback al Ollama local.
    """
    now = time.monotonic()
    if _models_cache["models"] and now - _models_cache["at"] <= MODELS_CACHE_TTL_S:
        return _models_cache["models"]

    modelos = deps.orquestador.todos_los_modelos()
    if not modelos:
        try:
            modelos = await _local_models()
        except Exception as exc:
            # No se cachea el error: el siguiente intento vuelve a probar.
            return [{"id": f"error: {exc}", "object": "model", "owned_by": "system"}]

    _models_cache["models"] = modelos
    _models_cache["at"] = now
    return modelos


def invalidate_models_cache() -> None:
    _models_cache["at"] = 0.0
    _models_cache["models"] = []
