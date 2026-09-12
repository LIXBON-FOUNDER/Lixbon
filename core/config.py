"""
config.py — Configuración centralizada de lixbon DTC
Carga variables de entorno y soporta archivo .env opcional sin dependencias externas.
"""
from __future__ import annotations
import os
from pathlib import Path
from typing import Optional

# ── Carga de .env (sin dependencias externas) ──────────────────────────────
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"
if _ENV_FILE.exists():
    for _line in _ENV_FILE.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _key, _, _val = _line.partition("=")
            _key = _key.strip()
            _val = _val.strip().strip('"').strip("'")
            if _key:
                os.environ.setdefault(_key, _val)

# ── Variables principales ───────────────────────────────────────────────────
OLLAMA_BASE_URL: str = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
ALLOWED_ORIGINS: str = os.getenv("ALLOWED_ORIGINS", "*")
RATE_LIMIT_PER_MIN: int = int(os.getenv("RATE_LIMIT_PER_MIN", "120"))
AUTH_RATE_LIMIT: int = int(os.getenv("AUTH_RATE_LIMIT", "5"))
AUTH_BLOCK_MINUTES: int = int(os.getenv("AUTH_BLOCK_MINUTES", "15"))
ADMIN_TOKEN: Optional[str] = os.getenv("ADMIN_TOKEN") or None

# ── Roles de inferencia (mapa rol→modelo) ──────────────────────────────────
# La app tiene cinco roles con requisitos incompatibles (ver
# docs/CUELLO_DE_BOTELLA_MODELOS.md). Estos son los DEFAULTS; la tabla
# `model_roles` los sobreescribe desde el panel admin, y si un rol queda vacío
# el gateway lo autodetecta por la capability real que declara Ollama.
# Vacío ⇒ autodetectar. MODEL_ROLE_FIM va vacío a propósito: ningún modelo de
# chat sirve para autocompletar, hace falta uno con capability `insert`.
MODEL_ROLE_CHAT: str = os.getenv("MODEL_ROLE_CHAT", "deepseek-r1:8b")
# Razonamiento previo en el chat con modelos thinking (qwen3, deepseek-r1…):
# "auto" (default) lo decide el modelo, "1" lo fuerza, "0" lo apaga. Por
# petición se puede forzar con `think`. Ojo: el razonamiento consume ventana
# de contexto; con num_ctx 4096 y conversaciones largas el modelo se queda sin
# sitio para responder (ver MODEL_NUM_CTX).
_think = os.getenv("CHAT_THINK", "auto").strip().lower()
CHAT_THINK: bool | None = None if _think in ("", "auto") else _think in ("1", "true", "yes", "on")

# Ventana de contexto (num_ctx) para TODOS los roles y nodos. Ollama usa 4096
# si no se le dice nada. "max" = la máxima que declara cada modelo (cuidado:
# qwen3.5 declara 262144 y la caché KV no cabe en una GPU pequeña); un número
# = ese valor, recortado a la máxima del modelo. Vacío = default de Ollama.
# El num_ctx de un rol en el panel (tabla model_roles) tiene prioridad.
MODEL_NUM_CTX: str = os.getenv("MODEL_NUM_CTX", "").strip().lower()
MODEL_ROLE_FIM: str = os.getenv("MODEL_ROLE_FIM", "")
MODEL_ROLE_VISION: str = os.getenv("MODEL_ROLE_VISION", "moondream")
MODEL_ROLE_EMBED: str = os.getenv("MODEL_ROLE_EMBED", "nomic-embed-text")
MODEL_ROLE_ROUTE: str = os.getenv("MODEL_ROLE_ROUTE", "")

# Residencia en VRAM por rol (`keep_alive` de Ollama: campo TOP-LEVEL del
# payload, NO va dentro de `options`). "30m" | "-1" permanente | "0" descarga ya
# | "" no enviar nada. OJO: no confundir con KEEPALIVE_SECONDS de
# core/inference/ollama.py, que es el heartbeat SSE hacia el cliente.
# Dimensionado para UN solo modelo grande residente (RTX 3050, 6 GB): con
# deepseek-r1:8b ocupando 5.2 GB, `-1` en chat pinnearía casi toda la GPU.
MODEL_KEEPALIVE_CHAT: str = os.getenv("MODEL_KEEPALIVE_CHAT", "30m")
MODEL_KEEPALIVE_FIM: str = os.getenv("MODEL_KEEPALIVE_FIM", "10m")
MODEL_KEEPALIVE_VISION: str = os.getenv("MODEL_KEEPALIVE_VISION", "60s")
MODEL_KEEPALIVE_EMBED: str = os.getenv("MODEL_KEEPALIVE_EMBED", "-1")  # 0.3 GB: residente
MODEL_KEEPALIVE_ROUTE: str = os.getenv("MODEL_KEEPALIVE_ROUTE", "5m")

# Segundos de caché de la tabla `model_roles` (el panel invalida al editar).
MODEL_ROLES_TTL_S: int = int(os.getenv("MODEL_ROLES_TTL_S", "60"))
# Segundos de caché del catálogo de modelos. Protege /api/tags de /api/fim,
# que dispara una petición por pulsación de tecla.
MODELS_CACHE_TTL_S: int = int(os.getenv("MODELS_CACHE_TTL_S", "10"))

# ── Base de datos (Postgres — Railway staging/prod) ────────────────────────
# postgresql://user:pass@host:port/db  (Railway la provee; en local apunta a lixbon-staging)
DATABASE_URL: str = os.getenv("DATABASE_URL", "")

# ── Redis (rate limiting, sesiones) ─────────────────────────────────────────
REDIS_URL: str = os.getenv("REDIS_URL", "")

# ── Cloudflare R2 (releases privados — F6.5) ───────────────────────────────
# Bucket privado; el gateway sube y genera URLs prefirmadas al vuelo.
R2_ACCOUNT_ID: str = os.getenv("R2_ACCOUNT_ID", "")
R2_BUCKET: str = os.getenv("R2_BUCKET", "")
R2_ACCESS_KEY_ID: str = os.getenv("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY: str = os.getenv("R2_SECRET_ACCESS_KEY", "")
# Minutos de validez de las URLs de descarga prefirmadas
R2_PRESIGN_TTL_MIN: int = int(os.getenv("R2_PRESIGN_TTL_MIN", "60"))


def r2_configured() -> bool:
    return bool(R2_ACCOUNT_ID and R2_BUCKET and R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY)


def r2_endpoint() -> str:
    return f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com"


# ── Stripe (pagos — F7) ────────────────────────────────────────────────────
STRIPE_SECRET_KEY: str = os.getenv("STRIPE_SECRET_KEY", "")
STRIPE_PUBLISHABLE_KEY: str = os.getenv("STRIPE_PUBLISHABLE_KEY", "")
STRIPE_WEBHOOK_SECRET: str = os.getenv("STRIPE_WEBHOOK_SECRET", "")
# URL base pública para las páginas de retorno del checkout (success/cancel)
PUBLIC_BASE_URL: str = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")


def stripe_configured() -> bool:
    return bool(STRIPE_SECRET_KEY)

# ── Identidad de la app ─────────────────────────────────────────────────────
APP_TITLE: str = "lixbon DTC"
APP_VERSION: str = "2.4.0" # Actualizado a la versión del diseño del CLI
APP_DESCRIPTION: str = "Data & Task Center — Distributed LLM Gateway"

# ── Rutas del proyecto ──────────────────────────────────────────────────────
PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent  # core/config.py → raíz del monorepo
CLI_SOURCE_PATH: Path = PROJECT_ROOT / "apps" / "cli" / "client_cli.py"
WEB_DIST_DIR: Path = PROJECT_ROOT / "apps" / "web" / "dist"
LOGS_DIR: Path = PROJECT_ROOT / "logs"

# ── Verificación de correo ──────────────────────────────────────────────────
# "1" = una cuenta con el correo sin verificar puede entrar y ver su cuenta,
# pero no usar el servicio. Por defecto "0": encenderlo con el correo mal
# configurado dejaría fuera a todo el mundo a la vez y sin salida, porque la
# única forma de desbloquearse es recibir un correo.
REQUIRE_EMAIL_VERIFICATION: bool = os.getenv("REQUIRE_EMAIL_VERIFICATION", "0") == "1"

# ── Seguridad de claves ─────────────────────────────────────────────────────
KEY_EXPIRY_DAYS: int = int(os.getenv("KEY_EXPIRY_DAYS", "90"))
SESSION_EXPIRY_HOURS: int = int(os.getenv("SESSION_EXPIRY_HOURS", "24"))
