"""
migrate_legacy.py — Migración one-shot de la BD SQLite legacy (BD/legacy/data.db)
a Postgres (la BD que indique DATABASE_URL — normalmente folax-staging primero).

Uso:
  1. Asegúrate de que DATABASE_URL apunta a la BD destino (staging para probar).
  2. python BD/scripts/migrate_legacy.py
  3. Verifica los conteos que imprime; si todo cuadra, repite apuntando a prod.

Es idempotente por clave natural donde se puede (username, version); si un registro
ya existe se omite.
"""
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import select

from core.persistence.database import get_session, init_db
from core.persistence.models import (
    ApiKey, AppVersion, AuditEvent, Conversation, Message, TaskEmbedding, TokenUsageDaily, User,
)

LEGACY_DB = Path(__file__).resolve().parents[1] / "legacy" / "data.db"


def main() -> None:
    if not LEGACY_DB.exists():
        print(f"No existe {LEGACY_DB}; nada que migrar.")
        return

    init_db()
    src = sqlite3.connect(LEGACY_DB)
    src.row_factory = sqlite3.Row

    counts = {}

    with get_session() as s:
        # ── Usuarios (mapea id viejo → id nuevo) ──
        id_map: dict[int, int] = {}
        for row in src.execute("SELECT * FROM users"):
            existing = s.scalar(select(User).where(User.username == row["username"]))
            if existing:
                id_map[row["id"]] = existing.id
                continue
            u = User(username=row["username"], password_hash=row["password_hash"], created_at=row["created_at"])
            s.add(u)
            s.flush()
            id_map[row["id"]] = u.id
        counts["users"] = len(id_map)

        # ── API keys ──
        n = 0
        for row in src.execute("SELECT * FROM api_keys"):
            if row["user_id"] not in id_map:
                continue
            if s.scalar(select(ApiKey).where(ApiKey.key_hash == row["key_hash"])):
                continue
            s.add(ApiKey(
                user_id=id_map[row["user_id"]], name=row["name"], key_hash=row["key_hash"],
                key_prefix=row["key_prefix"], raw_key=row["raw_key"],
                is_active=row["is_active"], status=row["status"] or "active",
                scopes=row["scopes"] or "read,write", model=row["model"],
                expires_at=row["expires_at"], last_accessed=row["last_accessed"],
                last_used_ip=row["last_used_ip"], deactivated_at=row["deactivated_at"],
                created_at=row["created_at"],
            ))
            n += 1
        counts["api_keys"] = n

        # ── Conversaciones y mensajes ──
        n = 0
        for row in src.execute("SELECT * FROM conversations"):
            if row["user_id"] not in id_map or s.get(Conversation, row["id"]):
                continue
            s.add(Conversation(
                id=row["id"], user_id=id_map[row["user_id"]], title=row["title"],
                client_id=row["client_id"], created_at=row["created_at"], updated_at=row["updated_at"],
            ))
            n += 1
        counts["conversations"] = n
        s.flush()

        conv_ids = {c for (c,) in s.execute(select(Conversation.id)).all()}
        n = 0
        for row in src.execute("SELECT * FROM messages"):
            if row["conversation_id"] not in conv_ids:
                continue
            s.add(Message(
                conversation_id=row["conversation_id"], role=row["role"], content=row["content"],
                model=row["model"], prompt_tokens=row["prompt_tokens"],
                completion_tokens=row["completion_tokens"], total_tokens=row["total_tokens"],
                latency_ms=row["latency_ms"], created_at=row["created_at"],
            ))
            n += 1
        counts["messages"] = n

        # ── Audit, embeddings, versiones, métricas ──
        n = 0
        for row in src.execute("SELECT * FROM audit_events"):
            s.add(AuditEvent(
                event_type=row["event_type"], user_id=id_map.get(row["user_id"]),
                key_id=row["key_id"], ip_address=row["ip_address"], user_agent=row["user_agent"],
                metadata_json=row["metadata_json"], created_at=row["created_at"],
            ))
            n += 1
        counts["audit_events"] = n

        n = 0
        for row in src.execute("SELECT * FROM task_embeddings"):
            if row["user_id"] not in id_map:
                continue
            s.add(TaskEmbedding(
                user_id=id_map[row["user_id"]], user_input=row["user_input"], intent=row["intent"],
                complexity=row["complexity"], domain=row["domain"], risk_level=row["risk_level"],
                router_used=row["router_used"], model_called=row["model_called"],
                response_summary=row["response_summary"], success=row["success"],
                embedding_blob=row["embedding_blob"], created_at=row["created_at"],
            ))
            n += 1
        counts["task_embeddings"] = n

        n = 0
        for row in src.execute("SELECT * FROM app_versions"):
            if s.scalar(select(AppVersion).where(AppVersion.version == row["version"])):
                continue
            s.add(AppVersion(
                version=row["version"], channel=row["channel"], release_date=row["release_date"],
                title=row["title"], changelog_json=row["changelog_json"],
                download_url=row["download_url"], checksum_sha256=row["checksum_sha256"],
                created_at=row["created_at"],
            ))
            n += 1
        counts["app_versions"] = n

        n = 0
        for row in src.execute("SELECT * FROM token_usage_daily"):
            if row["user_id"] not in id_map:
                continue
            s.add(TokenUsageDaily(
                user_id=id_map[row["user_id"]], usage_date=row["usage_date"], model=row["model"],
                prompt_tokens=row["prompt_tokens"], completion_tokens=row["completion_tokens"],
                total_tokens=row["total_tokens"], latency_sum_ms=row["latency_sum_ms"],
                request_count=row["request_count"], created_at=row["created_at"],
            ))
            n += 1
        counts["token_usage_daily"] = n

    src.close()
    print("Migración completada:")
    for table, count in counts.items():
        print(f"  {table}: {count} registros migrados")


if __name__ == "__main__":
    main()
