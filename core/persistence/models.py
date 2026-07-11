"""
models.py — Modelos SQLAlchemy de lixbon (Postgres).
Los timestamps se guardan como TEXT ISO-8601 UTC (comparables lexicográficamente),
igual que el esquema legacy, para no cambiar la lógica de los routers en esta fase.
"""
from __future__ import annotations

from sqlalchemy import BigInteger, ForeignKey, Index, LargeBinary, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from core.persistence.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(Text, unique=True, nullable=False)  # legacy; nuevos usuarios: = email
    email: Mapped[str | None] = mapped_column(Text, unique=True)              # identificador de login (F3)
    first_name: Mapped[str | None] = mapped_column(Text)
    last_name: Mapped[str | None] = mapped_column(Text)
    role: Mapped[str] = mapped_column(Text, nullable=False, default="user")   # user | admin
    email_verified: Mapped[int] = mapped_column(nullable=False, default=0)
    is_active: Mapped[int] = mapped_column(nullable=False, default=1)         # 0 = bloqueado por admin (F6)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    # Preferencias del usuario (JSON parcial; los defaults viven en queries.SETTINGS_DEFAULTS)
    settings_json: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class Session(Base):
    """Sesión web (cookie). Separada de las API keys: revocable e independiente."""
    __tablename__ = "sessions"
    __table_args__ = (
        Index("idx_sessions_user", "user_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    token_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    expires_at: Mapped[str] = mapped_column(Text, nullable=False)
    ip_address: Mapped[str | None] = mapped_column(Text)
    user_agent: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class EmailToken(Base):
    """Tokens de un solo uso para verificación de email y reset de contraseña."""
    __tablename__ = "email_tokens"
    __table_args__ = (
        Index("idx_email_tokens_user", "user_id", "purpose"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    token_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    purpose: Mapped[str] = mapped_column(Text, nullable=False)  # verify_email | reset_password
    expires_at: Mapped[str] = mapped_column(Text, nullable=False)
    used: Mapped[int] = mapped_column(nullable=False, default=0)
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
    # F-compartir: token público de solo lectura (NULL = no compartida)
    share_token: Mapped[str | None] = mapped_column(Text, unique=True)
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


class Node(Base):
    """PC con GPU registrada en el cluster. Reemplaza al antiguo nodes.json."""
    __tablename__ = "nodes"

    id: Mapped[str] = mapped_column(Text, primary_key=True)          # slug: "gpu-01"
    name: Mapped[str] = mapped_column(Text, nullable=False)
    agent_url: Mapped[str] = mapped_column(Text, nullable=False)     # https://gpu-01.lixbon.com
    # Token que el gateway envía al node_agent (X-Node-Token). Credencial del gateway,
    # se guarda en claro porque el gateway necesita enviarla, como cualquier client secret.
    token: Mapped[str] = mapped_column(Text, nullable=False)
    enabled: Mapped[int] = mapped_column(nullable=False, default=1)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class Plan(Base):
    """Planes del producto (F5). Los límites viven AQUÍ, no en el código:
    ajustar un plan = UPDATE en esta tabla. -1 significa ilimitado."""
    __tablename__ = "plans"

    id: Mapped[str] = mapped_column(Text, primary_key=True)            # slug: free | pro | advance
    name: Mapped[str] = mapped_column(Text, nullable=False)            # Gratuito | Pro | Advance
    description: Mapped[str | None] = mapped_column(Text)
    price_monthly_cents: Mapped[int] = mapped_column(nullable=False, default=0)
    currency: Mapped[str] = mapped_column(Text, nullable=False, default="USD")
    messages_per_day: Mapped[int] = mapped_column(nullable=False, default=30)
    tokens_per_month: Mapped[int] = mapped_column(nullable=False, default=150_000)
    max_api_keys: Mapped[int] = mapped_column(nullable=False, default=1)
    rate_limit_per_min: Mapped[int] = mapped_column(nullable=False, default=10)
    # JSON con lista de prefijos de modelos permitidos; NULL = todos los modelos
    allowed_models: Mapped[str | None] = mapped_column(Text)
    priority: Mapped[int] = mapped_column(nullable=False, default=0)   # prioridad en cola (futuro)
    sort_order: Mapped[int] = mapped_column(nullable=False, default=0)
    is_active: Mapped[int] = mapped_column(nullable=False, default=1)
    # F7: id del precio recurrente en Stripe (price_...) que corresponde a este plan
    stripe_price_id: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


class Subscription(Base):
    """Suscripción vigente de un usuario (una por usuario; el historial queda
    en audit_events). El cobro real llega en F7 — por ahora asignación manual."""
    __tablename__ = "subscriptions"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_subscriptions_user"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    plan_id: Mapped[str] = mapped_column(ForeignKey("plans.id"), nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="active")
    started_at: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[str | None] = mapped_column(Text)               # NULL = sin vencimiento
    # F7: enlace con Stripe (NULL en asignaciones manuales por admin)
    stripe_customer_id: Mapped[str | None] = mapped_column(Text)
    stripe_subscription_id: Mapped[str | None] = mapped_column(Text)
    current_period_end: Mapped[str | None] = mapped_column(Text)       # ISO; fin del ciclo pagado
    cancel_at_period_end: Mapped[int] = mapped_column(nullable=False, default=0)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


class UsageQuota(Base):
    """Contadores de uso por período para enforcement (F5). Redis es el contador
    caliente; esta tabla es la persistencia y la semilla cuando Redis se reinicia."""
    __tablename__ = "usage_quotas"
    __table_args__ = (
        UniqueConstraint("user_id", "period_type", "period_start", name="uq_usage_quotas_period"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    period_type: Mapped[str] = mapped_column(Text, nullable=False)     # day | month
    period_start: Mapped[str] = mapped_column(Text, nullable=False)    # YYYY-MM-DD | YYYY-MM
    messages: Mapped[int] = mapped_column(nullable=False, default=0)
    tokens: Mapped[int] = mapped_column(nullable=False, default=0)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


class ModelPricing(Base):
    """Tarifas para el cobro por tokens de las API keys. Match por prefijo del
    id del modelo (longest-prefix); la fila '*' es la tarifa por defecto.
    Precios en micro-USD (1e-6 USD) por millón de tokens — aritmética entera."""
    __tablename__ = "model_pricing"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    model_prefix: Mapped[str] = mapped_column(Text, unique=True, nullable=False)  # "*" = default
    display_name: Mapped[str | None] = mapped_column(Text)
    input_microusd_per_mtok: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    output_microusd_per_mtok: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    is_active: Mapped[int] = mapped_column(nullable=False, default=1)
    sort_order: Mapped[int] = mapped_column(nullable=False, default=0)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


class CreditAccount(Base):
    """Saldo prepago de créditos de API por usuario, en micro-USD."""
    __tablename__ = "credit_accounts"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_credit_accounts_user"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    balance_microusd: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


class CreditLedger(Base):
    """Movimientos de créditos (compra, consumo, ajuste). Fuente de verdad del
    uso facturable de la API; stripe_ref único da idempotencia a los webhooks."""
    __tablename__ = "credit_ledger"
    __table_args__ = (
        Index("idx_credit_ledger_user", "user_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)  # purchase | usage | adjustment
    delta_microusd: Mapped[int] = mapped_column(BigInteger, nullable=False)
    balance_after: Mapped[int] = mapped_column(BigInteger, nullable=False)
    model: Mapped[str | None] = mapped_column(Text)
    prompt_tokens: Mapped[int] = mapped_column(nullable=False, default=0)
    completion_tokens: Mapped[int] = mapped_column(nullable=False, default=0)
    stripe_ref: Mapped[str | None] = mapped_column(Text, unique=True)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class CreditPack(Base):
    """Packs de recarga (Stripe Checkout de pago único). Crédito = precio;
    el margen del negocio va en la tarifa por tokens."""
    __tablename__ = "credit_packs"

    id: Mapped[str] = mapped_column(Text, primary_key=True)   # slug: starter | plus | power
    name: Mapped[str] = mapped_column(Text, nullable=False)
    credit_microusd: Mapped[int] = mapped_column(BigInteger, nullable=False)
    price_cents: Mapped[int] = mapped_column(nullable=False)
    currency: Mapped[str] = mapped_column(Text, nullable=False, default="USD")
    is_active: Mapped[int] = mapped_column(nullable=False, default=1)
    sort_order: Mapped[int] = mapped_column(nullable=False, default=0)
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
