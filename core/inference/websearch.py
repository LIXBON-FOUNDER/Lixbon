"""
websearch.py — Búsqueda en internet para el chat ("modo investigar").

Cuando el usuario activa el toggle de búsqueda, ejecutamos la consulta y le damos
al modelo los resultados como contexto (con instrucción de citar). Es más fiable
que el tool-calling nativo en modelos pequeños y funciona con cualquiera.

Proveedor configurable por env `WEBSEARCH_PROVIDER`:
  - "duckduckgo" (default, sin API key)
  - "tavily"  (requiere TAVILY_API_KEY; ideal para agentes)
  - "brave"   (requiere BRAVE_API_KEY)
"""
from __future__ import annotations

import asyncio
import logging
import os

logger = logging.getLogger("folax.websearch")

PROVIDER = os.getenv("WEBSEARCH_PROVIDER", "duckduckgo").lower()
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")
BRAVE_API_KEY = os.getenv("BRAVE_API_KEY", "")
MAX_RESULTS = int(os.getenv("WEBSEARCH_MAX_RESULTS", "5"))


def _search_duckduckgo(query: str, limit: int) -> list[dict]:
    try:
        from ddgs import DDGS
    except Exception:
        try:
            from duckduckgo_search import DDGS  # nombre antiguo del paquete
        except Exception as exc:
            logger.error(f"ddgs no instalado: {exc}")
            return []
    out = []
    with DDGS() as ddgs:
        for r in ddgs.text(query, max_results=limit):
            out.append({
                "title": r.get("title") or "",
                "url": r.get("href") or r.get("url") or "",
                "snippet": r.get("body") or r.get("snippet") or "",
            })
    return out


def _search_tavily(query: str, limit: int) -> list[dict]:
    import httpx
    resp = httpx.post(
        "https://api.tavily.com/search",
        json={"api_key": TAVILY_API_KEY, "query": query, "max_results": limit},
        timeout=15,
    )
    resp.raise_for_status()
    return [
        {"title": r.get("title", ""), "url": r.get("url", ""), "snippet": r.get("content", "")}
        for r in resp.json().get("results", [])
    ]


def _search_brave(query: str, limit: int) -> list[dict]:
    import httpx
    resp = httpx.get(
        "https://api.search.brave.com/res/v1/web/search",
        params={"q": query, "count": limit},
        headers={"X-Subscription-Token": BRAVE_API_KEY, "Accept": "application/json"},
        timeout=15,
    )
    resp.raise_for_status()
    web = resp.json().get("web", {}).get("results", [])
    return [
        {"title": r.get("title", ""), "url": r.get("url", ""), "snippet": r.get("description", "")}
        for r in web[:limit]
    ]


def _search_sync(query: str, limit: int) -> list[dict]:
    if PROVIDER == "tavily" and TAVILY_API_KEY:
        return _search_tavily(query, limit)
    if PROVIDER == "brave" and BRAVE_API_KEY:
        return _search_brave(query, limit)
    return _search_duckduckgo(query, limit)


async def search(query: str, limit: int | None = None) -> list[dict]:
    """Busca en internet (en threadpool, sin bloquear el event loop)."""
    query = (query or "").strip()
    if not query:
        return []
    limit = limit or MAX_RESULTS
    try:
        return await asyncio.to_thread(_search_sync, query, limit)
    except Exception as exc:
        logger.warning(f"Búsqueda web falló ({PROVIDER}): {exc}")
        return []


def build_context(query: str, results: list[dict]) -> str:
    """Arma el bloque de contexto con las fuentes para el modelo."""
    if not results:
        return (
            "Búsqueda en internet activada, pero no se obtuvieron resultados para "
            f'"{query}". Responde con lo que sepas y aclara que no pudiste verificar en la web.'
        )
    lines = [
        "Resultados de búsqueda en internet (úsalos para responder y CITA las fuentes "
        "relevantes con su número [n] y su URL al final):",
    ]
    for i, r in enumerate(results, 1):
        snippet = (r.get("snippet") or "")[:500]
        lines.append(f"[{i}] {r.get('title')}\n{r.get('url')}\n{snippet}")
    return "\n\n".join(lines)
