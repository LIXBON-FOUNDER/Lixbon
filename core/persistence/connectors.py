"""
Cuentas externas conectadas por cada usuario y acciones del agente que esperan
confirmación. Los tokens entran y salen de aquí ya cifrados: este módulo no ve
nunca un token en claro (lo cifra/descifra core/connectors).
"""
from __future__ import annotations

import json
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import delete, select

from core.persistence.database import get_session
from core.persistence.models import ConnectorPendingAction, UserConnector
from core.persistence.queries import now_iso

PENDING_TTL_HOURS = 24


def _to_dict(c: UserConnector) -> dict[str, Any]:
    return {
        "id": c.id,
        "user_id": c.user_id,
        "provider": c.provider,
        "account_id": c.account_id,
        "account_login": c.account_login,
        "account_avatar": c.account_avatar,
        "access_token_enc": c.access_token_enc,
        "refresh_token_enc": c.refresh_token_enc,
        "access_expires_at": c.access_expires_at,
        "refresh_expires_at": c.refresh_expires_at,
        "created_at": c.created_at,
        "updated_at": c.updated_at,
    }


def get_connector(user_id: int, provider: str) -> dict[str, Any] | None:
    with get_session() as s:
        row = s.scalar(select(UserConnector).where(
            UserConnector.user_id == user_id, UserConnector.provider == provider))
        return _to_dict(row) if row else None


def upsert_connector(user_id: int, provider: str, **fields: Any) -> dict[str, Any]:
    """Crea o reemplaza la conexión. Reconectar con otra cuenta del proveedor
    sustituye la anterior: hay una sola por usuario y proveedor."""
    now = now_iso()
    with get_session() as s:
        row = s.scalar(select(UserConnector).where(
            UserConnector.user_id == user_id, UserConnector.provider == provider))
        if row is None:
            row = UserConnector(user_id=user_id, provider=provider, created_at=now, updated_at=now,
                                access_token_enc=fields.pop("access_token_enc"))
            s.add(row)
        for k, v in fields.items():
            setattr(row, k, v)
        row.updated_at = now
        s.flush()
        return _to_dict(row)


def update_tokens(connector_id: int, **fields: Any) -> None:
    with get_session() as s:
        row = s.get(UserConnector, connector_id)
        if row is None:
            return
        for k, v in fields.items():
            setattr(row, k, v)
        row.updated_at = now_iso()


def delete_connector(user_id: int, provider: str) -> bool:
    with get_session() as s:
        res = s.execute(delete(UserConnector).where(
            UserConnector.user_id == user_id, UserConnector.provider == provider))
        s.execute(delete(ConnectorPendingAction).where(
            ConnectorPendingAction.user_id == user_id, ConnectorPendingAction.provider == provider))
        return (res.rowcount or 0) > 0


# ── Acciones pendientes (modo manual) ─────────────────────────────────────────

def create_pending_action(user_id: int, provider: str, conversation_id: str | None,
                          context: dict[str, Any], transcript: list[dict], calls: list[dict]) -> str:
    action_id = secrets.token_urlsafe(18)
    now = datetime.now(timezone.utc)
    with get_session() as s:
        # Una sola pendiente por conversación: si el usuario no respondió a la
        # anterior y volvió a escribir, esa ya no tiene sentido.
        if conversation_id:
            s.execute(delete(ConnectorPendingAction).where(
                ConnectorPendingAction.user_id == user_id,
                ConnectorPendingAction.conversation_id == conversation_id))
        s.execute(delete(ConnectorPendingAction).where(ConnectorPendingAction.expires_at < now.isoformat()))
        s.add(ConnectorPendingAction(
            id=action_id, user_id=user_id, conversation_id=conversation_id, provider=provider,
            context_json=json.dumps(context, ensure_ascii=False),
            transcript_json=json.dumps(transcript, ensure_ascii=False),
            calls_json=json.dumps(calls, ensure_ascii=False),
            created_at=now.isoformat(),
            expires_at=(now + timedelta(hours=PENDING_TTL_HOURS)).isoformat(),
        ))
    return action_id


def take_pending_action(action_id: str, user_id: int) -> dict[str, Any] | None:
    """La lee y la borra en la misma transacción: una confirmación no se puede
    aplicar dos veces (doble clic, dos pestañas)."""
    with get_session() as s:
        row = s.scalar(select(ConnectorPendingAction).where(
            ConnectorPendingAction.id == action_id,
            ConnectorPendingAction.user_id == user_id).with_for_update())
        if row is None:
            return None
        data = {
            "id": row.id,
            "conversation_id": row.conversation_id,
            "provider": row.provider,
            "context": json.loads(row.context_json),
            "transcript": json.loads(row.transcript_json),
            "calls": json.loads(row.calls_json),
            "expired": row.expires_at < now_iso(),
        }
        s.delete(row)
    return None if data["expired"] else data


def discard_pending_for_conversation(user_id: int, conversation_id: str) -> None:
    with get_session() as s:
        s.execute(delete(ConnectorPendingAction).where(
            ConnectorPendingAction.user_id == user_id,
            ConnectorPendingAction.conversation_id == conversation_id))
