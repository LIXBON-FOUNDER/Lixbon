"""Resúmenes de conversaciones compactadas (ver core/inference/compaction.py)."""
from __future__ import annotations

from typing import Any

from sqlalchemy import select

from core.persistence.database import get_session
from core.persistence.models import ConversationCompaction
from core.persistence.queries import now_iso


def get_compaction(conversation_id: str, user_id: int) -> dict[str, Any] | None:
    with get_session() as s:
        row = s.scalar(select(ConversationCompaction).where(
            ConversationCompaction.conversation_id == conversation_id,
            ConversationCompaction.user_id == user_id))
        if row is None:
            return None
        return {"summary": row.summary, "upto": row.upto, "digest": row.digest, "updated_at": row.updated_at}


def save_compaction(conversation_id: str, user_id: int, summary: str, upto: int, digest: str) -> None:
    with get_session() as s:
        row = s.get(ConversationCompaction, conversation_id)
        if row is None:
            row = ConversationCompaction(conversation_id=conversation_id, user_id=user_id)
            s.add(row)
        elif row.user_id != user_id:
            return  # nunca pisar la de otra cuenta
        row.summary, row.upto, row.digest, row.updated_at = summary, upto, digest, now_iso()
