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
    Message,
    Node,
    TaskEmbedding,
    TokenUsageDaily,
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

def create_user(username: str, password: str) -> dict[str, Any] | None:
    try:
        with get_session() as s:
            user = User(
                username=username,
                password_hash=hash_password(password),
                created_at=now_iso(),
            )
            s.add(user)
            s.flush()
            return {"id": user.id, "username": user.username}
    except IntegrityError:
        return None


def verify_user(username: str, password: str) -> dict[str, Any] | None:
    """Verifica credenciales. Migra hashes legacy SHA-256 → scrypt al validar."""
    with get_session() as s:
        user = s.scalar(select(User).where(User.username == username))
        if not user:
            return None
        if not _verify_password_internal(password, user.password_hash):
            return None
        if not user.password_hash.startswith("scrypt$"):
            user.password_hash = hash_password(password)
        return {"id": user.id, "username": user.username}


def get_user_by_id(user_id: int) -> dict[str, Any] | None:
    with get_session() as s:
        user = s.get(User, user_id)
        return {"id": user.id, "username": user.username} if user else None


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
            "raw_key": row.raw_key,
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
    raw_key = f"lan_{secrets.token_urlsafe(24)}"
    created_at = now_iso()
    expires_at = _key_expires_at()
    with get_session() as s:
        key = ApiKey(
            user_id=user_id,
            name=name,
            key_hash=hash_api_key(raw_key),
            raw_key=raw_key,
            key_prefix=raw_key[:12],
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


def deactivate_key(key_id: int) -> bool:
    with get_session() as s:
        s.execute(
            update(ApiKey)
            .where(ApiKey.id == key_id)
            .values(is_active=0, status="inactive", deactivated_at=now_iso())
        )
    return True


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
            raw = row.raw_key or ""
            prefix = row.key_prefix or (raw[:12] if raw else "lan_")
            suffix = row.key_hash[-6:] if row.key_hash else "??????"
            result.append({
                "id": row.id,
                "name": row.name,
                "model": row.model,
                "scopes": (row.scopes or "read,write").split(","),
                "status": row.status or ("active" if row.is_active else "inactive"),
                "is_active": bool(row.is_active),
                "masked_key": f"{prefix}...{suffix}",
                "raw_key": raw,
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
        if not user:
            return None
        result = {"id": user.id, "username": user.username, "key_model": row.model}
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


def list_audit_events(user_id: int | None = None, limit: int = 50) -> list[dict[str, Any]]:
    with get_session() as s:
        stmt = select(AuditEvent).order_by(desc(AuditEvent.created_at)).limit(limit)
        if user_id is not None:
            stmt = stmt.where(AuditEvent.user_id == user_id)
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


# ─── Conversaciones y mensajes ─────────────────────────────────────────────

def ensure_conversation(
    conversation_id: str, user_id: int, title: str | None, client_id: str | None
) -> None:
    ts = now_iso()
    with get_session() as s:
        conv = s.get(Conversation, conversation_id)
        if conv:
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
