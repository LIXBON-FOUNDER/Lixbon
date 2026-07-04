"""
models.py — Modelos SQLAlchemy de FOLAX (Postgres).
Los timestamps se guardan como TEXT ISO-8601 UTC (comparables lexicográficamente),
igual que el esquema legacy, para no cambiar la lógica de los routers en esta fase.
"""
from __future__ import annotations

from sqlalchemy import ForeignKey, Index, LargeBinary, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from core.persistence.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class ApiKey(Base):
    __tablename__ = "api_keys"
    __table_args__ = (
        Index("idx_api_keys_user_active", "user_id", "is_active"),
        Index("idx_api_keys_composite", "user_id", "is_active", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    key_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    key_prefix: Mapped[str | None] = mapped_column(Text)
    # raw_key se elimina en F3 (rediseño de auth); se conserva por compatibilidad del login actual
    raw_key: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[int] = mapped_column(nullable=False, default=1)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="active")
    scopes: Mapped[str] = mapped_column(Text, nullable=False, default="read,write")
    model: Mapped[str | None] = mapped_column(Text)
    expires_at: Mapped[str | None] = mapped_column(Text)
    last_accessed: Mapped[str | None] = mapped_column(Text)
    last_used_ip: Mapped[str | None] = mapped_column(Text)
    deactivated_at: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class Conversation(Base):
    __tablename__ = "conversations"
    __table_args__ = (
        Index("idx_conversations_user", "user_id", "updated_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    title: Mapped[str | None] = mapped_column(Text)
    client_id: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        Index("idx_messages_conv", "conversation_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id"), nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    model: Mapped[str | None] = mapped_column(Text)
    prompt_tokens: Mapped[int] = mapped_column(nullable=False, default=0)
    completion_tokens: Mapped[int] = mapped_column(nullable=False, default=0)
    total_tokens: Mapped[int] = mapped_column(nullable=False, default=0)
    latency_ms: Mapped[int] = mapped_column(nullable=False, default=0)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    __table_args__ = (
        Index("idx_audit_user_type", "user_id", "event_type", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    user_id: Mapped[int | None] = mapped_column()
    key_id: Mapped[int | None] = mapped_column()
    ip_address: Mapped[str | None] = mapped_column(Text)
    user_agent: Mapped[str | None] = mapped_column(Text)
    metadata_json: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class TaskEmbedding(Base):
    __tablename__ = "task_embeddings"
    __table_args__ = (
        Index("idx_task_emb_user", "user_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    user_input: Mapped[str] = mapped_column(Text, nullable=False)
    intent: Mapped[str | None] = mapped_column(Text)
    complexity: Mapped[float | None] = mapped_column()
    domain: Mapped[str | None] = mapped_column(Text)
    risk_level: Mapped[str | None] = mapped_column(Text)
    router_used: Mapped[str | None] = mapped_column(Text)
    model_called: Mapped[str | None] = mapped_column(Text)
    response_summary: Mapped[str | None] = mapped_column(Text)
    success: Mapped[int] = mapped_column(nullable=False, default=1)
    embedding_blob: Mapped[bytes | None] = mapped_column(LargeBinary)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class AppVersion(Base):
    __tablename__ = "app_versions"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    version: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    channel: Mapped[str] = mapped_column(Text, nullable=False, default="stable")
    release_date: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    changelog_json: Mapped[str] = mapped_column(Text, nullable=False)
    download_url: Mapped[str] = mapped_column(Text, nullable=False)
    checksum_sha256: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class TokenUsageDaily(Base):
    __tablename__ = "token_usage_daily"
    __table_args__ = (
        UniqueConstraint("user_id", "usage_date", "model", name="uq_token_usage_daily"),
        Index("idx_token_usage_date", "usage_date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    usage_date: Mapped[str] = mapped_column(Text, nullable=False)
    model: Mapped[str] = mapped_column(Text, nullable=False)
    prompt_tokens: Mapped[int] = mapped_column(nullable=False, default=0)
    completion_tokens: Mapped[int] = mapped_column(nullable=False, default=0)
    total_tokens: Mapped[int] = mapped_column(nullable=False, default=0)
    latency_sum_ms: Mapped[int] = mapped_column(nullable=False, default=0)
    request_count: Mapped[int] = mapped_column(nullable=False, default=0)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
