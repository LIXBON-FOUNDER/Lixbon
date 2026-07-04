"""
database.py — Motor SQLAlchemy y sesiones para Postgres (Railway).
La única fuente de conexión es DATABASE_URL. No hay SQLite ni MySQL.
"""
from __future__ import annotations
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from core.config import DATABASE_URL


class Base(DeclarativeBase):
    pass


_engine: Engine | None = None
_SessionLocal: sessionmaker | None = None


def _normalize_url(url: str) -> str:
    """Railway entrega postgres:// o postgresql://; SQLAlchemy+psycopg3 necesita postgresql+psycopg://."""
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


def get_engine() -> Engine:
    """Crea el engine de forma perezosa (permite importar el paquete sin BD, p. ej. en builds)."""
    global _engine, _SessionLocal
    if _engine is None:
        if not DATABASE_URL:
            raise RuntimeError(
                "DATABASE_URL no está configurada. En desarrollo apunta a la BD de staging "
                "de Railway (folax-staging); en producción Railway la inyecta automáticamente."
            )
        _engine = create_engine(
            _normalize_url(DATABASE_URL),
            pool_pre_ping=True,   # descarta conexiones muertas (Railway cierra idles)
            pool_size=5,
            max_overflow=5,
        )
        _SessionLocal = sessionmaker(bind=_engine, expire_on_commit=False)
    return _engine


@contextmanager
def get_session() -> Session:
    """Context manager de sesión con commit/rollback automático."""
    get_engine()
    session: Session = _SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def init_db() -> None:
    """
    Crea las tablas que falten y aplica migraciones de columnas idempotentes.
    Se ejecuta en cada arranque (también en Railway), por eso todo usa IF NOT EXISTS.
    """
    from sqlalchemy import text

    from core.persistence import models  # noqa: F401 — registra los modelos en Base.metadata

    engine = get_engine()
    Base.metadata.create_all(engine)

    # ── Migraciones de columnas sobre tablas preexistentes (Postgres) ──
    _column_migrations = [
        # F3: login por email, nombres, roles y verificación
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER NOT NULL DEFAULT 0",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users (email)",
    ]
    with engine.begin() as conn:
        for stmt in _column_migrations:
            conn.execute(text(stmt))

    # ── Seed: promover admins definidos por entorno ──
    import os
    admin_emails = [e.strip().lower() for e in os.getenv("ADMIN_EMAILS", "").split(",") if e.strip()]
    if admin_emails:
        with engine.begin() as conn:
            for email in admin_emails:
                conn.execute(
                    text("UPDATE users SET role = 'admin' WHERE lower(email) = :email"),
                    {"email": email},
                )
