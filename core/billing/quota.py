"""
quota.py — Enforcement de límites por plan (F5) + pool de créditos de sesión
(4h, inicio dinámico) y semana (fija, anclada por cuenta) — F8.

F8 reemplaza a messages_per_day/tokens_per_month como GATE del chat de las 4
apps de primera parte (web por cookie; desktop/CLI/móvil por su API key propia,
ver FIRST_PARTY_KEY_NAMES en core.gateway.routers.auth). Esos dos campos viejos
del plan siguen existiendo y contándose (bump_usage_quota/record_tokens) porque
credits.ensure_can_use_api todavía los usa para decidir cuándo el tráfico de
una API key EXTERNA pasa de "cubierto por el plan" a "prepago por créditos" —
ese camino no se tocó.

Los límites viven en las tablas `plans` y `usage_policy` (no en el código):
ajustar un plan o la base del pool = UPDATE, sin redeploy. Postgres
(usage_quotas, usage_credit_windows) es la fuente de verdad — el upsert
atómico con RETURNING evita carreras entre réplicas.

Todas las respuestas de límite son 429 con detail estructurado:
  {"code", "scope", "message", "reset_at"}  — la web muestra `message`.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException

from core.config import SESSION_QUOTA_ENFORCE
from core.persistence.queries import (
    bump_credit_window,
    bump_usage_quota,
    get_latest_credit_window,
    get_or_create_credit_window,
    get_usage_policy,
    get_usage_quota,
    get_week_anchor_slot,
    list_model_weights,
)
from core.security.ratelimit import _get_redis, enforce_rate_limit

logger = logging.getLogger("lixbon.quota")

UNLIMITED = -1
PLANES_CON_VISUALS = ("pro", "advance")

# Época fija (lunes 00:00 UTC) desde la que se cuentan los ciclos semanales de
# créditos. No representa nada especial; solo hace falta que sea siempre la
# misma para que el cálculo de "en qué ciclo cae `now`" sea determinista.
_WEEK_EPOCH = datetime(2024, 1, 1, tzinfo=timezone.utc)
_WEEK_SECONDS = 7 * 86400


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


def ensure_can_use_visuals(user_data: dict[str, Any], plan: dict[str, Any]) -> None:
    """Visuals es de Pro y Advance; los admins lo ven siempre."""
    if user_data.get("role") == "admin" or plan.get("id") in PLANES_CON_VISUALS:
        return
    raise HTTPException(status_code=403, detail={
        "code": "visuals_requires_plan",
        "scope": "plan",
        "message": "Visuals está incluido en los planes Pro y Advance. Mejora tu plan para usarlo.",
    })


# ── F8: pool de créditos de sesión (4h) + semana ────────────────────────────

_weights_cache: dict[str, Any] = {"at": 0.0, "rows": []}
_WEIGHTS_TTL_S = 60


def _weight_rows() -> list[dict[str, Any]]:
    now = time.monotonic()
    if now - _weights_cache["at"] > _WEIGHTS_TTL_S or not _weights_cache["rows"]:
        try:
            _weights_cache["rows"] = list_model_weights(active_only=True)
            _weights_cache["at"] = now
        except Exception as exc:
            logger.error(f"No se pudieron cargar los pesos de modelo ({exc})")
    return _weights_cache["rows"]


def invalidate_weights_cache() -> None:
    """El panel admin la llama al editar pesos para que apliquen al instante."""
    _weights_cache["at"] = 0.0
    _weights_cache["rows"] = []


def resolve_model_weight(model: str | None) -> dict[str, Any]:
    """Tarifa en créditos aplicable al modelo: longest-prefix-match con
    fallback a '*'. A diferencia de credits.resolve_pricing, nunca lanza: sin
    fila ninguna (tabla vacía) usa un peso neutro por defecto, porque el gate
    de sesión/semana es obligatorio y no puede depender de que el admin haya
    configurado algo."""
    default = None
    best = None
    for row in _weight_rows():
        prefix = row["model_prefix"]
        if prefix == "*":
            default = row
            continue
        if model and model.startswith(prefix):
            if best is None or len(prefix) > len(best["model_prefix"]):
                best = row
    return best or default or {
        "input_credits_per_mtok": 1_000_000,
        "output_credits_per_mtok": 4_000_000,
    }


def compute_credit_cost(weight: dict[str, Any], tokens_in: int, tokens_out: int) -> int:
    """Costo entero en créditos: tokens × peso / 1M, sin floats."""
    return (
        max(0, tokens_in) * int(weight["input_credits_per_mtok"])
        + max(0, tokens_out) * int(weight["output_credits_per_mtok"])
    ) // 1_000_000


def _session_window(user_id: int, policy: dict[str, Any]) -> dict[str, Any]:
    """Ventana de sesión vigente: fixed window con inicio dinámico. Si la
    última fila del usuario sigue vigente se reusa tal cual; si no (expiró o
    nunca hubo una), se abre una nueva con period_key = ahora."""
    now = _now()
    latest = get_latest_credit_window(user_id, "session")
    if latest and latest["expires_at"] > now.isoformat():
        return latest
    started_at = now.isoformat()
    hours = float(policy["session_window_hours"])
    expires_at = (now + timedelta(hours=hours)).isoformat()
    return get_or_create_credit_window(user_id, "session", started_at, started_at, expires_at)


def _week_window(user_id: int, policy: dict[str, Any]) -> dict[str, Any]:
    """Ventana semanal vigente: fixed window anclada a `User.week_anchor_slot`
    (0-167, asignada una vez por cuenta), NUNCA a la fecha de suscripción —
    así los resets de distintas cuentas no se concentran en el mismo instante.
    """
    now = _now()
    anchor_offset = timedelta(hours=get_week_anchor_slot(user_id))
    elapsed = (now - _WEEK_EPOCH - anchor_offset).total_seconds()
    cycle_index = int(elapsed // _WEEK_SECONDS)
    cycle_start = _WEEK_EPOCH + anchor_offset + timedelta(seconds=cycle_index * _WEEK_SECONDS)
    cycle_end = cycle_start + timedelta(seconds=_WEEK_SECONDS)
    period_key = cycle_start.isoformat()
    return get_or_create_credit_window(
        user_id, "week", period_key, cycle_start.isoformat(), cycle_end.isoformat(),
    )


def _credit_limit(policy: dict[str, Any], plan: dict[str, Any], bucket: str) -> int:
    """Límite efectivo = base × multiplicador del plan. Una base negativa
    (usage_policy.session_base_credits/week_base_credits = -1) desactiva el
    bucket sin depender de que el multiplicador dé exactamente -1, cosa que la
    multiplicación no garantiza (0.5 × -1 = -0.5)."""
    base = int(policy["session_base_credits"] if bucket == "session" else policy["week_base_credits"])
    if base < 0:
        return UNLIMITED
    mult_key = "session_credit_multiplier" if bucket == "session" else "week_credit_multiplier"
    return int(round(base * float(plan.get(mult_key, 1.0))))


def ensure_session_week_credits(user_id: int, plan: dict[str, Any]) -> None:
    """Gate real del chat (F8). Evalúa sesión y semana como CONJUNTO: si
    cualquiera de los dos está agotado, 429 nombrando cuál y su reset_at.
    SESSION_QUOTA_ENFORCE=0 desactiva el bloqueo (solo abre/lee las ventanas,
    para que credit_buckets_snapshot tenga datos reales) — vía de escape para
    verificar en producción sin cortar tráfico real."""
    policy = get_usage_policy()
    session = _session_window(user_id, policy)
    week = _week_window(user_id, policy)

    if not SESSION_QUOTA_ENFORCE:
        return

    session_limit = _credit_limit(policy, plan, "session")
    if session_limit != UNLIMITED and session["credits_used"] >= session_limit:
        reset = datetime.fromisoformat(session["expires_at"])
        raise _limit_error(
            "session_quota_exhausted", "session",
            f"Agotaste el cupo de tu sesión actual del plan {plan['name']}. "
            f"Se reinicia en {_human_wait(reset)}.",
            reset,
        )

    week_limit = _credit_limit(policy, plan, "week")
    if week_limit != UNLIMITED and week["credits_used"] >= week_limit:
        reset = datetime.fromisoformat(week["expires_at"])
        raise _limit_error(
            "week_quota_exhausted", "week",
            f"Agotaste el cupo semanal del plan {plan['name']}. "
            f"Se reinicia en {_human_wait(reset)}.",
            reset,
        )


def record_session_week_tokens(user_id: int, model: str | None,
                               tokens_in: int, tokens_out: int) -> None:
    """Registra el costo ponderado real de una inferencia en AMBOS buckets, al
    terminar. Nunca lanza — un fallo aquí no debe tumbar una respuesta ya
    servida (mismo contrato que record_tokens)."""
    if tokens_in <= 0 and tokens_out <= 0:
        return
    try:
        cost = compute_credit_cost(resolve_model_weight(model), tokens_in, tokens_out)
        if cost <= 0:
            return
        policy = get_usage_policy()
        session = _session_window(user_id, policy)
        week = _week_window(user_id, policy)
        bump_credit_window(user_id, "session", session["period_key"],
                           session["started_at"], session["expires_at"],
                           credits_inc=cost, messages_inc=1)
        bump_credit_window(user_id, "week", week["period_key"],
                           week["started_at"], week["expires_at"],
                           credits_inc=cost, messages_inc=1)
    except Exception as exc:
        logger.error(f"No se pudo registrar el uso de créditos de sesión/semana ({exc})")


def credit_buckets_snapshot(user_id: int, plan: dict[str, Any]) -> dict[str, Any]:
    """Para 'Mi cuenta': % consumido y reset_at de cada bucket."""
    policy = get_usage_policy()
    session = _session_window(user_id, policy)
    week = _week_window(user_id, policy)
    session_limit = _credit_limit(policy, plan, "session")
    week_limit = _credit_limit(policy, plan, "week")

    def _bucket(row: dict[str, Any], limit: int) -> dict[str, Any]:
        used = int(row["credits_used"])
        unlimited = limit == UNLIMITED
        pct = 0.0 if unlimited or limit <= 0 else round(min(100.0, used / limit * 100), 1)
        return {
            "used": used,
            "limit": limit,
            "unlimited": unlimited,
            "percent": pct,
            "reset_at": row["expires_at"],
            "messages": int(row["messages"]),
        }

    return {"session": _bucket(session, session_limit), "week": _bucket(week, week_limit)}


# ── F5 (legacy, ver docstring del módulo) ───────────────────────────────────

def ensure_can_chat(user_id: int, plan: dict[str, Any], model: str | None = None) -> None:
    """
    Verificación previa a la inferencia. Lanza 403 (modelo fuera del plan),
    429 (rate limit) o 429 (sesión/semana agotada — F8, ver
    ensure_session_week_credits). messages/día se sigue contando para
    estadística del panel de uso, pero ya no bloquea: el gate real es F8.
    """
    if not model_allowed(plan, model):
        raise HTTPException(status_code=403, detail={
            "code": "model_not_allowed",
            "scope": "model",
            "message": f"El modelo '{model}' no está incluido en el plan {plan['name']}. "
                       "Mejora tu plan para usarlo.",
        })

    enforce_rate_limit(f"user:{user_id}", limit=plan.get("rate_limit_per_min"))

    bump_usage_quota(user_id, "day", _today(), messages_inc=1)  # estadística (F5 legacy)

    ensure_session_week_credits(user_id, plan)  # F8: gate real


def record_tokens(user_id: int, tokens: int) -> None:
    """Registra los tokens consumidos al terminar una inferencia (F5 legacy):
    alimenta tokens/mes, que credits.ensure_can_use_api sigue usando para
    decidir cuándo el tráfico de API key EXTERNA pasa a prepago. Ya no es el
    gate del chat (ver record_session_week_tokens para eso)."""
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
    """Uso del período actual + límites del plan (shape legacy de F5, para
    clientes que todavía no leen `buckets`). No bloquea nada."""
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
