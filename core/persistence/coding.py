"""Sesiones de Coding en la nube: el entorno (contenedor) de cada sesión.

La conversación vive en `remote_sessions`/`remote_events` (source="cloud");
aquí solo lo del entorno: repo, rama, estado, contenedor y el token acotado
que usa el CLI de dentro. Ese token se guarda hasheado, como las API keys.
"""
from __future__ import annotations

import os

import json
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import delete, func, select

from core.persistence.database import get_session
from core.persistence.models import CodingSandbox, RemoteEvent, RemoteSession, User
from core.persistence.queries import _user_to_dict, create_remote_session, hash_api_key, now_iso

TOKEN_PREFIX = "lixbon_ct_"
ESTADOS = ("creada", "preparando", "activa", "pausada", "error", "terminada")
# Las que ocupan un contenedor encendido: cuentan para el límite por usuario.
ESTADOS_ACTIVOS = ("preparando", "activa")
MODOS = ("auto", "manual", "ask", "plan")
CAMPOS = {"branch", "mode", "model", "container_id", "host_port", "estado", "error", "pr_url",
          "pending_prompt_json", "paused_at", "ended_at", "default_branch"}


def _a_dict(c: CodingSandbox) -> dict[str, Any]:
    return {
        "session_id": c.session_id,
        "user_id": c.user_id,
        "repo": c.repo,
        "default_branch": c.default_branch,
        "branch": c.branch,
        "mode": c.mode,
        "model": c.model,
        "container_id": c.container_id,
        "volume": c.volume,
        "host_port": c.host_port,
        "estado": c.estado,
        "error": c.error,
        "pr_url": c.pr_url,
        "pending_prompt": json.loads(c.pending_prompt_json) if c.pending_prompt_json else None,
        "created_at": c.created_at,
        "last_activity_at": c.last_activity_at,
        "paused_at": c.paused_at,
        "ended_at": c.ended_at,
    }


def publico(sb: dict[str, Any]) -> dict[str, Any]:
    """Lo que ve la web: sin contenedor, puerto ni volumen."""
    out = {k: sb.get(k) for k in ("session_id", "repo", "default_branch", "branch", "mode", "model",
                                   "estado", "error", "pr_url", "created_at", "last_activity_at")}
    # Mensajes que esperan a que el entorno esté listo: la web los pinta en el
    # hilo (solo el texto; los adjuntos van al host al arrancar).
    out["pendientes"] = [str(m.get("text") or "") for m in (sb.get("pending_prompt") or []) if isinstance(m, dict)]
    # Cuánto se conserva sin uso (pausada o con error) antes de borrarse:
    # la web enseña la fecha y ofrece fijarla para que dure más.
    out["conservar_dias"] = {"normal": float(os.getenv("CODING_BORRAR_DIAS", "7")),
                             "fijada": float(os.getenv("CODING_BORRAR_DIAS_FIJADAS", "30"))}
    return out


def crear(user_id: int, repo: str, default_branch: str, mode: str, model: str | None,
          titulo: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """Crea la sesión remota (source=cloud) y su entorno, sin contenedor todavía:
    el contenedor arranca con el primer mensaje."""
    if mode not in MODOS:
        raise ValueError("mode")
    _, sesion = create_remote_session(user_id, "cloud", titulo, "Nube", "lixbon", repo)
    try:
        with get_session() as s:
            # Sin host conectado todavía: la sesión no está "online".
            r = s.get(RemoteSession, sesion["id"])
            r.status = "offline"
            r.share_token_hash = None  # en la nube no hay link/QR que compartir
            c = CodingSandbox(
                session_id=sesion["id"], user_id=user_id, repo=repo, default_branch=default_branch,
                mode=mode, model=model, volume=f"lixbon-ws-{sesion['id']}", estado="creada",
                created_at=now_iso(), last_activity_at=now_iso(),
            )
            s.add(c)
            s.flush()
            sesion["status"] = "offline"
            return sesion, _a_dict(c)
    except Exception:
        # Sin su entorno la sesión quedaría huérfana en la barra (sin poder
        # gestionarla ni borrarla): se deshace entera.
        with get_session() as s:
            s.execute(delete(RemoteSession).where(RemoteSession.id == sesion["id"]))
        raise


def borrar_huerfana(session_id: str, user_id: int) -> bool:
    """Una sesión de la nube sin entorno (creación a medias de una versión
    anterior): se puede borrar igual desde la barra."""
    with get_session() as s:
        r = s.get(RemoteSession, session_id)
        if not r or r.user_id != user_id or r.source != "cloud" or s.get(CodingSandbox, session_id):
            return False
        s.execute(delete(RemoteEvent).where(RemoteEvent.session_id == session_id))
        s.delete(r)
        return True


def obtener(session_id: str, user_id: int | None = None) -> dict[str, Any] | None:
    with get_session() as s:
        c = s.get(CodingSandbox, session_id)
        if not c or (user_id is not None and c.user_id != user_id):
            return None
        return _a_dict(c)


def por_sesiones(session_ids: list[str]) -> dict[str, dict[str, Any]]:
    if not session_ids:
        return {}
    with get_session() as s:
        rows = s.scalars(select(CodingSandbox).where(CodingSandbox.session_id.in_(session_ids))).all()
        return {c.session_id: _a_dict(c) for c in rows}


def contar_activas(user_id: int) -> int:
    with get_session() as s:
        return s.scalar(select(func.count()).select_from(CodingSandbox).where(
            CodingSandbox.user_id == user_id, CodingSandbox.estado.in_(ESTADOS_ACTIVOS))) or 0


def actualizar(session_id: str, **campos: Any) -> dict[str, Any] | None:
    desconocidos = set(campos) - CAMPOS
    if desconocidos:
        raise ValueError(f"campos no válidos: {desconocidos}")
    if "estado" in campos and campos["estado"] not in ESTADOS:
        raise ValueError("estado")
    if "pending_prompt_json" in campos and isinstance(campos["pending_prompt_json"], (dict, list)):
        campos["pending_prompt_json"] = json.dumps(campos["pending_prompt_json"], ensure_ascii=False)
    with get_session() as s:
        c = s.get(CodingSandbox, session_id)
        if not c:
            return None
        for k, v in campos.items():
            setattr(c, k, v)
        c.last_activity_at = now_iso()
        return _a_dict(c)


def borrar(session_id: str, user_id: int) -> bool:
    """Borra la sesión de Coding y su transcript (el entorno ya debe estar parado)."""
    with get_session() as s:
        c = s.get(CodingSandbox, session_id)
        if not c or c.user_id != user_id:
            return False
        # Sin depender de ON DELETE CASCADE (SQLite no lo aplica sin PRAGMA).
        s.execute(delete(RemoteEvent).where(RemoteEvent.session_id == session_id))
        s.delete(c)
        r = s.get(RemoteSession, session_id)
        if r:
            s.delete(r)
        return True


def reclamar_estado(session_id: str, desde: tuple[str, ...], hacia: str) -> bool:
    """Cambio de estado atómico (solo uno de dos clics simultáneos arranca el contenedor)."""
    from sqlalchemy import update
    with get_session() as s:
        n = s.execute(update(CodingSandbox)
                      .where(CodingSandbox.session_id == session_id, CodingSandbox.estado.in_(desde))
                      .values(estado=hacia, last_activity_at=now_iso())).rowcount
        return n == 1


def tocar(session_id: str) -> None:
    with get_session() as s:
        c = s.get(CodingSandbox, session_id)
        if c and c.estado not in ("terminada",):
            c.last_activity_at = now_iso()


# ---------------------------------------------------------------- token acotado

def emitir_token(session_id: str) -> str:
    """Token nuevo para el contenedor; invalida el anterior (rotación al reanudar)."""
    raw = f"{TOKEN_PREFIX}{secrets.token_urlsafe(32)}"
    with get_session() as s:
        c = s.get(CodingSandbox, session_id)
        if not c:
            raise LookupError(session_id)
        c.token_hash = hash_api_key(raw)
    return raw


def revocar_token(session_id: str) -> None:
    with get_session() as s:
        c = s.get(CodingSandbox, session_id)
        if c:
            c.token_hash = None


def validar_token(raw: str) -> dict[str, Any] | None:
    """Usuario dueño del token con el alcance de la sesión, o None.

    Solo vale mientras el entorno esté vivo (no en pausada/terminada/error)."""
    if not raw or not raw.startswith(TOKEN_PREFIX):
        return None
    with get_session() as s:
        c = s.scalar(select(CodingSandbox).where(CodingSandbox.token_hash == hash_api_key(raw)))
        if not c or c.estado not in ESTADOS_ACTIVOS:
            return None
        user = s.get(User, c.user_id)
        if not user or not user.is_active:
            return None
        return {**_user_to_dict(user), "auth_via": "coding", "client": "coding",
                "session_id": f"coding:{c.session_id}", "coding_session_id": c.session_id}


# ---------------------------------------------------------------- ciclo de vida

def _hace(**delta: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(**delta)).isoformat()


def inactivas(minutos: float) -> list[dict[str, Any]]:
    """Entornos encendidos sin actividad en `minutos`: se pausan."""
    with get_session() as s:
        rows = s.scalars(select(CodingSandbox).where(
            CodingSandbox.estado.in_(ESTADOS_ACTIVOS), CodingSandbox.last_activity_at < _hace(minutes=minutos))).all()
        return [_a_dict(c) for c in rows]


def encendidas() -> list[dict[str, Any]]:
    """Todos los entornos que la base de datos da por encendidos."""
    with get_session() as s:
        rows = s.scalars(select(CodingSandbox).where(CodingSandbox.estado.in_(ESTADOS_ACTIVOS))).all()
        return [_a_dict(c) for c in rows]


def con_entorno(session_ids: list[str]) -> set[str]:
    """De estas sesiones, las que existen y no han terminado (su contenedor,
    red y volumen son legítimos)."""
    if not session_ids:
        return set()
    with get_session() as s:
        return set(s.scalars(select(CodingSandbox.session_id).where(
            CodingSandbox.session_id.in_(session_ids), CodingSandbox.estado != "terminada")).all())


def para_borrar(dias: float, dias_fijadas: float | None = None) -> list[dict[str, Any]]:
    """Pausados o con error desde hace `dias`: se borran contenedor y volumen.
    Las sesiones fijadas en la barra aguantan `dias_fijadas` (decisión del
    usuario, 2026-11-11: 30 días en vez de 7)."""
    if dias_fijadas is None:
        dias_fijadas = dias
    with get_session() as s:
        rows = s.execute(
            select(CodingSandbox, RemoteSession.pinned)
            .join(RemoteSession, RemoteSession.id == CodingSandbox.session_id, isouter=True)
            .where(CodingSandbox.estado.in_(("pausada", "error", "creada")),
                   CodingSandbox.last_activity_at < _hace(days=min(dias, dias_fijadas)))).all()
        limite, limite_fijadas = _hace(days=dias), _hace(days=dias_fijadas)
        return [_a_dict(c) for c, fijada in rows
                if c.last_activity_at < (limite_fijadas if fijada else limite)]
