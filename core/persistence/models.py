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
    # Foto de perfil: key del objeto en R2 ("avatars/<token>.png"). El token es
    # impredecible, así que el GET público no necesita autenticación.
    avatar_key: Mapped[str | None] = mapped_column(Text)
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
    # Origen (web/ide/cli): historial independiente por superficie. NULL = legacy.
    source: Mapped[str | None] = mapped_column(Text)
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
    __table_args__ = (
        # Multi-producto: el desktop 0.9.1 y el Android 0.9.1 pueden convivir.
        UniqueConstraint("product", "version", name="uq_app_versions_product_version"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    # "desktop" (MSI de Tauri) o "android" (APK). El updater de Tauri y el CLI
    # solo miran desktop; la tarjeta de Android de /aplicaciones mira android.
    product: Mapped[str] = mapped_column(Text, nullable=False, default="desktop")
    version: Mapped[str] = mapped_column(Text, nullable=False)
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


class ModelRole(Base):
    """Override del mapa rol→modelo (chat/fim/vision/embed/route).

    Los defaults viven en core/config.py (MODEL_ROLE_*); esta tabla los pisa
    desde el panel admin. Global al gateway, no por usuario ni por nodo.
    Una fila por rol, sembrada con model=NULL (= usa el default o autodetecta).
    `unique` en role es imprescindible: el seed usa ON CONFLICT (role)."""
    __tablename__ = "model_roles"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    role: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    model: Mapped[str | None] = mapped_column(Text)        # NULL/'' = default de env
    keep_alive: Mapped[str | None] = mapped_column(Text)   # "30m" | "-1" | "0"; NULL = env
    num_ctx: Mapped[int | None] = mapped_column()          # NULL = lo decide el cliente
    is_active: Mapped[int] = mapped_column(nullable=False, default=1)
    notes: Mapped[str | None] = mapped_column(Text)
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


class RemoteSession(Base):
    """Sesión de control remoto (/remote): un IDE o CLI actuando de host y la
    app móvil / web como mando a distancia. Los metadatos viven aquí y el
    transcript en `remote_events`, para poder releerlo cuando la sesión acaba."""
    __tablename__ = "remote_sessions"
    __table_args__ = (
        Index("idx_remote_sessions_user", "user_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)          # uuid corto (12 hex)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)        # "cli" | "ide"
    title: Mapped[str] = mapped_column(Text, nullable=False)         # carpeta del workspace
    machine: Mapped[str | None] = mapped_column(Text)                # hostname del host
    status: Mapped[str] = mapped_column(Text, nullable=False, default="online")  # online|offline|ended
    # Token del link/QR: hasheado como las API keys; NULL = link revocado
    share_token_hash: Mapped[str | None] = mapped_column(Text, unique=True)
    token_expires_at: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    last_seen_at: Mapped[str] = mapped_column(Text, nullable=False)
    ended_at: Mapped[str | None] = mapped_column(Text)


class RemoteEvent(Base):
    """Transcript persistido de una sesión /remote.

    El RemoteHub solo relaya en memoria: al cerrar la sesión (o al reiniciar el
    gateway) la conversación se perdía entera. Aquí se guardan los eventos con
    valor de transcript —mensajes, herramientas, avisos—, no los deltas del
    streaming, para poder reabrir la sesión en modo lectura desde la app o la
    web mucho después de que el host se haya ido.
    """
    __tablename__ = "remote_events"
    __table_args__ = (
        Index("idx_remote_events_session", "session_id", "seq"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("remote_sessions.id", ondelete="CASCADE"), nullable=False)
    seq: Mapped[int] = mapped_column(nullable=False)     # el mismo que reparte el hub
    type: Mapped[str] = mapped_column(Text, nullable=False)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class DeviceToken(Base):
    """Push tokens de Expo por dispositivo (avisos de /remote con la app cerrada)."""
    __tablename__ = "device_tokens"
    __table_args__ = (
        UniqueConstraint("expo_push_token", name="uq_device_tokens_token"),
        Index("idx_device_tokens_user", "user_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    expo_push_token: Mapped[str] = mapped_column(Text, nullable=False)
    platform: Mapped[str | None] = mapped_column(Text)               # "android" | "ios"
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    last_seen_at: Mapped[str] = mapped_column(Text, nullable=False)


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


# ── Lixbon Team ────────────────────────────────────────────────────────────
# Contrato: docs/team-protocolo.md del repo del IDE. Los campos van en español
# y snake_case, como dice la sección 0; la única excepción es el objeto
# `usuario`, que sale de la tabla `users` con sus nombres de siempre
# (first_name, avatar_url…).


class TeamProyecto(Base):
    """Un proyecto ES un espacio: foto, miembros, canales, un repositorio de
    GitHub y un grupo de Linear. No hay un nivel por encima.

    De Linear y GitHub se guarda el IDENTIFICADOR, nunca una credencial: cada
    integrante consulta esos servicios con su propia llave personal, así que un
    `linear_team_id` en la BD no da acceso a nada por sí solo (sección 8)."""
    __tablename__ = "team_proyectos"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    nombre: Mapped[str] = mapped_column(Text, nullable=False)
    avatar_url: Mapped[str | None] = mapped_column(Text)
    lider_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    github_repo: Mapped[str | None] = mapped_column(Text)          # "owner/repo"
    linear_team_id: Mapped[str | None] = mapped_column(Text)
    linear_project_id: Mapped[str | None] = mapped_column(Text)
    creado_en: Mapped[str] = mapped_column(Text, nullable=False)


class TeamMiembro(Base):
    __tablename__ = "team_miembros"
    __table_args__ = (
        Index("idx_team_miembros_usuario", "usuario_id"),
    )

    proyecto_id: Mapped[str] = mapped_column(
        ForeignKey("team_proyectos.id", ondelete="CASCADE"), primary_key=True)
    usuario_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    rol: Mapped[str] = mapped_column(Text, nullable=False, default="integrante")  # lider|integrante
    desde: Mapped[str] = mapped_column(Text, nullable=False)


class TeamCanal(Base):
    """Público: lo ve todo el proyecto. Privado: solo team_canal_miembros.
    Directo: no pertenece a ningún proyecto y tiene exactamente dos miembros."""
    __tablename__ = "team_canales"
    __table_args__ = (
        Index("idx_team_canales_proyecto", "proyecto_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    proyecto_id: Mapped[str | None] = mapped_column(
        ForeignKey("team_proyectos.id", ondelete="CASCADE"))       # NULL en los directos
    nombre: Mapped[str] = mapped_column(Text, nullable=False, default="")  # sin almohadilla
    tipo: Mapped[str] = mapped_column(Text, nullable=False)        # publico|privado|directo
    tema: Mapped[str | None] = mapped_column(Text)
    creado_en: Mapped[str] = mapped_column(Text, nullable=False)


class TeamCanalMiembro(Base):
    """Solo se rellena en privados y directos; en los públicos la pertenencia
    se deduce de `team_miembros`."""
    __tablename__ = "team_canal_miembros"
    __table_args__ = (
        Index("idx_team_canal_miembros_usuario", "usuario_id"),
    )

    canal_id: Mapped[str] = mapped_column(
        ForeignKey("team_canales.id", ondelete="CASCADE"), primary_key=True)
    usuario_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)


class TeamMensaje(Base):
    """El índice (canal_id, seq) es lo que hace posible el replay de la regla 2,
    y el ÚNICO (canal_id, client_id) es lo que hace la idempotencia de la regla
    1 barata en vez de cara: reenviar tras una reconexión no duplica porque la
    BD no deja."""
    __tablename__ = "team_mensajes"
    __table_args__ = (
        UniqueConstraint("canal_id", "client_id", name="uq_team_mensajes_client"),
        UniqueConstraint("canal_id", "seq", name="uq_team_mensajes_seq"),
        Index("idx_team_mensajes_canal_seq", "canal_id", "seq"),
        Index("idx_team_mensajes_hilo", "canal_id", "responde_a", "seq"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    canal_id: Mapped[str] = mapped_column(
        ForeignKey("team_canales.id", ondelete="CASCADE"), nullable=False)
    seq: Mapped[int] = mapped_column(BigInteger, nullable=False)   # monotónico POR CANAL
    autor_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    texto: Mapped[str] = mapped_column(Text, nullable=False, default="")
    client_id: Mapped[str] = mapped_column(Text, nullable=False)
    creado_en: Mapped[str] = mapped_column(Text, nullable=False)
    editado_en: Mapped[str | None] = mapped_column(Text)
    responde_a: Mapped[str | None] = mapped_column(Text)           # id de la RAÍZ del hilo
    borrado_en: Mapped[str | None] = mapped_column(Text)           # lápida (regla 10)


class TeamAmistad(Base):
    __tablename__ = "team_amistades"
    __table_args__ = (
        UniqueConstraint("de_id", "a_id", name="uq_team_amistades"),
        Index("idx_team_amistades_a", "a_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    de_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    a_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    estado: Mapped[str] = mapped_column(Text, nullable=False, default="pendiente")  # pendiente|aceptada
    creado_en: Mapped[str] = mapped_column(Text, nullable=False)


class TeamAdjunto(Base):
    """Un adjunto pertenece a un CANAL, no a quien tenga su id (regla 5): el
    `canal_id` es lo que decide quién puede pedir una URL para él."""
    __tablename__ = "team_adjuntos"
    __table_args__ = (
        Index("idx_team_adjuntos_canal", "canal_id"),
        Index("idx_team_adjuntos_mensaje", "mensaje_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    canal_id: Mapped[str] = mapped_column(
        ForeignKey("team_canales.id", ondelete="CASCADE"), nullable=False)
    subido_por: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    mensaje_id: Mapped[str | None] = mapped_column(Text)           # NULL hasta que se manda
    tipo: Mapped[str] = mapped_column(Text, nullable=False)        # imagen|video|audio|archivo
    nombre: Mapped[str] = mapped_column(Text, nullable=False)
    mime: Mapped[str] = mapped_column(Text, nullable=False)
    bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    clave_r2: Mapped[str] = mapped_column(Text, nullable=False)
    ancho: Mapped[int | None] = mapped_column()
    alto: Mapped[int | None] = mapped_column()
    duracion_ms: Mapped[int | None] = mapped_column(BigInteger)
    creado_en: Mapped[str] = mapped_column(Text, nullable=False)


class IdeAuthToken(Base):
    """Token de un solo uso del canje del IDE (`/ide/connect` → `/exchange`).

    En la BD y no en memoria porque el gateway puede reiniciarse entre la ida al
    navegador y la vuelta al IDE, y porque un solo uso de verdad exige un DELETE
    atómico que dos réplicas respeten: en memoria, dos procesos canjearían el
    mismo token. Se guarda HASHEADO, como las API keys — quien lea la tabla no
    puede canjear nada."""
    __tablename__ = "ide_auth_tokens"
    __table_args__ = (
        Index("idx_ide_auth_tokens_exp", "expira_en"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    token_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    challenge: Mapped[str] = mapped_column(Text, nullable=False)   # base64url(SHA-256(verifier))
    redirect_uri: Mapped[str] = mapped_column(Text, nullable=False)
    expira_en: Mapped[str] = mapped_column(Text, nullable=False)
    creado_en: Mapped[str] = mapped_column(Text, nullable=False)
