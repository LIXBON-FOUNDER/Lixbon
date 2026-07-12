"""
credits.py — Créditos prepago para el tráfico con API key (Bearer).

El chat con sesión (web/IDE) sigue bajo la cuota del plan (quota.py). Las
peticiones autenticadas con `lixbon_sk_` se cobran por tokens reales × tarifa
del modelo (tabla model_pricing, micro-USD por millón de tokens):

  - Pre-check antes de inferir: saldo > 0, si no → 402 insufficient_credits.
  - Débito al terminar (post-pago por petición): el costo se conoce al final
    del stream; el descubierto máximo queda acotado a céntimos y un saldo
    negativo bloquea la siguiente petición.

El tráfico Bearer NO consume las cuotas del plan (mensajes/día, tokens/mes,
allowed_models): los créditos pagan cualquier modelo. Solo se conserva el
rate limit por minuto del plan. Las estadísticas quedan en token_usage_daily
(vía save_message/record_model_usage) y el detalle facturable en credit_ledger.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any

from fastapi import HTTPException

from core.persistence.queries import (
    debit_credit_usage,
    get_credit_balance,
    get_usage_quota,
    list_model_pricing,
)
from core.security.ratelimit import enforce_rate_limit

logger = logging.getLogger("lixbon.credits")

MICRO_PER_USD = 1_000_000
MTOK = 1_000_000  # las tarifas son por millón de tokens

# Saldo mínimo exigido por el pre-check (µ$). 0 = basta con tener saldo positivo.
CREDITS_MIN_START_MICROUSD = int(os.getenv("CREDITS_MIN_START_MICROUSD", "0"))

_PRICING_TTL_S = 60
_pricing_cache: dict[str, Any] = {"at": 0.0, "rows": []}


def microusd_to_usd(v: int) -> float:
    return round(v / MICRO_PER_USD, 6)


def _pricing_rows() -> list[dict[str, Any]]:
    now = time.monotonic()
    if now - _pricing_cache["at"] > _PRICING_TTL_S or not _pricing_cache["rows"]:
        try:
            _pricing_cache["rows"] = list_model_pricing(active_only=True)
            _pricing_cache["at"] = now
        except Exception as exc:
            logger.error(f"No se pudieron cargar las tarifas ({exc})")
    return _pricing_cache["rows"]


def invalidate_pricing_cache() -> None:
    """El panel admin la llama al editar tarifas para que apliquen al instante."""
    _pricing_cache["at"] = 0.0
    _pricing_cache["rows"] = []


def resolve_pricing(model: str | None) -> dict[str, Any]:
    """Tarifa aplicable al modelo: longest-prefix-match con fallback a '*'.
    Sin tarifa aplicable → 503 (nunca inferir gratis por accidente)."""
    default = None
    best = None
    for row in _pricing_rows():
        prefix = row["model_prefix"]
        if prefix == "*":
            default = row
            continue
        if model and model.startswith(prefix):
            if best is None or len(prefix) > len(best["model_prefix"]):
                best = row
    chosen = best or default
    if not chosen:
        raise HTTPException(status_code=503, detail={
            "code": "pricing_unavailable",
            "message": "El precio de la API no está disponible ahora mismo. Intenta más tarde.",
        })
    return chosen


def compute_cost_microusd(pricing: dict[str, Any], prompt_tokens: int,
                          completion_tokens: int) -> int:
    """Costo entero en µ$: tokens × tarifa / 1M, sin floats."""
    return (
        prompt_tokens * int(pricing["input_microusd_per_mtok"])
        + completion_tokens * int(pricing["output_microusd_per_mtok"])
    ) // MTOK


def _current_month() -> str:
    import datetime as _dt
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m")


def ensure_can_use_api(user_id: int, plan: dict[str, Any], model: str | None = None) -> str:
    """Pre-check de una petición con API key. Devuelve el MODO de cobro:

      - 'plan'    : la suscripción de pago (Pro/Advance) cubre el uso con su
                    cuota mensual de tokens — sin cobrar créditos (no redundar
                    con lo que el usuario ya paga por su plan).
      - 'credits' : se cobra del saldo prepago. Aplica a usuarios sin plan de
                    pago (Gratuito) y a Pro/Advance que ya AGOTARON su cuota
                    mensual (recargar créditos para seguir usando la API).

    Lanza 503 (sin tarifa), 429 (rate limit), 403 (modelo) o 402 (sin saldo)."""
    resolve_pricing(model)  # 503 si no hay tarifas (necesarias para el cobro por créditos)
    enforce_rate_limit(f"user:{user_id}", limit=plan.get("rate_limit_per_min"))

    is_paid = plan.get("id") != "free" and int(plan.get("price_monthly_cents") or 0) > 0
    if is_paid:
        from core.billing.quota import model_allowed
        if not model_allowed(plan, model):
            raise HTTPException(status_code=403, detail={
                "code": "model_not_allowed",
                "message": f"El modelo '{model}' no está incluido en tu plan {plan['name']}.",
            })
        tok_limit = int(plan.get("tokens_per_month") or -1)
        if tok_limit < 0:  # plan ilimitado ⇒ la suscripción cubre todo
            return "plan"
        used = get_usage_quota(user_id, "month", _current_month())["tokens"]
        if used < tok_limit:
            return "plan"  # aún dentro de la cuota mensual del plan
        # Cuota del plan agotada: seguir con créditos si tiene saldo
        balance = get_credit_balance(user_id)
        if balance > CREDITS_MIN_START_MICROUSD:
            return "credits"
        raise HTTPException(status_code=402, detail={
            "code": "plan_tokens_exhausted",
            "message": (
                f"Agotaste los {tok_limit:,} tokens mensuales de tu plan {plan['name']}. "
                "Recarga créditos para seguir usando la API este mes (pagas solo por lo que uses)."
            ),
            "balance_usd": microusd_to_usd(balance),
            "topup_path": "/account/facturacion",
        })

    # Sin plan de pago (Gratuito): prepago por créditos
    balance = get_credit_balance(user_id)
    if balance <= CREDITS_MIN_START_MICROUSD:
        raise HTTPException(status_code=402, detail={
            "code": "insufficient_credits",
            "message": "No tienes créditos de API disponibles. Recarga saldo en "
                       "Ajustes → Facturación.",
            "balance_usd": microusd_to_usd(balance),
            "topup_path": "/account/facturacion",
        })
    return "credits"


def debit_usage(user_id: int, model: str | None, prompt_tokens: int,
                completion_tokens: int) -> None:
    """Descuenta el costo real al terminar la inferencia. Nunca tumba la
    respuesta ya emitida: un fallo queda en el log para reconciliar."""
    if prompt_tokens <= 0 and completion_tokens <= 0:
        return
    try:
        pricing = resolve_pricing(model)
        cost = compute_cost_microusd(pricing, prompt_tokens, completion_tokens)
        balance = debit_credit_usage(user_id, cost, model, prompt_tokens, completion_tokens)
        logger.info(
            f"[credits] user={user_id} model={model} tokens={prompt_tokens}+{completion_tokens} "
            f"costo={microusd_to_usd(cost)}$ saldo={microusd_to_usd(balance)}$"
        )
    except Exception as exc:
        logger.error(f"[credits] No se pudo debitar el uso (user={user_id}, model={model}): {exc}")
