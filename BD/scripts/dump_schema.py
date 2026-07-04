"""
dump_schema.py — Genera BD/schema.sql desde los modelos SQLAlchemy (sin conectarse a nada).
Uso:  python BD/scripts/dump_schema.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import create_mock_engine
from sqlalchemy.schema import CreateIndex, CreateTable

from core.persistence.database import Base
from core.persistence import models  # noqa: F401

OUT = Path(__file__).resolve().parents[1] / "schema.sql"


def main() -> None:
    statements: list[str] = [
        "-- FOLAX — Esquema de referencia (generado desde core/persistence/models.py)",
        "-- NO editar a mano: regenerar con `python BD/scripts/dump_schema.py`",
        "",
    ]
    engine = create_mock_engine("postgresql+psycopg://", lambda sql, *a, **kw: None)
    for table in Base.metadata.sorted_tables:
        statements.append(str(CreateTable(table).compile(engine)).strip() + ";")
        for index in table.indexes:
            statements.append(str(CreateIndex(index).compile(engine)).strip() + ";")
        statements.append("")

    OUT.write_text("\n".join(statements), encoding="utf-8")
    print(f"Esquema escrito en {OUT}")


if __name__ == "__main__":
    main()
