"""env.py — Entorno de Alembic. Lee DATABASE_URL y usa los modelos de core.persistence."""
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from core.persistence.database import Base, _normalize_url
from core.persistence import models  # noqa: F401 — registra los modelos en Base.metadata
from core.config import DATABASE_URL

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL no está configurada; Alembic necesita la BD de staging o prod.")

config.set_main_option("sqlalchemy.url", _normalize_url(DATABASE_URL))

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
