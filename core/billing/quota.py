"""
quota.py — Enforcement de límites por plan (F5).

Los límites viven en la tabla `plans` (no en el código). Postgres (usage_quotas)
es la fuente de verdad de los contadores — el upsert atómico con RETURNING evita
carreras entre réplicas — y Redis actúa como pre-check barato para cortar sin
tocar la BD cuando el usuario ya está bloqueado.

Todas las respuestas de límite son 429 con detail estructurado:
  {"code", "message", "scope", "reset_at"}  — la web muestra `message`.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException

from core.persistence.queries import bump_usage_quota, get_usage_quota
from core.security.ratelimit import _get_redis, enforce_rate_limit

logger = logging.getLogger("LIXBON.quota")

UNLIMITED = -1


# ── Períodos (UTC) ─────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _today() -> str:
    return _now().strftime("%Y-%m-%d")


def _month() -> str:
    return _now().strftime("%Y-%m")


def _day_reset() -> datetime:
    n = _now()
    return (n + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)


def _month_reset() -> datetime:
    n = _now()
    year, month = (n.year + 1, 1) if n.month == 12 else (n.year, n.month + 1)
    return n.replace(year=year, month=month, day=1, hour=0, minute=0, second=0, microsecond=0)


def _human_wait(reset: datetime) -> str:
    seconds = max(0, int((reset - _now()).total_seconds()))
    if seconds < 3600:
        return f"{max(1, seconds // 60)} min"
    if seconds < 86400:
        h = seconds // 3600
        return f"{h} h {(seconds % 3600) // 60} min"
    return f"{seconds // 86400} día(s)"


def _limit_error(code: str, scope: str, message: str, reset: datetime) -> HTTPException:
    return HTTPException(status_code=429, detail={
        "code": code,
        "scope": scope,
        "message": message,
        "reset_at": reset.isoformat(),
    })


# ── Reglas ─────────────────────────────────────────────────────────────────

def model_allowed(plan: dict[str, Any], model: str | None) -> bool:
    """allowed_models NULL ⇒ todos; si no, match por prefijo del id del modelo."""
    allowed = plan.get("allowed_models")
    if not allowed or not model:
        return True
    return any(model.startswith(prefix) for prefix in allowed)


def ensure_can_chat(user_id: int, plan: dict[str, Any], model: str | None = None) -> None:
    """
    Verificación previa a la inferencia. Lanza 403 (modelo fuera del plan) o
    429 (rate limit, mensajes/día, tokens/mes). Si pasa, el mensaje YA quedó
    contado (contar antes de inferir evita pasarse del límite en paralelo).
    """
    # 1. Modelo permitido por el plan
    if not model_allowed(plan, model):
        raise HTTPException(status_code=403, detail={
            "code": "model_not_allowed",
            "scope": "model",
            "message": f"El modelo '{model}' no está incluido en el plan {plan['name']}. "
                       "Mejora tu plan para usarlo.",
        })

    # 2. Rate limit por plan (req/min)
    enforce_rate_limit(f"user:{user_id}", limit=plan.get("rate_limit_per_min"))

    today, month = _today(), _month()
    msg_limit = int(plan.get("messages_per_day", UNLIMITED))
    tok_limit = int(plan.get("tokens_per_month", UNLIMITED))

    r = _get_redis()

    # 3. Pre-check barato en Redis: si ya está bloqueado, ni tocamos la BD
    if r is not None and msg_limit != UNLIMITED:
        try:
            cached = r.get(f"q:m:{user_id}:{today}")
            if cached is not None and int(cached) >= msg_limit:
                raise _limit_error(
                    "messages_quota", "messages_day",
                    f"Alcanzaste los {msg_limit} mensajes diarios del plan {plan['name']}. "
                    f"Se reinicia en {_human_wait(_day_reset())}.",
                    _day_reset(),
                )
        except HTTPException:
            raise
        except Exception as exc:
            logger.warning(f"Redis falló en pre-check de cuota ({exc})")

    # 4. Tokens del mes (se verifica ANTES de contar el mensaje)
    if tok_limit != UNLIMITED:
        tokens_used = get_usage_quota(user_id, "month", month)["tokens"]
        if tokens_used >= tok_limit:
            raise _limit_error(
                "tokens_quota", "tokens_month",
                f"Alcanzaste los {tok_limit:,} tokens mensuales del plan {plan['name']}. "
                f"Se reinicia en {_human_wait(_month_reset())}.",
                _month_reset(),
            )

    # 5. Contar el mensaje del día (upsert atómico; Postgres decide)
    if msg_limit != UNLIMITED:
        totals = bump_usage_quota(user_id, "day", today, messages_inc=1)
        if r is not None:
            try:
                r.set(f"q:m:{user_id}:{today}", totals["messages"], ex=90000)  # ~25 h
            except Exception:
                pass
        if totals["messages"] > msg_limit:
            raise _limit_error(
                "messages_quota", "messages_day",
                f"Alcanzaste los {msg_limit} mensajes diarios del plan {plan['name']}. "
                f"Se reinicia en {_human_wait(_day_reset())}.",
                _day_reset(),
            )
    else:
        bump_usage_quota(user_id, "day", today, messages_inc=1)  # solo estadística


def record_tokens(user_id: int, tokens: int) -> None:
    """Registra los tokens consumidos al terminar una inferencia."""
    if tokens <= 0:
        return
    try:
        totals = bump_usage_quota(user_id, "month", _month(), tokens_inc=tokens)
        r = _get_redis()
        if r is not None:
            try:
                r.set(f"q:t:{user_id}:{_month()}", totals["tokens"], ex=35 * 86400)
            except Exception:
                pass
    except Exception as exc:
        # El registro de uso nunca debe tumbar la respuesta al usuario
        logger.error(f"No se pudo registrar el uso de tokens ({exc})")


def usage_snapshot(user_id: int, plan: dict[str, Any]) -> dict[str, Any]:
    """Uso del período actual + límites del plan, para 'Mi cuenta'."""
    day = get_usage_quota(user_id, "day", _today())
    month = get_usage_quota(user_id, "month", _month())
    return {
        "messages_today": day["messages"],
        "messages_per_day": plan["messages_per_day"],
        "tokens_month": month["tokens"],
        "tokens_per_month": plan["tokens_per_month"],
        "day_resets_at": _day_reset().isoformat(),
        "month_resets_at": _month_reset().isoformat(),
    }
