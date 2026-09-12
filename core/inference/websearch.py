"""
websearch.py — Búsqueda en internet para el chat ("modo investigar").

Con el toggle activo, el propio modelo decide QUÉ buscar (`plan_queries`: 1-3
consultas a partir de la conversación, resolviendo referencias a mensajes
anteriores), se buscan en paralelo (`research`) y los resultados se le dan
como contexto con instrucción de citar. Mandar el mensaje del usuario tal cual
al buscador ("¿es mejor vivir en X que en Y?") devolvía basura; y es más fiable
que el tool-calling nativo en modelos pequeños, funciona con cualquiera.

Para que modelos pequeños (p. ej. llama3.2) no se excusen con su "fecha de corte",
el contexto:
  - incluye la fecha de HOY,
  - les ordena explícitamente usar los resultados y NO decir que su conocimiento
    llega hasta 2023,
  - descarga el texto real de las primeras páginas (los snippets de DuckDuckGo
    suelen no traer el dato concreto: precios, cifras, etc.).

Proveedor configurable por env `WEBSEARCH_PROVIDER`:
  - "duckduckgo" (default, sin API key)
  - "tavily"  (requiere TAVILY_API_KEY; ideal para agentes)
  - "brave"   (requiere BRAVE_API_KEY)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from collections.abc import Awaitable, Callable
from datetime import date

logger = logging.getLogger("lixbon.websearch")

PROVIDER = os.getenv("WEBSEARCH_PROVIDER", "duckduckgo").lower()
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")
BRAVE_API_KEY = os.getenv("BRAVE_API_KEY", "")
MAX_RESULTS = int(os.getenv("WEBSEARCH_MAX_RESULTS", "5"))
MAX_QUERIES = int(os.getenv("WEBSEARCH_MAX_QUERIES", "3"))
# Resultados totales tras unir las consultas (las fuentes se citan por número:
# demasiadas confunden a un modelo pequeño).
MAX_TOTAL = int(os.getenv("WEBSEARCH_MAX_TOTAL", "8"))
# Cuántas páginas top descargamos para extraer su texto real (0 = desactivado).
FETCH_PAGES = int(os.getenv("WEBSEARCH_FETCH_PAGES", "3"))
FETCH_CHARS = int(os.getenv("WEBSEARCH_FETCH_CHARS", "1200"))


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


# ── Descarga del texto real de la página ────────────────────────────────────

_TAG_RE = re.compile(r"<(script|style)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
_HTML_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"[ \t\r\f\v]+")
_NL_RE = re.compile(r"\n\s*\n+")


def _html_to_text(html: str) -> str:
    html = _TAG_RE.sub(" ", html)          # fuera <script>/<style>
    text = _HTML_RE.sub(" ", html)          # fuera etiquetas
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&[a-zA-Z#0-9]+;", " ", text)
    text = _WS_RE.sub(" ", text)
    text = _NL_RE.sub("\n", text)
    return text.strip()


def _is_public_url(url: str) -> bool:
    """Anti-SSRF: solo http(s) hacia hosts que resuelven a IPs públicas.
    Las URLs vienen del buscador (no del usuario directamente), pero una consulta
    manipulada puede hacer aflorar URLs del atacante, y este fetch corre DESDE el
    gateway: sin este filtro serviría para tocar la red interna (metadata de la
    nube, localhost, etc.)."""
    import ipaddress
    import socket
    from urllib.parse import urlparse

    try:
        parts = urlparse(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            return False
        for info in socket.getaddrinfo(parts.hostname, None):
            ip = ipaddress.ip_address(info[4][0])
            if not ip.is_global:
                return False
        return True
    except Exception:
        return False


def _fetch_page_text(url: str) -> str:
    import httpx
    try:
        # Redirecciones a mano (máx. 3): follow_redirects=True validaría solo
        # la URL inicial y un redirect podría saltar a una IP interna.
        for _ in range(3):
            if not _is_public_url(url):
                return ""
            resp = httpx.get(
                url,
                timeout=8,
                follow_redirects=False,
                headers={"User-Agent": "Mozilla/5.0 (compatible; lixbonBot/1.0)"},
            )
            if resp.status_code in (301, 302, 303, 307, 308):
                location = resp.headers.get("location")
                if not location:
                    return ""
                url = str(httpx.URL(url).join(location))
                continue
            ctype = resp.headers.get("content-type", "")
            if "html" not in ctype and "text" not in ctype:
                return ""
            return _html_to_text(resp.text)[:FETCH_CHARS]
        return ""  # demasiadas redirecciones
    except Exception as exc:
        logger.debug(f"No se pudo descargar {url}: {exc}")
        return ""


def _enrich_sync(results: list[dict], n: int) -> None:
    for r in results[:n]:
        page = _fetch_page_text(r.get("url", ""))
        if page and len(page) > len(r.get("snippet", "")):
            r["snippet"] = page


async def _search_one(query: str, limit: int) -> list[dict]:
    try:
        return await asyncio.to_thread(_search_sync, query, limit)
    except Exception as exc:
        logger.warning(f"Búsqueda web falló ({PROVIDER}) para '{query}': {exc}")
        return []


async def search(query: str, limit: int | None = None) -> list[dict]:
    """Busca una consulta (en threadpool, sin bloquear el event loop)."""
    query = (query or "").strip()
    if not query:
        return []
    results = await _search_one(query, limit or MAX_RESULTS)
    # Enriquecemos las primeras fuentes con el texto real de la página.
    if results and FETCH_PAGES > 0:
        try:
            await asyncio.to_thread(_enrich_sync, results, FETCH_PAGES)
        except Exception as exc:
            logger.debug(f"Enriquecimiento de páginas falló: {exc}")
    return results


async def research(queries: list[str]) -> list[dict]:
    """Busca varias consultas en paralelo y une los resultados sin URLs repetidas,
    intercalados para que cada consulta aporte sus mejores fuentes."""
    queries = [q.strip() for q in queries if q and q.strip()][:MAX_QUERIES]
    if not queries:
        return []
    por_consulta = await asyncio.gather(*(_search_one(q, MAX_RESULTS) for q in queries))
    vistos: set[str] = set()
    unidos: list[dict] = []
    for i in range(MAX_RESULTS):
        for lista in por_consulta:
            if i < len(lista):
                r = lista[i]
                url = (r.get("url") or "").strip()
                if url and url not in vistos:
                    vistos.add(url)
                    unidos.append(r)
    unidos = unidos[:MAX_TOTAL]
    if unidos and FETCH_PAGES > 0:
        try:
            await asyncio.to_thread(_enrich_sync, unidos, FETCH_PAGES)
        except Exception as exc:
            logger.debug(f"Enriquecimiento de páginas falló: {exc}")
    return unidos


# ── El modelo decide qué buscar ──────────────────────────────────────────────

_PLAN_HISTORY = 6          # mensajes previos que ve el planificador
_PLAN_CHARS = 1500         # recorte por mensaje (adjuntos largos no aportan a la consulta)
_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)


def _plan_prompt() -> str:
    today = date.today().strftime("%d/%m/%Y")
    return (
        f"Hoy es {today}. Eres el planificador de búsquedas de un asistente. Tu único trabajo es "
        "decidir qué consultas hay que hacer en un buscador web para responder BIEN al último "
        "mensaje del usuario, teniendo en cuenta la conversación.\n"
        "Reglas:\n"
        f"- Entre 1 y {MAX_QUERIES} consultas, cada una corta y concreta (palabras clave, no preguntas "
        "completas ni saludos).\n"
        "- Resuelve las referencias a mensajes anteriores: si el usuario dice \"¿y en Perú?\" tras "
        "hablar del costo de vida en Ecuador, la consulta es \"costo de vida Perú 2026\".\n"
        "- Si el tema depende del momento (precios, noticias, versiones, cifras), incluye el año actual.\n"
        "- Usa el idioma del usuario; añade una variante en inglés solo si las mejores fuentes "
        "probablemente están en inglés.\n"
        "- Si son varias cosas distintas, una consulta por cada una.\n"
        "Responde SOLO con JSON con esta forma: {\"queries\": [\"consulta 1\", \"consulta 2\"]}"
    )


def parse_plan(raw: str, fallback: str) -> list[str]:
    """Extrae las consultas del JSON del modelo; si no hay nada usable, la pregunta tal cual."""
    consultas: list[str] = []
    m = _JSON_RE.search(raw or "")
    if m:
        try:
            datos = json.loads(m.group(0))
            crudas = datos.get("queries") if isinstance(datos, dict) else None
            if isinstance(crudas, list):
                consultas = [str(q).strip() for q in crudas if str(q).strip()]
        except ValueError:
            pass
    vistas: set[str] = set()
    limpias = []
    for q in consultas:
        clave = q.lower()
        if clave not in vistas and len(q) <= 200:
            vistas.add(clave)
            limpias.append(q)
    return limpias[:MAX_QUERIES] or [fallback.strip()[:200]]


async def plan_queries(
    messages: list[dict],
    ask: Callable[[list[dict]], Awaitable[str]],
) -> list[str]:
    """Pide al modelo las consultas. `ask` ejecuta un chat sin streaming y
    devuelve el texto; cualquier fallo cae a buscar el mensaje del usuario."""
    pregunta = str(messages[-1].get("content") or "")
    historial = [
        {"role": m["role"], "content": str(m.get("content") or "")[:_PLAN_CHARS]}
        for m in messages[-_PLAN_HISTORY:]
        if m.get("role") in ("user", "assistant") and m.get("content")
    ]
    try:
        raw = await ask([{"role": "system", "content": _plan_prompt()}, *historial])
    except Exception as exc:
        logger.warning(f"El planificador de búsquedas falló ({exc}); se busca el mensaje tal cual")
        return [pregunta.strip()[:200]]
    consultas = parse_plan(raw, pregunta)
    logger.info(f"[websearch] consultas: {consultas}")
    return consultas


def build_context(query: str, results: list[dict], queries: list[str] | None = None) -> str:
    """Arma el bloque de contexto con las fuentes para el modelo."""
    today = date.today().strftime("%d/%m/%Y")
    buscado = "; ".join(queries) if queries else query
    if not results:
        return (
            f"[BÚSQUEDA EN INTERNET] Hoy es {today}. El usuario pidió buscar en internet, "
            f'pero no se obtuvieron resultados para "{buscado}". Dilo con claridad y responde '
            "con lo que sepas, aclarando que no pudiste verificar en la web ahora mismo."
        )
    lines = [
        f"[BÚSQUEDA EN INTERNET] Hoy es {today}. Se buscó en internet: {buscado}. Estos son "
        "resultados ACTUALES obtenidos en tiempo real para responder la pregunta del usuario. "
        "INSTRUCCIONES OBLIGATORIAS:",
        "- Tienes acceso a información actual a través de estos resultados. Úsalos como tu "
        "fuente de verdad.",
        "- NO digas que tu conocimiento llega hasta 2023 ni que no puedes dar información "
        "actualizada: SÍ puedes, está aquí abajo.",
        "- Si el dato exacto (una cifra, un precio, una fecha) aparece en los resultados, "
        "cítalo tal cual. Si no aparece, dilo con honestidad.",
        "- Cita las fuentes relevantes con su número [n].",
        "",
        "=== RESULTADOS ===",
    ]
    for i, r in enumerate(results, 1):
        snippet = (r.get("snippet") or "").strip()[:900]
        lines.append(f"[{i}] {r.get('title')}\nURL: {r.get('url')}\n{snippet}")
    return "\n\n".join(lines)
