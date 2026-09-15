"""Estado público de los servicios (/status), al estilo de una status page.

GET /api/status no pide sesión: devuelve el estado actual de cada componente,
la disponibilidad de los últimos 90 días y los incidentes detectados. Todo
sale de muestras que el propio gateway toma cada SAMPLE_INTERVAL_S segundos y
guarda en status_samples; una caída del gateway se ve como un hueco entre
muestras, que aquí cuenta como incidente de la API.
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from fastapi import APIRouter

from core.config import APP_VERSION, OLLAMA_BASE_URL, stripe_configured
from core.gateway import deps
from core.gateway.email import BREVO_API_KEY, problema_de_configuracion
from core.persistence import queries as db

logger = logging.getLogger("lixbon.status")
router = APIRouter(tags=["status"])

SAMPLE_INTERVAL_S = 300
CACHE_S = 30
# Comprobaciones contra terceros (Stripe, Brevo): una llamada por muestra, no
# por visita a la página.
EXTERNAL_CACHE_S = 300
DB_SLOW_MS = 1500

OPERATIONAL, DEGRADED, DOWN, UNAVAILABLE = "operational", "degraded", "down", "unavailable"
# UNAVAILABLE = el servicio no está desplegado/configurado (no hay nodo de
# imágenes, Stripe sin clave): se muestra en gris y no cuenta como caída.
_PESO = {OPERATIONAL: 0, UNAVAILABLE: 0, DEGRADED: 1, DOWN: 2}

COMPONENTES = [
    {"id": "api", "name": "API y web", "description": "lixbon.com, la API compatible con OpenAI y el CLI."},
    {"id": "database", "name": "Base de datos", "description": "Cuentas, conversaciones y cuotas."},
    {"id": "inference", "name": "Modelos de lenguaje", "description": "Chat, Visuals y agente: los nodos con GPU del clúster."},
    {"id": "images", "name": "Generación de imágenes", "description": "Nodos con un modelo de difusión."},
    {"id": "payments", "name": "Pagos", "description": "Suscripciones y créditos con Stripe."},
    {"id": "email", "name": "Correo transaccional", "description": "Verificación de cuenta, avisos y recibos."},
]


# ── Comprobaciones ────────────────────────────────────────────────────────

def _check_database() -> dict[str, Any]:
    inicio = time.perf_counter()
    try:
        db.get_user_by_id(1)
    except Exception as exc:
        return {"status": DOWN, "detail": f"Sin conexión: {type(exc).__name__}"}
    ms = int((time.perf_counter() - inicio) * 1000)
    if ms > DB_SLOW_MS:
        return {"status": DEGRADED, "detail": f"Responde lento ({ms} ms)", "latency_ms": ms}
    return {"status": OPERATIONAL, "detail": f"{ms} ms", "latency_ms": ms}


async def _ollama_local_online() -> bool:
    try:
        async with httpx.AsyncClient(timeout=3.0) as cliente:
            r = await cliente.get(f"{OLLAMA_BASE_URL}/api/tags")
            return r.status_code == 200
    except Exception:
        return False


async def _check_inference(nodos: list[dict]) -> dict[str, Any]:
    if not nodos:
        if await _ollama_local_online():
            return {"status": OPERATIONAL, "detail": "Ollama local"}
        return {"status": DOWN, "detail": "Ningún nodo registrado"}
    online = [n for n in nodos if n["online"]]
    modelos = sorted({m for n in online for m in n.get("modelos") or []})
    if not online:
        return {"status": DOWN, "detail": f"0 de {len(nodos)} nodos en línea"}
    resumen = f"{len(online)} de {len(nodos)} nodos, {len(modelos)} modelos"
    if len(online) < len(nodos):
        return {"status": DEGRADED, "detail": resumen}
    return {"status": OPERATIONAL, "detail": resumen}


def _check_images(nodos: list[dict]) -> dict[str, Any]:
    con_modelo = [n for n in nodos if (n.get("metricas") or {}).get("image_model")]
    if not con_modelo:
        return {"status": UNAVAILABLE, "detail": "Sin nodo de imágenes"}
    online = [n for n in con_modelo if n["online"]]
    if not online:
        return {"status": DOWN, "detail": "El nodo de imágenes no responde"}
    con_error = [n for n in online if (n.get("metricas") or {}).get("image_error")]
    if len(con_error) == len(online):
        return {"status": DEGRADED, "detail": "El modelo de imágenes da error"}
    return {"status": OPERATIONAL, "detail": online[0]["metricas"]["image_model"]}


_externos: dict[str, tuple[float, dict[str, Any]]] = {}


async def _cacheado(clave: str, fn) -> dict[str, Any]:
    ahora = time.time()
    hit = _externos.get(clave)
    if hit and ahora - hit[0] < EXTERNAL_CACHE_S:
        return hit[1]
    resultado = await fn()
    _externos[clave] = (ahora, resultado)
    return resultado


async def _check_payments() -> dict[str, Any]:
    if not stripe_configured():
        return {"status": UNAVAILABLE, "detail": "Sin pasarela configurada"}

    def _ping():
        from core.billing.stripe_gateway import _client
        _client().Balance.retrieve()

    try:
        await asyncio.wait_for(asyncio.to_thread(_ping), timeout=8.0)
    except Exception as exc:
        return {"status": DOWN, "detail": f"Stripe no responde: {type(exc).__name__}"}
    return {"status": OPERATIONAL, "detail": "Stripe"}


async def _check_email() -> dict[str, Any]:
    if problema_de_configuracion():
        return {"status": UNAVAILABLE, "detail": "Sin proveedor configurado"}
    try:
        async with httpx.AsyncClient(timeout=8.0) as cliente:
            r = await cliente.get("https://api.brevo.com/v3/account", headers={"api-key": BREVO_API_KEY})
    except Exception as exc:
        return {"status": DOWN, "detail": f"Brevo no responde: {type(exc).__name__}"}
    if r.status_code == 401:
        return {"status": DOWN, "detail": "Clave de Brevo rechazada"}
    if r.status_code >= 500:
        return {"status": DEGRADED, "detail": f"Brevo responde {r.status_code}"}
    return {"status": OPERATIONAL, "detail": "Brevo"}


async def snapshot() -> dict[str, dict[str, Any]]:
    nodos: list[dict] = []
    try:
        nodos = deps.orquestador.estado_nodos()
    except Exception:
        pass
    database, inference, payments, email = await asyncio.gather(
        asyncio.to_thread(_check_database),
        _check_inference(nodos),
        _cacheado("payments", _check_payments),
        _cacheado("email", _check_email),
    )
    return {
        "api": {"status": OPERATIONAL, "detail": f"v{APP_VERSION}"},
        "database": database,
        "inference": inference,
        "images": _check_images(nodos),
        "payments": payments,
        "email": email,
    }


# ── Historial ─────────────────────────────────────────────────────────────

def _peor(estados) -> str:
    return max(estados, key=lambda e: _PESO.get(e, 0), default=OPERATIONAL)


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts)


def historial(muestras: list[tuple[str, dict[str, str]]], ahora: datetime | None = None,
              days: int = db.STATUS_HISTORY_DAYS) -> dict[str, Any]:
    """Disponibilidad por día y por componente, más los incidentes: rachas de
    muestras seguidas fuera de OPERATIONAL. Un hueco largo entre muestras es
    el gateway caído, y va como incidente de la API."""
    ahora = ahora or datetime.now(timezone.utc)
    hueco_max = timedelta(seconds=SAMPLE_INTERVAL_S * 3)
    ids = [c["id"] for c in COMPONENTES]
    por_dia: dict[str, dict[str, dict[str, int]]] = {cid: {} for cid in ids}
    abiertos: dict[str, dict[str, Any]] = {}
    incidentes: list[dict[str, Any]] = []

    def cerrar(cid: str, fin: str | None):
        inc = abiertos.pop(cid, None)
        if inc:
            inc["ended_at"] = fin
            incidentes.append(inc)

    def hueco(desde: datetime, hasta: datetime, fin: str | None):
        if hasta - desde <= hueco_max:
            return
        incidentes.append({"component": "api", "status": DOWN,
                           "started_at": desde.isoformat(), "ended_at": fin})
        # Las muestras que faltan cuentan como API caída ese día.
        acum = por_dia["api"].setdefault(desde.date().isoformat(), {})
        acum[DOWN] = acum.get(DOWN, 0) + int((hasta - desde).total_seconds() // SAMPLE_INTERVAL_S) - 1

    anterior: datetime | None = None
    for ts, estados in muestras:
        momento = _parse(ts)
        if anterior:
            hueco(anterior, momento, ts)
        anterior = momento
        dia = momento.date().isoformat()
        for cid in ids:
            estado = estados.get(cid, UNAVAILABLE)
            acum = por_dia[cid].setdefault(dia, {})
            acum[estado] = acum.get(estado, 0) + 1
            abierto = abiertos.get(cid)
            if _PESO.get(estado, 0) == 0:
                cerrar(cid, ts)
            elif abierto is None:
                abiertos[cid] = {"component": cid, "status": estado, "started_at": ts, "ended_at": None}
            elif _PESO[estado] > _PESO[abierto["status"]]:
                abierto["status"] = estado

    if anterior:
        # Si estamos respondiendo, la API ya volvió: el hueco termina ahora.
        hueco(anterior, ahora, ahora.isoformat())
    incidentes.extend(abiertos.values())

    dias = [(ahora.date() - timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]
    componentes: dict[str, Any] = {}
    for cid in ids:
        serie = []
        ok_total = medidas_total = 0
        for dia in dias:
            acum = por_dia[cid].get(dia)
            if not acum:
                serie.append({"date": dia, "status": None, "uptime": None})
                continue
            medidas = sum(acum.values())
            ok = acum.get(OPERATIONAL, 0) + acum.get(UNAVAILABLE, 0)
            estado = _peor(acum)
            uptime = round(100 * ok / medidas, 2) if medidas else None
            serie.append({"date": dia, "status": estado, "uptime": uptime})
            ok_total += ok
            medidas_total += medidas
        componentes[cid] = {
            "days": serie,
            "uptime": round(100 * ok_total / medidas_total, 2) if medidas_total else None,
        }

    nombres = {c["id"]: c["name"] for c in COMPONENTES}
    for inc in incidentes:
        inc["name"] = nombres.get(inc["component"], inc["component"])
        fin = _parse(inc["ended_at"]) if inc["ended_at"] else ahora
        inc["duration_min"] = max(1, round((fin - _parse(inc["started_at"])).total_seconds() / 60))
    incidentes.sort(key=lambda i: i["started_at"], reverse=True)
    return {"components": componentes, "incidents": incidentes}


# ── Endpoint ──────────────────────────────────────────────────────────────

_cache: tuple[float, dict[str, Any]] | None = None
_cache_lock = asyncio.Lock()


async def estado_actual() -> dict[str, Any]:
    global _cache
    async with _cache_lock:
        if _cache and time.time() - _cache[0] < CACHE_S:
            return _cache[1]
        actual, muestras = await asyncio.gather(snapshot(), asyncio.to_thread(_safe_samples))
        hist = historial(muestras)
        ahora = datetime.now(timezone.utc).isoformat()
        componentes = []
        for c in COMPONENTES:
            estado = actual[c["id"]]
            componentes.append({**c, **estado, **hist["components"][c["id"]]})
        # Un incidente sigue abierto en las muestras hasta la siguiente toma;
        # si el componente ya responde, se da por cerrado ahora.
        for inc in hist["incidents"]:
            if inc["ended_at"] is None and _PESO.get(actual[inc["component"]]["status"], 0) == 0:
                inc["ended_at"] = ahora
        respuesta = {
            "status": _peor(c["status"] for c in componentes),
            "updated_at": ahora,
            "sample_interval_s": SAMPLE_INTERVAL_S,
            "history_days": db.STATUS_HISTORY_DAYS,
            "components": componentes,
            "incidents": hist["incidents"][:30],
        }
        _cache = (time.time(), respuesta)
        return respuesta


def _safe_samples() -> list[tuple[str, dict[str, str]]]:
    try:
        return db.get_status_samples()
    except Exception as exc:
        logger.warning(f"[status] no se pudo leer el historial: {exc}")
        return []


@router.get("/api/status")
async def api_status():
    return await estado_actual()


# ── Muestreo periódico ────────────────────────────────────────────────────

def _tomar_muestra() -> None:
    estados = asyncio.run(snapshot())
    db.add_status_sample({cid: e["status"] for cid, e in estados.items()})


def start_sampler() -> None:
    def _run():
        # La primera muestra espera a que el orquestador haya sondeado los
        # nodos; si no, cada arranque apuntaría "modelos caídos" un momento.
        time.sleep(60)
        ultimo_purgado = 0.0
        while True:
            try:
                _tomar_muestra()
                if time.time() - ultimo_purgado > 86400:
                    db.purge_status_samples()
                    ultimo_purgado = time.time()
            except Exception as exc:
                logger.warning(f"[status] muestra fallida: {exc}")
            time.sleep(SAMPLE_INTERVAL_S)

    threading.Thread(target=_run, daemon=True, name="status-sampler").start()
