"""
ratelimit.py — Rate limiting y bloqueo anti-brute-force.
Backend Redis (REDIS_URL) para funcionar entre múltiples workers/réplicas en Railway;
fallback en memoria de proceso cuando no hay Redis (desarrollo sin red).
Si Redis falla en runtime se degrada al fallback en memoria (fail-open controlado).
"""
from __future__ import annotations

import hashlib
import logging
import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException

from core.config import AUTH_BLOCK_MINUTES, AUTH_RATE_LIMIT, RATE_LIMIT_PER_MIN, REDIS_URL

logger = logging.getLogger("lixbon.ratelimit")

# ── Cliente Redis (perezoso) ───────────────────────────────────────────────

_redis = None
_redis_failed = False


def _get_redis():
    """Devuelve el cliente Redis o None (sin REDIS_URL o Redis caído)."""
    global _redis, _redis_failed
    if not REDIS_URL or _redis_failed:
        return None
    if _redis is None:
        try:
            import redis
            _redis = redis.Redis.from_url(REDIS_URL, decode_responses=True, socket_timeout=2)
            _redis.ping()
        except Exception as exc:
            logger.warning(f"Redis no disponible ({exc}); usando rate limiting en memoria.")
            _redis_failed = True
            return None
    return _redis


def _key_id(api_key: str) -> str:
    """Identificador corto de la key para usar en Redis sin exponer la key completa."""
    return hashlib.sha256(api_key.encode()).hexdigest()[:16]


# ── Fallback en memoria (un solo proceso) ──────────────────────────────────

_rate_lock = threading.Lock()
_rate_hits: dict[str, deque[float]] = defaultdict(deque)
_auth_lock = threading.Lock()
_auth_attempts: dict[str, list[float]] = defaultdict(list)
_auth_blocked: dict[str, float] = {}


# ── Rate limiting general (por API key) ────────────────────────────────────

def enforce_rate_limit(identifier: str, limit: int | None = None) -> None:
    """
    Lanza 429 si `identifier` (API key o "user:{id}") supera `limit` req/min.
    Sin `limit` explícito usa RATE_LIMIT_PER_MIN. F5: el límite viene del plan.
    """
    max_per_min = limit if limit and limit > 0 else RATE_LIMIT_PER_MIN
    detail = f"Rate limit excedido: máx {max_per_min} solicitudes por minuto."

    r = _get_redis()
    if r is not None:
        try:
            window = int(time.time() // 60)
            key = f"rl:{_key_id(identifier)}:{window}"
            count = r.incr(key)
            if count == 1:
                r.expire(key, 90)
            if count > max_per_min:
                raise HTTPException(status_code=429, detail=detail)
            return
        except HTTPException:
            raise
        except Exception as exc:
            logger.warning(f"Redis falló en enforce_rate_limit ({exc}); fallback a memoria.")

    now_ts = time.time()
    with _rate_lock:
        bucket = _rate_hits[identifier]
        while bucket and (now_ts - bucket[0]) > 60:
            bucket.popleft()
        if len(bucket) >= max_per_min:
            raise HTTPException(status_code=429, detail=detail)
        bucket.append(now_ts)


# ── Anti-brute-force por IP ────────────────────────────────────────────────

def check_auth_rate_limit(ip: str) -> None:
    """Lanza 429 si la IP está bloqueada por intentos de login fallidos."""
    r = _get_redis()
    if r is not None:
        try:
            ttl = r.ttl(f"authblock:{ip}")
            if ttl and ttl > 0:
                raise HTTPException(
                    status_code=429,
                    detail=f"IP bloqueada por demasiados intentos. Espera {ttl}s.",
                )
            return
        except HTTPException:
            raise
        except Exception as exc:
            logger.warning(f"Redis falló en check_auth_rate_limit ({exc}); fallback a memoria.")

    now = time.time()
    with _auth_lock:
        unblock_at = _auth_blocked.get(ip)
        if unblock_at and now < unblock_at:
            remaining = int(unblock_at - now)
            raise HTTPException(
                status_code=429,
                detail=f"IP bloqueada por demasiados intentos. Espera {remaining}s.",
            )
        cutoff = now - AUTH_BLOCK_MINUTES * 60
        _auth_attempts[ip] = [t for t in _auth_attempts[ip] if t > cutoff]


def record_failed_auth(ip: str) -> None:
    """Registra un intento fallido. Bloquea la IP si supera el umbral."""
    r = _get_redis()
    if r is not None:
        try:
            key = f"authfail:{ip}"
            count = r.incr(key)
            if count == 1:
                r.expire(key, AUTH_BLOCK_MINUTES * 60)
            if count >= AUTH_RATE_LIMIT:
                r.setex(f"authblock:{ip}", AUTH_BLOCK_MINUTES * 60, "1")
                r.delete(key)
            return
        except Exception as exc:
            logger.warning(f"Redis falló en record_failed_auth ({exc}); fallback a memoria.")

    now = time.time()
    with _auth_lock:
        _auth_attempts[ip].append(now)
        if len(_auth_attempts[ip]) >= AUTH_RATE_LIMIT:
            _auth_blocked[ip] = now + AUTH_BLOCK_MINUTES * 60
            _auth_attempts[ip] = []


def clear_auth_attempts(ip: str) -> None:
    """Limpia historial de intentos tras login exitoso."""
    r = _get_redis()
    if r is not None:
        try:
            r.delete(f"authfail:{ip}", f"authblock:{ip}")
            return
        except Exception as exc:
            logger.warning(f"Redis falló en clear_auth_attempts ({exc}); fallback a memoria.")

    with _auth_lock:
        _auth_attempts.pop(ip, None)
        _auth_blocked.pop(ip, None)
