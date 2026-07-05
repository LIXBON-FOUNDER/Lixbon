"""
queries.py — Operaciones de persistencia de FOLAX sobre Postgres (SQLAlchemy).
Expone la misma API de funciones que la capa legacy (db_sqlite/db_mysql) para
que los routers no cambien; la implementación es única y sin ramas por backend.
"""
from __future__ import annotations

import hashlib
import json as _json
import math
import os
import secrets
import struct
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import delete, desc, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError

from core.persistence.database import get_session, init_db  # noqa: F401 — init_db se re-exporta
from core.persistence.models import (
    ApiKey,
    AppVersion,
    AuditEvent,
    Conversation,
    EmailToken,
    Message,
    Node,
    Plan,
    Session,
    Subscription,
    TaskEmbedding,
    TokenUsageDaily,
    UsageQuota,
    User,
)

KEY_EXPIRY_DAYS = 90
INACTIVE_ARCHIVE_DAYS = 30


# ─── Helpers ───────────────────────────────────────────────────────────────

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def hash_api_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


def hash_password(password: str) -> str:
    """Hash seguro con scrypt + salt aleatorio. Formato: 'scrypt$<salt_hex>$<dk_hex>'"""
    salt = os.urandom(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${salt.hex()}${dk.hex()}"


def _verify_password_internal(password: str, stored_hash: str) -> bool:
    """Verifica password contra hash scrypt o SHA-256 legacy (en tiempo constante)."""
    if stored_hash.startswith("scrypt$"):
        try:
            _, salt_hex, dk_hex = stored_hash.split("$", 2)
            salt = bytes.fromhex(salt_hex)
            dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1)
            return secrets.compare_digest(dk.hex(), dk_hex)
        except Exception:
            return False
    legacy = hashlib.sha256(password.encode("utf-8")).hexdigest()
    return secrets.compare_digest(legacy, stored_hash)


# ─── Helpers vectoriales ───────────────────────────────────────────────────

def serialize_vector(vec: list[float]) -> bytes:
    return struct.pack(f"{len(vec)}f", *vec)


def deserialize_vector(blob: bytes) -> tuple[float, ...]:
    n = len(blob) // 4
    return struct.unpack(f"{n}f", blob)


def cosine_similarity(v1: Any, v2: Any) -> float:
    dot = sum(a * b for a, b in zip(v1, v2))
    norm1 = math.sqrt(sum(a * a for a in v1))
    norm2 = math.sqrt(sum(b * b for b in v2))
    if norm1 == 0 or norm2 == 0:
        return 0.0
    return dot / (norm1 * norm2)


# ─── Usuarios ──────────────────────────────────────────────────────────────

def _user_to_dict(user: User) -> dict[str, Any]:
    return {
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "role": user.role or "user",
        "email_verified": bool(user.email_verified),
        "is_active": bool(user.is_active),
        "created_at": user.created_at,
    }


def create_user(
    email: str,
    password: str,
    first_name: str | None = None,
    last_name: str | None = None,
) -> dict[str, Any] | None:
    """Crea un usuario nuevo (login por email). Retorna None si el email ya existe."""
    email = email.strip().lower()
    admin_emails = [e.strip().lower() for e in os.getenv("ADMIN_EMAILS", "").split(",") if e.strip()]
    try:
        with get_session() as s:
            user = User(
                username=email,           # legacy: username = email para usuarios nuevos
                email=email,
                first_name=(first_name or "").strip() or None,
                last_name=(last_name or "").strip() or None,
                role="admin" if email in admin_emails else "user",
                email_verified=0,
                password_hash=hash_password(password),
                created_at=now_iso(),
            )
            s.add(user)
            s.flush()
            return _user_to_dict(user)
    except IntegrityError:
        return None


def verify_user(identifier: str, password: str) -> dict[str, Any] | None:
    """
    Verifica credenciales por email (o username legacy para cuentas pre-F3).
    Migra hashes legacy SHA-256 → scrypt al validar.
    """
    ident = identifier.strip().lower()
    with get_session() as s:
        user = s.scalar(select(User).where(func.lower(User.email) == ident))
        if not user:
            user = s.scalar(select(User).where(User.username == identifier.strip()))
        if not user:
            return None
        if not _verify_password_internal(password, user.password_hash):
            return None
        if not user.is_active:
            return None  # bloqueado por admin (F6)
        if not user.password_hash.startswith("scrypt$"):
            user.password_hash = hash_password(password)
        return _user_to_dict(user)


def get_user_by_id(user_id: int) -> dict[str, Any] | None:
    with get_session() as s:
        user = s.get(User, user_id)
        return _user_to_dict(user) if user else None


def get_user_by_email(email: str) -> dict[str, Any] | None:
    with get_session() as s:
        user = s.scalar(select(User).where(func.lower(User.email) == email.strip().lower()))
        return _user_to_dict(user) if user else None


def update_user_profile(user_id: int, first_name: str, last_name: str) -> None:
    with get_session() as s:
        s.execute(
            update(User).where(User.id == user_id)
            .values(first_name=first_name or None, last_name=last_name or None)
        )


def set_user_password(user_id: int, new_password: str) -> None:
    with get_session() as s:
        s.execute(
            update(User).where(User.id == user_id)
            .values(password_hash=hash_password(new_password))
        )


def mark_email_verified(user_id: int) -> None:
    with get_session() as s:
        s.execute(update(User).where(User.id == user_id).values(email_verified=1))


# ─── Sesiones web (cookie) ─────────────────────────────────────────────────

SESSION_EXPIRY_HOURS = int(os.getenv("SESSION_EXPIRY_HOURS", "168"))  # 7 días por defecto


def create_web_session(user_id: int, ip_address: str | None = None,
                       user_agent: str | None = None) -> str:
    """Crea una sesión web y retorna el token en claro (solo se almacena el hash)."""
    raw_token = f"folax_ses_{secrets.token_urlsafe(32)}"
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=SESSION_EXPIRY_HOURS)).isoformat()
    with get_session() as s:
        s.add(Session(
            user_id=user_id,
            token_hash=hash_api_key(raw_token),
            expires_at=expires_at,
            ip_address=ip_address,
            user_agent=(user_agent or "")[:300] or None,
            created_at=now_iso(),
        ))
    return raw_token


def validate_web_session(raw_token: str) -> dict[str, Any] | None:
    """Valida el token de sesión y retorna el usuario, o None si no existe/expiró."""
    if not raw_token:
        return None
    with get_session() as s:
        ses = s.scalar(select(Session).where(Session.token_hash == hash_api_key(raw_token)))
        if not ses or ses.expires_at < now_iso():
            return None
        user = s.get(User, ses.user_id)
        if not user or not user.is_active:
            return None  # usuario bloqueado: la sesión deja de valer al instante
        return _user_to_dict(user)


def delete_web_session(raw_token: str) -> None:
    with get_session() as s:
        s.execute(delete(Session).where(Session.token_hash == hash_api_key(raw_token)))


def purge_expired_sessions() -> int:
    with get_session() as s:
        result = s.execute(delete(Session).where(Session.expires_at < now_iso()))
        return result.rowcount


# ─── Tokens de email (verificación / reset de contraseña) ──────────────────

def create_email_token(user_id: int, purpose: str, hours: int = 24) -> str:
    """Crea un token de un solo uso. purpose: 'verify_email' | 'reset_password'."""
    raw = secrets.token_urlsafe(32)
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()
    with get_session() as s:
        s.add(EmailToken(
            user_id=user_id,
            token_hash=hash_api_key(raw),
            purpose=purpose,
            expires_at=expires_at,
            created_at=now_iso(),
        ))
    return raw


def consume_email_token(raw_token: str, purpose: str) -> int | None:
    """Valida y quema el token. Retorna el user_id o None."""
    if not raw_token:
        return None
    with get_session() as s:
        tok = s.scalar(select(EmailToken).where(
            EmailToken.token_hash == hash_api_key(raw_token),
            EmailToken.purpose == purpose,
            EmailToken.used == 0,
        ))
        if not tok or tok.expires_at < now_iso():
            return None
        tok.used = 1
        return tok.user_id


# ─── API Keys ──────────────────────────────────────────────────────────────

def _key_expires_at() -> str:
    return (datetime.now(timezone.utc) + timedelta(days=KEY_EXPIRY_DAYS)).isoformat()


def get_active_key_for_user(user_id: int) -> dict[str, Any] | None:
    with get_session() as s:
        row = s.scalar(
            select(ApiKey)
            .where(
                ApiKey.user_id == user_id,
                ApiKey.is_active == 1,
                ApiKey.status == "active",
                ApiKey.expires_at > now_iso(),
            )
            .order_by(desc(ApiKey.created_at))
            .limit(1)
        )
        if not row:
            return None
        return {
            "id": row.id,
            "expires_at": row.expires_at,
            "scopes": row.scopes,
            "model": row.model,
            "key_prefix": row.key_prefix,
            "created_at": row.created_at,
        }


def create_api_key(
    name: str,
    user_id: int,
    model: str | None = None,
    scopes: str = "read,write",
) -> tuple[str, dict[str, Any]]:
    raw_key = f"folax_sk_{secrets.token_urlsafe(28)}"
    created_at = now_iso()
    expires_at = _key_expires_at()
    with get_session() as s:
        key = ApiKey(
            user_id=user_id,
            name=name,
            key_hash=hash_api_key(raw_key),
            raw_key=None,               # F3: la key en claro nunca se persiste
            key_prefix=raw_key[:14],
            is_active=1,
            status="active",
            scopes=scopes,
            model=model,
            expires_at=expires_at,
            last_accessed=created_at,
            created_at=created_at,
        )
        s.add(key)
        s.flush()
        key_data = {
            "id": key.id,
            "name": name,
            "model": model,
            "scopes": scopes.split(","),
            "is_active": True,
            "status": "active",
            "key_prefix": key.key_prefix,
            "created_at": created_at,
            "expires_at": expires_at,
        }
    return raw_key, key_data


def deactivate_key(key_id: int, user_id: int | None = None) -> bool:
    """
    Soft delete de una key. Con user_id solo desactiva keys de ESE usuario
    (protección IDOR). Retorna False si no encontró nada.
    """
    stmt = update(ApiKey).where(ApiKey.id == key_id)
    if user_id is not None:
        stmt = stmt.where(ApiKey.user_id == user_id)
    with get_session() as s:
        result = s.execute(
            stmt.values(is_active=0, status="inactive", deactivated_at=now_iso())
        )
        return result.rowcount > 0


def deactivate_all_user_keys(user_id: int) -> None:
    with get_session() as s:
        s.execute(
            update(ApiKey)
            .where(ApiKey.user_id == user_id, ApiKey.is_active == 1)
            .values(is_active=0, status="inactive", deactivated_at=now_iso())
        )


def update_last_accessed(key_hash: str, ip_address: str | None) -> None:
    with get_session() as s:
        s.execute(
            update(ApiKey)
            .where(ApiKey.key_hash == key_hash)
            .values(last_accessed=now_iso(), last_used_ip=ip_address)
        )


def archive_old_inactive_keys() -> int:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=INACTIVE_ARCHIVE_DAYS)).isoformat()
    with get_session() as s:
        result = s.execute(
            update(ApiKey)
            .where(ApiKey.status == "inactive", ApiKey.deactivated_at < cutoff)
            .values(status="archived")
        )
        return result.rowcount


def count_daily_regenerations(user_id: int) -> int:
    today_start = (
        datetime.now(timezone.utc)
        .replace(hour=0, minute=0, second=0, microsecond=0)
        .isoformat()
    )
    with get_session() as s:
        return s.scalar(
            select(func.count())
            .select_from(AuditEvent)
            .where(
                AuditEvent.user_id == user_id,
                AuditEvent.event_type == "api_key_regenerated",
                AuditEvent.created_at >= today_start,
            )
        ) or 0


def list_api_keys(user_id: int | None = None) -> list[dict[str, Any]]:
    with get_session() as s:
        stmt = select(ApiKey).order_by(desc(ApiKey.id))
        if user_id is not None:
            stmt = stmt.where(ApiKey.user_id == user_id)
        rows = s.scalars(stmt).all()

        result = []
        for row in rows:
            prefix = row.key_prefix or "folax_sk_"
            suffix = row.key_hash[-6:] if row.key_hash else "??????"
            result.append({
                "id": row.id,
                "name": row.name,
                "model": row.model,
                "scopes": (row.scopes or "read,write").split(","),
                "status": row.status or ("active" if row.is_active else "inactive"),
                "is_active": bool(row.is_active),
                "masked_key": f"{prefix}...{suffix}",
                "expires_at": row.expires_at,
                "last_accessed": row.last_accessed,
                "last_used_ip": row.last_used_ip,
                "created_at": row.created_at,
            })
        return result


def validate_api_key(raw_key: str, ip_address: str | None = None) -> dict[str, Any] | None:
    """Valida la key, verifica expiración y actualiza last_accessed."""
    if not raw_key:
        return None
    key_hash = hash_api_key(raw_key)
    now = now_iso()
    with get_session() as s:
        row = s.scalar(
            select(ApiKey).where(
                ApiKey.key_hash == key_hash,
                ApiKey.is_active == 1,
                ApiKey.status != "archived",
            )
        )
        if not row:
            return None
        if row.expires_at and row.expires_at < now:
            return None
        user = s.get(User, row.user_id)
        if not user or not user.is_active:
            return None  # usuario bloqueado: sus keys dejan de funcionar
        result = {**_user_to_dict(user), "key_model": row.model}
        row.last_accessed = now
        row.last_used_ip = ip_address
        return result


# ─── Audit Log ─────────────────────────────────────────────────────────────

def log_audit_event(
    event_type: str,
    user_id: int | None = None,
    key_id: int | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
    **metadata,
) -> None:
    with get_session() as s:
        s.add(AuditEvent(
            event_type=event_type,
            user_id=user_id,
            key_id=key_id,
            ip_address=ip_address,
            user_agent=user_agent,
            metadata_json=_json.dumps(metadata) if metadata else None,
            created_at=now_iso(),
        ))


def list_audit_events(
    user_id: int | None = None,
    limit: int = 50,
    offset: int = 0,
    event_type: str | None = None,
) -> list[dict[str, Any]]:
    with get_session() as s:
        stmt = (
            select(AuditEvent)
            .order_by(desc(AuditEvent.created_at))
            .offset(offset)
            .limit(limit)
        )
        if user_id is not None:
            stmt = stmt.where(AuditEvent.user_id == user_id)
        if event_type:
            stmt = stmt.where(AuditEvent.event_type == event_type)
        rows = s.scalars(stmt).all()

        result = []
        for row in rows:
            r = {
                "id": row.id,
                "event_type": row.event_type,
                "key_id": row.key_id,
                "ip_address": row.ip_address,
                "created_at": row.created_at,
            }
            if user_id is None:
                r["user_id"] = row.user_id
            try:
                r["metadata"] = _json.loads(row.metadata_json) if row.metadata_json else {}
            except Exception:
                r["metadata"] = {}
            result.append(r)
        return result


# ─── Task Embeddings (vector store) ────────────────────────────────────────

def save_task_embedding(
    user_id: int,
    user_input: str,
    classification: dict[str, Any],
    router_used: str,
    model_called: str | None,
    response_summary: str | None,
    success: bool,
    embedding: list[float],
) -> int:
    with get_session() as s:
        task = TaskEmbedding(
            user_id=user_id,
            user_input=user_input,
            intent=classification.get("intent"),
            complexity=classification.get("complexity"),
            domain=classification.get("domain"),
            risk_level=classification.get("riskLevel"),
            router_used=router_used,
            model_called=model_called,
            response_summary=response_summary,
            success=1 if success else 0,
            embedding_blob=serialize_vector(embedding) if embedding else None,
            created_at=now_iso(),
        )
        s.add(task)
        s.flush()
        return task.id


def find_similar_tasks(
    user_id: int,
    query_embedding: list[float],
    top_k: int = 5,
) -> list[dict[str, Any]]:
    with get_session() as s:
        rows = s.scalars(
            select(TaskEmbedding)
            .where(TaskEmbedding.user_id == user_id, TaskEmbedding.embedding_blob.is_not(None))
            .order_by(desc(TaskEmbedding.created_at))
            .limit(100)
        ).all()

        results = []
        for row in rows:
            vec = deserialize_vector(row.embedding_blob)
            results.append({
                "user_input": row.user_input,
                "intent": row.intent,
                "complexity": row.complexity,
                "domain": row.domain,
                "risk_level": row.risk_level,
                "router_used": row.router_used,
                "model_called": row.model_called,
                "similarity": cosine_similarity(query_embedding, vec),
            })

    results.sort(key=lambda x: x["similarity"], reverse=True)
    return results[:top_k]


# ─── Planes, suscripciones y cuotas (F5) ───────────────────────────────────

DEFAULT_PLAN_ID = "free"


def _plan_to_dict(p: Plan) -> dict[str, Any]:
    return {
        "id": p.id,
        "name": p.name,
        "description": p.description,
        "price_monthly_cents": p.price_monthly_cents,
        "currency": p.currency,
        "messages_per_day": p.messages_per_day,
        "tokens_per_month": p.tokens_per_month,
        "max_api_keys": p.max_api_keys,
        "rate_limit_per_min": p.rate_limit_per_min,
        "allowed_models": _json.loads(p.allowed_models) if p.allowed_models else None,
        "priority": p.priority,
        "sort_order": p.sort_order,
        "is_active": bool(p.is_active),
        "stripe_price_id": p.stripe_price_id,
    }


def list_plans(active_only: bool = True) -> list[dict[str, Any]]:
    with get_session() as s:
        stmt = select(Plan).order_by(Plan.sort_order)
        if active_only:
            stmt = stmt.where(Plan.is_active == 1)
        return [_plan_to_dict(p) for p in s.scalars(stmt).all()]


def get_plan(plan_id: str) -> dict[str, Any] | None:
    with get_session() as s:
        p = s.get(Plan, plan_id)
        return _plan_to_dict(p) if p else None


def get_plan_for_user(user_id: int) -> dict[str, Any]:
    """Plan vigente del usuario. Sin suscripción (o expirada) ⇒ plan por defecto."""
    with get_session() as s:
        sub = s.scalars(select(Subscription).where(Subscription.user_id == user_id)).first()
        plan_id = DEFAULT_PLAN_ID
        if sub and sub.status == "active":
            if not sub.expires_at or sub.expires_at > now_iso():
                plan_id = sub.plan_id
        p = s.get(Plan, plan_id) or s.get(Plan, DEFAULT_PLAN_ID)
        if not p:
            # BD sin seed (no debería pasar: init_db lo garantiza)
            raise RuntimeError("La tabla plans está vacía — falta el seed de planes")
        return _plan_to_dict(p)


def set_user_plan(user_id: int, plan_id: str, expires_at: str | None = None) -> bool:
    """Asigna (o cambia) el plan de un usuario. False si el plan no existe."""
    ts = now_iso()
    with get_session() as s:
        if not s.get(Plan, plan_id):
            return False
        sub = s.scalars(select(Subscription).where(Subscription.user_id == user_id)).first()
        if sub:
            sub.plan_id = plan_id
            sub.status = "active"
            sub.expires_at = expires_at
            sub.updated_at = ts
        else:
            s.add(Subscription(
                user_id=user_id, plan_id=plan_id, status="active",
                started_at=ts, expires_at=expires_at, created_at=ts, updated_at=ts,
            ))
        return True


def get_plan_by_stripe_price(price_id: str) -> dict[str, Any] | None:
    """Mapea un price_... de Stripe al plan correspondiente (para el webhook)."""
    if not price_id:
        return None
    with get_session() as s:
        p = s.scalars(select(Plan).where(Plan.stripe_price_id == price_id)).first()
        return _plan_to_dict(p) if p else None


def _subscription_to_dict(sub: Subscription) -> dict[str, Any]:
    return {
        "user_id": sub.user_id,
        "plan_id": sub.plan_id,
        "status": sub.status,
        "started_at": sub.started_at,
        "expires_at": sub.expires_at,
        "stripe_customer_id": sub.stripe_customer_id,
        "stripe_subscription_id": sub.stripe_subscription_id,
        "current_period_end": sub.current_period_end,
        "cancel_at_period_end": bool(sub.cancel_at_period_end),
    }


def get_subscription(user_id: int) -> dict[str, Any] | None:
    """Suscripción cruda del usuario (con campos de Stripe), o None."""
    with get_session() as s:
        sub = s.scalars(select(Subscription).where(Subscription.user_id == user_id)).first()
        return _subscription_to_dict(sub) if sub else None


def get_user_by_stripe_customer(customer_id: str) -> dict[str, Any] | None:
    """Usuario dueño de un customer de Stripe (para el webhook)."""
    if not customer_id:
        return None
    with get_session() as s:
        sub = s.scalars(
            select(Subscription).where(Subscription.stripe_customer_id == customer_id)
        ).first()
        if not sub:
            return None
        user = s.get(User, sub.user_id)
        return _user_to_dict(user) if user else None


def set_stripe_customer(user_id: int, customer_id: str) -> None:
    """Guarda (o crea) el customer de Stripe del usuario sin cambiar su plan."""
    ts = now_iso()
    with get_session() as s:
        sub = s.scalars(select(Subscription).where(Subscription.user_id == user_id)).first()
        if sub:
            sub.stripe_customer_id = customer_id
            sub.updated_at = ts
        else:
            s.add(Subscription(
                user_id=user_id, plan_id=DEFAULT_PLAN_ID, status="active",
                started_at=ts, stripe_customer_id=customer_id,
                created_at=ts, updated_at=ts,
            ))


def apply_stripe_subscription(
    user_id: int,
    plan_id: str,
    *,
    customer_id: str | None = None,
    subscription_id: str | None = None,
    current_period_end: str | None = None,
    cancel_at_period_end: bool = False,
    status: str = "active",
) -> bool:
    """Refleja en la BD el estado de una suscripción de Stripe (idempotente)."""
    ts = now_iso()
    with get_session() as s:
        if not s.get(Plan, plan_id):
            return False
        sub = s.scalars(select(Subscription).where(Subscription.user_id == user_id)).first()
        if not sub:
            sub = Subscription(user_id=user_id, plan_id=plan_id, started_at=ts,
                               created_at=ts, updated_at=ts)
            s.add(sub)
        sub.plan_id = plan_id
        sub.status = status
        if customer_id:
            sub.stripe_customer_id = customer_id
        sub.stripe_subscription_id = subscription_id
        sub.current_period_end = current_period_end
        sub.cancel_at_period_end = 1 if cancel_at_period_end else 0
        # expires_at = fin del ciclo pagado, para que get_plan_for_user degrade solo
        sub.expires_at = current_period_end if cancel_at_period_end else None
        sub.updated_at = ts
        return True


def downgrade_to_free(user_id: int) -> None:
    """Degrada al plan gratuito (cancelación/impago) limpiando el enlace de Stripe."""
    ts = now_iso()
    with get_session() as s:
        sub = s.scalars(select(Subscription).where(Subscription.user_id == user_id)).first()
        if not sub:
            return
        sub.plan_id = DEFAULT_PLAN_ID
        sub.status = "canceled"
        sub.stripe_subscription_id = None
        sub.current_period_end = None
        sub.cancel_at_period_end = 0
        sub.expires_at = None
        sub.updated_at = ts


def bump_usage_quota(user_id: int, period_type: str, period_start: str,
                     messages_inc: int = 0, tokens_inc: int = 0) -> dict[str, int]:
    """Incrementa (atómico, upsert) el contador del período. Retorna totales."""
    ts = now_iso()
    with get_session() as s:
        stmt = pg_insert(UsageQuota).values(
            user_id=user_id, period_type=period_type, period_start=period_start,
            messages=messages_inc, tokens=tokens_inc, updated_at=ts,
        ).on_conflict_do_update(
            constraint="uq_usage_quotas_period",
            set_={
                "messages": UsageQuota.messages + messages_inc,
                "tokens": UsageQuota.tokens + tokens_inc,
                "updated_at": ts,
            },
        ).returning(UsageQuota.messages, UsageQuota.tokens)
        row = s.execute(stmt).one()
        return {"messages": int(row.messages), "tokens": int(row.tokens)}


def get_usage_quota(user_id: int, period_type: str, period_start: str) -> dict[str, int]:
    with get_session() as s:
        row = s.scalars(
            select(UsageQuota).where(
                UsageQuota.user_id == user_id,
                UsageQuota.period_type == period_type,
                UsageQuota.period_start == period_start,
            )
        ).first()
        return {"messages": row.messages if row else 0, "tokens": row.tokens if row else 0}


def count_active_keys(user_id: int) -> int:
    with get_session() as s:
        return int(s.execute(
            select(func.count(ApiKey.id)).where(ApiKey.user_id == user_id, ApiKey.is_active == 1)
        ).scalar_one())


def list_users_admin(q: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
    """Listado para el admin: usuario + plan vigente (asignación manual, F5.7)."""
    with get_session() as s:
        stmt = (
            select(User, Subscription.plan_id)
            .outerjoin(Subscription, Subscription.user_id == User.id)
            .order_by(desc(User.created_at))
            .limit(limit)
        )
        if q:
            like = f"%{q}%"
            stmt = stmt.where(
                User.email.ilike(like) | User.username.ilike(like)
                | User.first_name.ilike(like) | User.last_name.ilike(like)
            )
        return [
            {**_user_to_dict(u), "plan_id": plan_id or DEFAULT_PLAN_ID}
            for u, plan_id in s.execute(stmt).all()
        ]


def set_user_active(user_id: int, active: bool) -> bool:
    """Bloquea o desbloquea a un usuario (F6). Retorna False si no existe."""
    with get_session() as s:
        result = s.execute(
            update(User).where(User.id == user_id).values(is_active=1 if active else 0)
        )
        return result.rowcount > 0


def update_plan(plan_id: str, fields: dict[str, Any]) -> dict[str, Any] | None:
    """Actualiza campos editables de un plan (F6). Retorna el plan o None si no existe."""
    editable = {
        "name", "description", "price_monthly_cents", "messages_per_day",
        "tokens_per_month", "max_api_keys", "rate_limit_per_min",
        "allowed_models", "is_active", "stripe_price_id",
    }
    values = {k: v for k, v in fields.items() if k in editable}
    if not values:
        return None
    values["updated_at"] = now_iso()
    with get_session() as s:
        plan = s.get(Plan, plan_id)
        if not plan:
            return None
        for k, v in values.items():
            setattr(plan, k, v)
        s.flush()
        return _plan_to_dict(plan)


def get_global_stats(days: int = 30) -> dict[str, Any]:
    """Dashboard global del panel admin (F6): totales + serie diaria del período."""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    with get_session() as s:
        totals = {
            "users": int(s.execute(select(func.count(User.id))).scalar_one()),
            "users_blocked": int(s.execute(
                select(func.count(User.id)).where(User.is_active == 0)
            ).scalar_one()),
            "conversations": int(s.execute(select(func.count(Conversation.id))).scalar_one()),
            "messages": int(s.execute(select(func.count(Message.id))).scalar_one()),
            "active_users_period": int(s.execute(
                select(func.count(func.distinct(TokenUsageDaily.user_id)))
                .where(TokenUsageDaily.usage_date >= since)
            ).scalar_one()),
        }
        by_plan = s.execute(
            select(Subscription.plan_id, func.count(Subscription.id))
            .where(Subscription.status == "active")
            .group_by(Subscription.plan_id)
        ).all()
        totals["by_plan"] = {plan_id: count for plan_id, count in by_plan}

        daily_rows = s.execute(
            select(
                TokenUsageDaily.usage_date,
                func.coalesce(func.sum(TokenUsageDaily.request_count), 0).label("requests"),
                func.coalesce(func.sum(TokenUsageDaily.total_tokens), 0).label("total_tokens"),
                func.coalesce(func.sum(TokenUsageDaily.latency_sum_ms), 0).label("latency_sum_ms"),
            )
            .where(TokenUsageDaily.usage_date >= since)
            .group_by(TokenUsageDaily.usage_date)
            .order_by(TokenUsageDaily.usage_date)
        ).all()
        daily = [
            {
                "usage_date": r.usage_date,
                "requests": int(r.requests),
                "total_tokens": int(r.total_tokens),
                "avg_latency_ms": int(r.latency_sum_ms / r.requests) if r.requests else 0,
            }
            for r in daily_rows
        ]
        return {"totals": totals, "daily": daily}


# ─── Conversaciones y mensajes ─────────────────────────────────────────────

def ensure_conversation(
    conversation_id: str, user_id: int, title: str | None, client_id: str | None
) -> bool:
    """Crea (o toca) la conversación. False si existe pero pertenece a OTRO usuario."""
    ts = now_iso()
    with get_session() as s:
        conv = s.get(Conversation, conversation_id)
        if conv:
            if conv.user_id != user_id:
                return False
            conv.updated_at = ts
            if title:
                conv.title = title
            if client_id:
                conv.client_id = client_id
        else:
            s.add(Conversation(
                id=conversation_id,
                user_id=user_id,
                title=title,
                client_id=client_id,
                created_at=ts,
                updated_at=ts,
            ))
    return True


def save_message(
    conversation_id: str,
    role: str,
    content: str,
    model: str | None = None,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    latency_ms: int = 0,
) -> None:
    total_tokens = prompt_tokens + completion_tokens
    ts = now_iso()
    with get_session() as s:
        s.add(Message(
            conversation_id=conversation_id,
            role=role,
            content=content,
            model=model,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            latency_ms=latency_ms,
            created_at=ts,
        ))
        conv = s.get(Conversation, conversation_id)
        if conv:
            conv.updated_at = ts
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            stmt = pg_insert(TokenUsageDaily).values(
                user_id=conv.user_id,
                usage_date=today,
                model=model or "default",
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                latency_sum_ms=latency_ms,
                request_count=1,
                created_at=ts,
            ).on_conflict_do_update(
                constraint="uq_token_usage_daily",
                set_={
                    "prompt_tokens": TokenUsageDaily.prompt_tokens + prompt_tokens,
                    "completion_tokens": TokenUsageDaily.completion_tokens + completion_tokens,
                    "total_tokens": TokenUsageDaily.total_tokens + total_tokens,
                    "latency_sum_ms": TokenUsageDaily.latency_sum_ms + latency_ms,
                    "request_count": TokenUsageDaily.request_count + 1,
                },
            )
            s.execute(stmt)


def _conversation_to_dict(c: Conversation) -> dict[str, Any]:
    return {
        "id": c.id,
        "title": c.title,
        "client_id": c.client_id,
        "created_at": c.created_at,
        "updated_at": c.updated_at,
    }


def list_conversations(
    user_id: int, limit: int = 50, offset: int = 0, q: str | None = None
) -> list[dict[str, Any]]:
    """Conversaciones del usuario, más recientes primero. `q` busca en el título."""
    with get_session() as s:
        stmt = (
            select(Conversation)
            .where(Conversation.user_id == user_id)
            .order_by(desc(Conversation.updated_at))
            .limit(limit)
            .offset(offset)
        )
        if q:
            stmt = stmt.where(Conversation.title.ilike(f"%{q}%"))
        return [_conversation_to_dict(c) for c in s.scalars(stmt).all()]


def get_conversation(conversation_id: str, user_id: int) -> dict[str, Any] | None:
    """Conversación por id SOLO si pertenece al usuario (evita IDOR)."""
    with get_session() as s:
        conv = s.get(Conversation, conversation_id)
        if not conv or conv.user_id != user_id:
            return None
        return _conversation_to_dict(conv)


def list_messages(conversation_id: str, user_id: int) -> list[dict[str, Any]] | None:
    """Mensajes de una conversación del usuario (None si no existe o es ajena)."""
    with get_session() as s:
        conv = s.get(Conversation, conversation_id)
        if not conv or conv.user_id != user_id:
            return None
        stmt = (
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at, Message.id)
        )
        return [
            {
                "id": m.id,
                "role": m.role,
                "content": m.content,
                "model": m.model,
                "created_at": m.created_at,
            }
            for m in s.scalars(stmt).all()
        ]


def rename_conversation(
    conversation_id: str, user_id: int, title: str, only_if_untitled: bool = False
) -> bool:
    with get_session() as s:
        conv = s.get(Conversation, conversation_id)
        if not conv or conv.user_id != user_id:
            return False
        if only_if_untitled and conv.title:
            return False
        conv.title = title
        conv.updated_at = now_iso()
        return True


def delete_conversation(conversation_id: str, user_id: int) -> bool:
    with get_session() as s:
        conv = s.get(Conversation, conversation_id)
        if not conv or conv.user_id != user_id:
            return False
        s.execute(delete(Message).where(Message.conversation_id == conversation_id))
        s.delete(conv)
        return True


def get_usage_summary(user_id: int | None = None) -> dict[str, int]:
    with get_session() as s:
        stmt = (
            select(
                func.count(func.distinct(Conversation.id)).label("conversations"),
                func.count(Message.id).label("messages"),
                func.coalesce(func.sum(Message.prompt_tokens), 0).label("prompt_tokens"),
                func.coalesce(func.sum(Message.completion_tokens), 0).label("completion_tokens"),
                func.coalesce(func.sum(Message.total_tokens), 0).label("total_tokens"),
            )
            .select_from(Conversation)
            .outerjoin(Message, Message.conversation_id == Conversation.id)
        )
        if user_id is not None:
            stmt = stmt.where(Conversation.user_id == user_id)
        row = s.execute(stmt).one()
        return {
            "conversations": row.conversations,
            "messages": row.messages,
            "prompt_tokens": int(row.prompt_tokens),
            "completion_tokens": int(row.completion_tokens),
            "total_tokens": int(row.total_tokens),
        }


def list_recent_conversations(limit: int = 20, user_id: int | None = None) -> list[dict[str, Any]]:
    with get_session() as s:
        stmt = select(Conversation).order_by(desc(Conversation.updated_at)).limit(limit)
        if user_id is not None:
            stmt = stmt.where(Conversation.user_id == user_id)
        rows = s.scalars(stmt).all()
        return [
            {
                "id": c.id,
                "title": c.title or "Sin título",
                "client_id": c.client_id,
                "created_at": c.created_at,
                "updated_at": c.updated_at,
            }
            for c in rows
        ]


def list_clients_usage(limit: int = 50, user_id: int | None = None) -> list[dict[str, Any]]:
    with get_session() as s:
        client_expr = func.coalesce(Conversation.client_id, "sin_client_id")
        stmt = (
            select(
                client_expr.label("client_id"),
                func.count(func.distinct(Conversation.id)).label("conversations"),
                func.count(Message.id).label("messages"),
                func.coalesce(func.sum(Message.prompt_tokens), 0).label("prompt_tokens"),
                func.coalesce(func.sum(Message.completion_tokens), 0).label("completion_tokens"),
                func.coalesce(func.sum(Message.total_tokens), 0).label("total_tokens"),
                func.max(Conversation.updated_at).label("last_activity"),
            )
            .select_from(Conversation)
            .outerjoin(Message, Message.conversation_id == Conversation.id)
            .group_by(client_expr)
            .order_by(desc("last_activity"))
            .limit(limit)
        )
        if user_id is not None:
            stmt = stmt.where(Conversation.user_id == user_id)
        rows = s.execute(stmt).all()
        return [
            {
                "client_id": r.client_id,
                "conversations": r.conversations,
                "messages": r.messages,
                "prompt_tokens": int(r.prompt_tokens),
                "completion_tokens": int(r.completion_tokens),
                "total_tokens": int(r.total_tokens),
                "last_activity": r.last_activity,
            }
            for r in rows
        ]


# ─── Versiones de la app ───────────────────────────────────────────────────

def _version_to_dict(v: AppVersion) -> dict[str, Any]:
    try:
        changelog = _json.loads(v.changelog_json)
    except Exception:
        changelog = []
    return {
        "id": v.id,
        "version": v.version,
        "channel": v.channel,
        "release_date": v.release_date,
        "title": v.title,
        "changelog": changelog,
        "download_url": v.download_url,
        "checksum_sha256": v.checksum_sha256,
        "created_at": v.created_at,
    }


def get_all_versions() -> list[dict[str, Any]]:
    with get_session() as s:
        rows = s.scalars(select(AppVersion).order_by(desc(AppVersion.release_date))).all()
        return [_version_to_dict(v) for v in rows]


def get_latest_version(channel: str = "stable") -> dict[str, Any] | None:
    with get_session() as s:
        row = s.scalar(
            select(AppVersion)
            .where(AppVersion.channel == channel)
            .order_by(desc(AppVersion.id))
            .limit(1)
        )
        return _version_to_dict(row) if row else None


def add_app_version(
    version: str, channel: str, release_date: str, title: str,
    changelog: list[str], download_url: str, checksum: str | None = None,
) -> None:
    with get_session() as s:
        stmt = pg_insert(AppVersion).values(
            version=version,
            channel=channel,
            release_date=release_date,
            title=title,
            changelog_json=_json.dumps(changelog),
            download_url=download_url,
            checksum_sha256=checksum,
            created_at=now_iso(),
        ).on_conflict_do_update(
            index_elements=["version"],
            set_={
                "channel": channel,
                "release_date": release_date,
                "title": title,
                "changelog_json": _json.dumps(changelog),
                "download_url": download_url,
                "checksum_sha256": checksum,
            },
        )
        s.execute(stmt)


# ─── Nodos del cluster ─────────────────────────────────────────────────────

def _node_to_dict(n: Node, mask_token: bool = True) -> dict[str, Any]:
    return {
        "id": n.id,
        "name": n.name,
        "agent_url": n.agent_url,
        "token": (n.token[:6] + "..." if n.token else None) if mask_token else n.token,
        "enabled": bool(n.enabled),
        "created_at": n.created_at,
    }


def list_nodes(enabled_only: bool = False, mask_token: bool = True) -> list[dict[str, Any]]:
    with get_session() as s:
        stmt = select(Node).order_by(Node.id)
        if enabled_only:
            stmt = stmt.where(Node.enabled == 1)
        return [_node_to_dict(n, mask_token) for n in s.scalars(stmt).all()]


def upsert_node(node_id: str, name: str, agent_url: str, token: str, enabled: bool = True) -> dict[str, Any]:
    with get_session() as s:
        node = s.get(Node, node_id)
        if node:
            node.name = name
            node.agent_url = agent_url
            node.token = token
            node.enabled = 1 if enabled else 0
        else:
            node = Node(
                id=node_id, name=name, agent_url=agent_url,
                token=token, enabled=1 if enabled else 0, created_at=now_iso(),
            )
            s.add(node)
        s.flush()
        return _node_to_dict(node, mask_token=False)


def delete_node(node_id: str) -> bool:
    with get_session() as s:
        result = s.execute(delete(Node).where(Node.id == node_id))
        return result.rowcount > 0


# ─── Métricas diarias ──────────────────────────────────────────────────────

def get_daily_metrics(user_id: int, days_limit: int = 30) -> list[dict[str, Any]]:
    with get_session() as s:
        rows = s.scalars(
            select(TokenUsageDaily)
            .where(TokenUsageDaily.user_id == user_id)
            .order_by(desc(TokenUsageDaily.usage_date))
            .limit(days_limit)
        ).all()
        return [
            {
                "usage_date": r.usage_date,
                "model": r.model,
                "prompt_tokens": r.prompt_tokens,
                "completion_tokens": r.completion_tokens,
                "total_tokens": r.total_tokens,
                "latency_sum_ms": r.latency_sum_ms,
                "request_count": r.request_count,
            }
            for r in rows
        ]
