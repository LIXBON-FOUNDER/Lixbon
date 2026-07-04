"""
reset_staging.py — Borra y recrea todas las tablas de la BD apuntada por DATABASE_URL.
SOLO para staging. Pide confirmación explícita y se niega si FOLAX_ENV=production.

Uso:  python BD/scripts/reset_staging.py
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from core.config import DATABASE_URL
from core.persistence.database import Base, get_engine
from core.persistence import models  # noqa: F401


def main() -> None:
    if os.getenv("FOLAX_ENV", "").lower() == "production":
        print("ABORTADO: FOLAX_ENV=production. Este script no toca producción.")
        sys.exit(1)
    if not DATABASE_URL:
        print("ABORTADO: DATABASE_URL no configurada.")
        sys.exit(1)

    host = DATABASE_URL.split("@")[-1].split("/")[0] if "@" in DATABASE_URL else "?"
    print(f"Vas a BORRAR TODAS las tablas de: {host}")
    answer = input("Escribe RESET para confirmar: ").strip()
    if answer != "RESET":
        print("Cancelado.")
        sys.exit(0)

    engine = get_engine()
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    print("Staging reiniciado: tablas recreadas vacías.")


if __name__ == "__main__":
    main()
