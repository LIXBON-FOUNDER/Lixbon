"""
config.py — Configuración centralizada de FOLAX DTC
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

# ── Base de datos (Postgres — Railway staging/prod) ────────────────────────
# postgresql://user:pass@host:port/db  (Railway la provee; en local apunta a folax-staging)
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

# ── Identidad de la app ─────────────────────────────────────────────────────
APP_TITLE: str = "FOLAX DTC"
APP_VERSION: str = "2.4.0" # Actualizado a la versión del diseño del CLI
APP_DESCRIPTION: str = "Data & Task Center — Distributed LLM Gateway"

# ── Rutas del proyecto ──────────────────────────────────────────────────────
PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent  # core/config.py → raíz del monorepo
CLI_SOURCE_PATH: Path = PROJECT_ROOT / "apps" / "cli" / "client_cli.py"
WEB_DIST_DIR: Path = PROJECT_ROOT / "apps" / "web" / "dist"
LOGS_DIR: Path = PROJECT_ROOT / "logs"

# ── Seguridad de claves ─────────────────────────────────────────────────────
KEY_EXPIRY_DAYS: int = int(os.getenv("KEY_EXPIRY_DAYS", "90"))
SESSION_EXPIRY_HOURS: int = int(os.getenv("SESSION_EXPIRY_HOURS", "24"))
