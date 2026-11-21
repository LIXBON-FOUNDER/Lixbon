"""Coding: sesiones en la nube (/api/coding/*).

Una sesión de Coding es una sesión /remote (source="cloud") cuyo host es
`lixbon host` corriendo en un contenedor aislado (core/sandbox). Este router
crea la sesión, arranca/pausa/borra su entorno, entrega el primer mensaje al
host cuando ha clonado, hace de proxy git y de vista previa, y abre el PR.

Autenticación:
- La web: sesión del dueño (cookie). Una sesión ajena responde 404.
- El contenedor: su token `lixbon_ct_…`, que solo vale para /host y /git de SU
  sesión (core/sandbox/alcance.py).
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
from typing import Any

import httpx
from urllib.parse import quote
from fastapi import APIRouter, Cookie, Header, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from core.billing.quota import ensure_can_use_coding
from core.connectors import github as gh
from core.gateway.remote_hub import hub
from core.gateway.routers import remote as remote_router
from core.persistence import coding as store
from core.persistence.queries import (
    get_plan_for_user, log_audit_event, rename_remote_session, update_remote_session_meta,
)
from core.sandbox import ciclo
from core.sandbox.git_proxy import MAX_PUSH, PushRechazado, ruta_github, validar_push
from core.sandbox.runner import SandboxError, runner
from core.security.auth import authenticate, session_required

router = APIRouter()
log = logging.getLogger("lixbon.coding")
# Nombre de rama de git razonable para la base (sin espacios ni «..»).
_RAMA_BASE = re.compile(r"^[A-Za-z0-9._/-]{1,200}$")

_REPO = re.compile(r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$")
_RAMA = re.compile(r"^lixbon/[A-Za-z0-9._/-]{1,80}$")
MAX_PENDIENTES = 5
MAX_PREVIEW_BODY = 10 * 1024 * 1024


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _usuario(lixbon_session: str | None, authorization: str | None) -> dict[str, Any]:
    return session_required(lixbon_session, authorization)


async def _modelos_validos(user: dict[str, Any]) -> set[str]:
    """Los ids que /v1/models le enseña a este usuario. Vacío = no se sabe
    (ningún nodo responde ahora): no se bloquea el cambio por eso."""
    from core.gateway.utils import fetch_models
    from core.inference.aliases import public_catalog
    try:
        catalogo = [e for e in await fetch_models()
                    if isinstance(e, dict) and not str(e.get("id", "")).startswith("error:")]
        publico = await asyncio.to_thread(public_catalog, catalogo, user.get("role") == "admin")
    except Exception as exc:  # noqa: BLE001 — sin catálogo no se valida
        log.warning("[coding] no se pudo leer el catálogo de modelos: %s", exc)
        return set()
    return {str(e["id"]) for e in publico if isinstance(e, dict) and e.get("id")}


async def _validar_modelo(model: Any, user: dict[str, Any]) -> str | None:
    if model is None:
        return None
    if not isinstance(model, str) or not 0 < len(model.strip()) <= 200:
        raise _error(422, "model_invalid", "Modelo no válido")
    model = model.strip()
    validos = await _modelos_validos(user)
    if validos and model not in validos:
        raise _error(422, "model_unknown", "Ese modelo no está disponible ahora")
    return model


async def _propia(session_id: str, user: dict[str, Any]) -> dict[str, Any]:
    sb = await asyncio.to_thread(store.obtener, session_id, user["id"])
    if not sb:
        raise _error(404, "not_found", "Sesión no encontrada")
    return sb


def _contenedor(session_id: str, authorization: str | None) -> dict[str, Any]:
    """El host del contenedor, autenticado con el token de ESTA sesión."""
    user = authenticate(None, authorization, rate_limit=False)
    if user.get("coding_session_id") != session_id:
        raise _error(404, "not_found", "Sesión no encontrada")
    sb = store.obtener(session_id, user["id"])
    if not sb:
        raise _error(404, "not_found", "Sesión no encontrada")
    return sb


# ------------------------------------------------------------------ estado y alta

@router.get("/api/coding/estado")
async def estado(lixbon_session: str | None = Cookie(default=None), authorization: str | None = Header(default=None)):
    user = _usuario(lixbon_session, authorization)
    plan = await asyncio.to_thread(get_plan_for_user, user["id"])
    try:
        ensure_can_use_coding(user, plan)
        plan_ok = True
    except HTTPException:
        plan_ok = False
    github = False
    if gh.configurado():
        try:
            await gh.token_de(user["id"])
            github = True
        except gh.GitHubError:
            github = False
    return {
        "disponible": await asyncio.to_thread(runner().disponible),
        "plan_ok": plan_ok,
        "github": github,
        "activas": await asyncio.to_thread(store.contar_activas, user["id"]),
        "max_activas": ciclo.MAX_ACTIVAS,
    }


@router.post("/api/coding/sessions", status_code=201)
async def crear_sesion(payload: dict[str, Any], request: Request,
                       lixbon_session: str | None = Cookie(default=None),
                       authorization: str | None = Header(default=None)):
    user = _usuario(lixbon_session, authorization)
    plan = await asyncio.to_thread(get_plan_for_user, user["id"])
    ensure_can_use_coding(user, plan)
    repo = str(payload.get("repo") or "").strip()
    mode = payload.get("mode") or "manual"
    model = payload.get("model")
    if not _REPO.match(repo):
        raise _error(422, "repo_invalid", "Elige un repositorio")
    if mode not in store.MODOS:
        raise _error(422, "mode_invalid", "Modo no válido")
    model = await _validar_modelo(model, user)
    base = payload.get("base")
    if base is not None and (not isinstance(base, str) or not _RAMA_BASE.match(base) or ".." in base):
        raise _error(422, "base_invalid", "Rama base no válida")
    # El repo tiene que ser accesible para el usuario Y para la App: el token
    # del usuario solo ve esa intersección.
    try:
        info = await gh.Cliente(user["id"])("GET", f"/repos/{repo}")
    except gh.NoConectado as exc:
        raise _error(409, "github_not_connected", str(exc))
    except gh.GitHubError as exc:
        if exc.status in (403, 404):
            raise _error(422, "repo_not_accessible", f"Lixbon no tiene acceso a {repo} en GitHub")
        raise _error(502, "github_error", str(exc))
    if base and base != info.get("default_branch"):
        try:
            await gh.Cliente(user["id"])("GET", f"/repos/{info['full_name']}/branches/{quote(base, safe='')}")
        except gh.GitHubError as exc:
            if exc.status == 404:
                raise _error(422, "base_not_found", f"La rama {base} no existe en {info['full_name']}")
            raise _error(502, "github_error", str(exc))
    if not await asyncio.to_thread(runner().disponible):
        raise _error(503, "sandbox_unavailable", "No se pueden crear entornos ahora. Prueba de nuevo en unos minutos")
    sesion, sb = await asyncio.to_thread(store.crear, user["id"], info["full_name"],
                                         base or info.get("default_branch") or "main", mode, model,
                                         info["full_name"].split("/", 1)[1])
    ip = request.client.host if request.client else None
    log_audit_event("coding_session_created", user_id=user["id"], ip_address=ip,
                    session_id=sesion["id"], repo=sb["repo"])
    hub.notify_user(user["id"], {"type": "session_created", "session": {**sesion, "sandbox": store.publico(sb)}})
    return {"session": sesion, "sandbox": store.publico(sb)}


@router.get("/api/coding/branches")
async def ramas(repo: str, lixbon_session: str | None = Cookie(default=None),
                authorization: str | None = Header(default=None)):
    """Ramas del repo para elegir la base en «Nueva sesión» (la por defecto primero)."""
    user = _usuario(lixbon_session, authorization)
    if not _REPO.match(repo):
        raise _error(422, "repo_invalid", "Repositorio no válido")
    cli = gh.Cliente(user["id"])
    try:
        info = await cli("GET", f"/repos/{repo}")
        data = await cli("GET", f"/repos/{repo}/branches", params={"per_page": 100})
    except gh.NoConectado as exc:
        raise _error(409, "github_not_connected", str(exc))
    except gh.GitHubError as exc:
        if exc.status in (403, 404):
            raise _error(422, "repo_not_accessible", f"Lixbon no tiene acceso a {repo} en GitHub")
        raise _error(502, "github_error", str(exc))
    por_defecto = info.get("default_branch") or "main"
    nombres = [b["name"] for b in data if isinstance(b, dict) and b.get("name")]
    nombres.sort(key=lambda n: (n != por_defecto, n.lower()))
    return {"default_branch": por_defecto, "branches": nombres}


# ------------------------------------------------------------------ mensajes

@router.post("/api/coding/sessions/{session_id}/prompt")
async def enviar(session_id: str, payload: dict[str, Any],
                 lixbon_session: str | None = Cookie(default=None),
                 authorization: str | None = Header(default=None)):
    """El mensaje del usuario. Si el entorno no está encendido, lo arranca (o
    reanuda) y guarda el mensaje hasta que el host haya clonado."""
    user = _usuario(lixbon_session, authorization)
    sb = await _propia(session_id, user)
    texto = str(payload.get("text") or "").strip()
    adjuntos = remote_router._clean_attachments(payload.get("attachments"))
    if not texto and not adjuntos:
        raise _error(422, "empty", "El mensaje está vacío")
    if len(texto) > 100_000:
        raise _error(413, "too_large", "El mensaje es demasiado largo")
    mensaje = {"type": "prompt", "text": texto}
    if adjuntos:
        mensaje["attachments"] = adjuntos
    menciones = remote_router._clean_mentions(payload.get("mentions"))
    if menciones:
        mensaje["mentions"] = menciones

    if sb["estado"] == "activa":
        # Al canal aunque el host esté reconectando: los pendientes solo se
        # entregan al arrancar el entorno, así que ahí se perdería.
        ch = hub.channel(session_id, user["id"])
        remote_router._queue_command(ch, mensaje, payload.get("rid"), require_online=False)
        await asyncio.to_thread(store.tocar, session_id)
        return {"queued": True, "estado": "activa"}

    pendientes = list(sb.get("pending_prompt") or [])
    if len(pendientes) >= MAX_PENDIENTES:
        raise _error(429, "too_many_pending", "Espera a que el entorno esté listo")
    pendientes.append(mensaje)
    primero = sb["estado"] == "creada" and len(pendientes) == 1
    sb = await asyncio.to_thread(store.actualizar, session_id, pending_prompt_json=pendientes)
    if primero and texto:
        # El título de la sesión sale del primer mensaje, como en el chat.
        titulo = re.sub(r"\s+", " ", texto)[:60]
        updated = await asyncio.to_thread(update_remote_session_meta, session_id, titulo)
        if updated:
            hub.notify_user(user["id"], {"type": "session_updated", "session": updated})
    sb = await ciclo.arrancar(sb)
    return {"queued": True, "estado": sb["estado"]}


@router.patch("/api/coding/sessions/{session_id}")
async def cambiar(session_id: str, payload: dict[str, Any],
                  lixbon_session: str | None = Cookie(default=None),
                  authorization: str | None = Header(default=None)):
    """Renombrar o cambiar el modo y el modelo del agente (vale también
    tras pausar: el contenedor nuevo arranca con el modo guardado)."""
    user = _usuario(lixbon_session, authorization)
    sb = await _propia(session_id, user)
    mode = payload.get("mode")
    model = payload.get("model")
    title = payload.get("title")

    # Valida todo antes de aplicar nada: una petición mixta no deja cambios a medias.
    if mode is not None and mode not in store.MODOS:
        raise _error(422, "mode_invalid", "Modo no válido")
    model = await _validar_modelo(model, user)
    titulo = None
    if title is not None:
        titulo = re.sub(r"\s+", " ", str(title)).strip()[:120]
        if not titulo:
            raise _error(422, "title_invalid", "El nombre no puede estar vacío")

    if mode is not None:
        sb = await asyncio.to_thread(store.actualizar, session_id, mode=mode)
        # Encolado aunque el host esté reconectando (reinicio del gateway): lo
        # recibe al volver. Pausada: el contenedor nuevo arranca con este modo.
        if sb["estado"] in store.ESTADOS_ACTIVOS:  # preparando también: lo lee al conectar
            hub.push_command(hub.channel(session_id, user["id"]), {"type": "config", "mode": mode})
    if model is not None:
        # Se guarda para que reanudar arranque con el mismo modelo.
        sb = await asyncio.to_thread(store.actualizar, session_id, model=model)
        if sb["estado"] in store.ESTADOS_ACTIVOS:
            hub.push_command(hub.channel(session_id, user["id"]), {"type": "config", "model": model})
    if titulo is not None:
        updated = await asyncio.to_thread(rename_remote_session, session_id, titulo, user["id"])
        if updated:
            hub.notify_user(user["id"], {"type": "session_updated", "session": updated})

    return {"sandbox": store.publico(sb)}


# ------------------------------------------------------------------ pausar / reanudar / borrar

@router.post("/api/coding/sessions/{session_id}/pause")
async def pausar(session_id: str, lixbon_session: str | None = Cookie(default=None),
                 authorization: str | None = Header(default=None)):
    user = _usuario(lixbon_session, authorization)
    sb = await ciclo.pausar(await _propia(session_id, user))
    return {"sandbox": store.publico(sb)}


@router.post("/api/coding/sessions/{session_id}/resume", status_code=202)
async def reanudar(session_id: str, lixbon_session: str | None = Cookie(default=None),
                   authorization: str | None = Header(default=None)):
    user = _usuario(lixbon_session, authorization)
    sb = await ciclo.arrancar(await _propia(session_id, user))
    return {"sandbox": store.publico(sb)}


@router.post("/api/coding/sessions/{session_id}/retry", status_code=202)
async def reintentar(session_id: str, lixbon_session: str | None = Cookie(default=None),
                     authorization: str | None = Header(default=None)):
    user = _usuario(lixbon_session, authorization)
    sb = await _propia(session_id, user)
    if sb["estado"] != "error":
        raise _error(409, "not_in_error", "La sesión no tiene ningún error que reintentar")
    sb = await ciclo.arrancar(sb)
    return {"sandbox": store.publico(sb)}


@router.delete("/api/coding/sessions/{session_id}", status_code=204)
async def eliminar(session_id: str, request: Request, lixbon_session: str | None = Cookie(default=None),
                   authorization: str | None = Header(default=None)):
    user = _usuario(lixbon_session, authorization)
    if await asyncio.to_thread(store.borrar_huerfana, session_id, user["id"]):
        return Response(status_code=204)
    sb = await _propia(session_id, user)
    await ciclo.terminar(sb)
    await asyncio.to_thread(store.borrar, session_id, user["id"])
    ip = request.client.host if request.client else None
    log_audit_event("coding_session_deleted", user_id=user["id"], ip_address=ip, session_id=session_id)
    return Response(status_code=204)


# ------------------------------------------------------------------ PR

def _segundos(ini: Any, fin: Any) -> int | None:
    from datetime import datetime
    try:
        a = datetime.fromisoformat(str(ini).replace("Z", "+00:00"))
        b = datetime.fromisoformat(str(fin).replace("Z", "+00:00"))
        return max(0, int((b - a).total_seconds()))
    except (TypeError, ValueError):
        return None


@router.get("/api/coding/sessions/{session_id}/prs")
async def prs(session_id: str, lixbon_session: str | None = Cookie(default=None),
              authorization: str | None = Header(default=None)):
    """Los PRs abiertos en esta sesión con su estado y sus checks (pestaña PRs)."""
    user = _usuario(lixbon_session, authorization)
    sb = await _propia(session_id, user)
    url = sb.get("pr_url") or ""
    m = re.search(r"/pull/(\d+)$", url)
    if not m:
        return {"prs": []}
    cli = gh.Cliente(user["id"])
    try:
        p = await cli("GET", f"/repos/{sb['repo']}/pulls/{m.group(1)}")
    except gh.NoConectado as exc:
        raise _error(409, "github_not_connected", str(exc))
    except gh.GitHubError:
        return {"prs": [{"number": int(m.group(1)), "url": url, "state": "unknown"}]}
    checks = {"total": 0, "ok": 0, "failed": 0, "pending": 0}
    # Cada check con su resultado y duración, y lo que dijo al fallar (output
    # del check run): con eso «Arreglar CI» le pasa el fallo al agente.
    lista: list[dict[str, Any]] = []
    try:
        runs = await cli("GET", f"/repos/{sb['repo']}/commits/{p['head']['sha']}/check-runs", params={"per_page": 100})
        for run in runs.get("check_runs", []):
            checks["total"] += 1
            if run.get("status") != "completed":
                checks["pending"] += 1
                res = "pending"
            elif run.get("conclusion") in ("success", "neutral", "skipped"):
                checks["ok"] += 1
                res = "ok"
            else:
                checks["failed"] += 1
                res = "failed"
            out = run.get("output") or {}
            lista.append({
                "name": str(run.get("name") or "")[:120], "result": res,
                "seconds": _segundos(run.get("started_at"), run.get("completed_at")),
                "url": run.get("html_url") or run.get("details_url"),
                "summary": str(out.get("summary") or out.get("title") or "")[:4000] if res == "failed" else "",
            })
    except (gh.GitHubError, KeyError, TypeError):
        pass
    # Revisiones (la última de cada persona) y sus comentarios en el código.
    revisiones: list[dict[str, Any]] = []
    try:
        ultimas: dict[str, dict[str, Any]] = {}
        resp = await cli("GET", f"/repos/{sb['repo']}/pulls/{m.group(1)}/reviews", params={"per_page": 100})
        for r in resp if isinstance(resp, list) else []:
            if not isinstance(r, dict):
                continue
            autor = ((r.get("user") or {}).get("login")) or "?"
            if r.get("state") in ("APPROVED", "CHANGES_REQUESTED", "COMMENTED"):
                ultimas[autor] = {"author": autor, "state": r["state"].lower(), "body": str(r.get("body") or "")[:2000],
                                  "comments": []}
        resp = await cli("GET", f"/repos/{sb['repo']}/pulls/{m.group(1)}/comments", params={"per_page": 100})
        for c in resp if isinstance(resp, list) else []:
            if not isinstance(c, dict):
                continue
            autor = ((c.get("user") or {}).get("login")) or "?"
            if autor in ultimas and len(ultimas[autor]["comments"]) < 20:
                ultimas[autor]["comments"].append({
                    "path": c.get("path"), "line": c.get("line") or c.get("original_line"),
                    "body": str(c.get("body") or "")[:1000]})
        revisiones = list(ultimas.values())
    except (gh.GitHubError, KeyError, TypeError, AttributeError):
        pass
    estado = "merged" if p.get("merged") else p.get("state", "open")
    return {"prs": [{
        "number": p.get("number"), "url": p.get("html_url") or url, "title": p.get("title"), "state": estado,
        "draft": bool(p.get("draft")), "base": (p.get("base") or {}).get("ref"), "head": (p.get("head") or {}).get("ref"),
        "additions": p.get("additions"), "deletions": p.get("deletions"), "changed_files": p.get("changed_files"),
        "checks": checks, "check_runs": lista, "reviews": revisiones, "updated_at": p.get("updated_at"),
    }]}

@router.post("/api/coding/sessions/{session_id}/pr", status_code=202)
async def pedir_pr(session_id: str, payload: dict[str, Any],
                   lixbon_session: str | None = Cookie(default=None),
                   authorization: str | None = Header(default=None)):
    """El botón «Crear PR»: el host sube la rama y pide el PR por /host."""
    user = _usuario(lixbon_session, authorization)
    sb = await _propia(session_id, user)
    ch = hub.get(session_id)
    if sb["estado"] != "activa" or not ch or not hub.host_online(ch):
        raise _error(409, "not_active", "Reanuda la sesión para crear el PR")
    if not sb.get("branch"):
        raise _error(409, "no_branch", "Todavía no hay cambios en una rama de la sesión")
    hub.push_command(ch, {"type": "create_pr", "title": str(payload.get("title") or "")[:200],
                          "body": str(payload.get("body") or "")[:20_000]})
    return {"queued": True}


async def _crear_pr(sb: dict[str, Any], titulo: str, cuerpo: str) -> dict[str, Any]:
    if sb.get("pr_url"):
        return {"url": sb["pr_url"], "existente": True}
    rama = sb.get("branch") or ""
    if not _RAMA.match(rama):
        raise _error(409, "no_branch", "La sesión no tiene una rama lixbon/… que proponer")
    try:
        p = await gh.Cliente(sb["user_id"])("POST", f"/repos/{sb['repo']}/pulls", json={
            "head": rama, "base": sb["default_branch"],
            "title": titulo or rama.removeprefix("lixbon/").replace("-", " ").capitalize(),
            "body": cuerpo or "Abierto desde una sesión de Coding de Lixbon."})
    except gh.GitHubError as exc:
        raise _error(502 if exc.status >= 500 else 409, "pr_failed", str(exc))
    sb = await asyncio.to_thread(store.actualizar, sb["session_id"], pr_url=p["html_url"])
    ciclo.avisar(sb, "activa")
    hub.publish_events(hub.channel(sb["session_id"], sb["user_id"]),
                       [{"type": "pr", "url": p["html_url"], "number": p["number"], "branch": rama,
                         "base": sb["default_branch"]}])
    return {"url": p["html_url"], "number": p["number"]}


# ------------------------------------------------------------------ lado del host (token del contenedor)

@router.post("/api/coding/sessions/{session_id}/host")
async def host_estado(session_id: str, payload: dict[str, Any],
                      authorization: str | None = Header(default=None)):
    """El CLI del contenedor informa: clonando → activa (con su rama) o error,
    y pide el PR. Al pasar a activa recibe los mensajes que esperaban."""
    sb = await asyncio.to_thread(_contenedor, session_id, authorization)
    respuesta: dict[str, Any] = {}
    estado = payload.get("estado")
    rama = payload.get("branch")
    if rama is not None:
        if not isinstance(rama, str) or not _RAMA.match(rama):
            raise _error(422, "branch_invalid", "La rama de la sesión debe empezar por lixbon/")
        sb = await asyncio.to_thread(store.actualizar, session_id, branch=rama)
    if estado == "clonando":
        ciclo.avisar(sb, "clonando")
    elif estado == "activa":
        pendientes = sb.get("pending_prompt") or []
        sb = await asyncio.to_thread(store.actualizar, session_id, estado="activa", pending_prompt_json=None, error=None)
        ciclo.avisar(sb, "activa", branch=sb.get("branch"))
        respuesta["pending"] = pendientes
    elif estado == "error":
        detalle = str(payload.get("error") or "El entorno falló")[:300]
        sb = await asyncio.to_thread(store.actualizar, session_id, estado="error", error=detalle)
        ciclo.avisar(sb, "error", detalle=detalle)
    if isinstance(payload.get("pr"), dict):
        pr = payload["pr"]
        respuesta["pr"] = await _crear_pr(sb, str(pr.get("title") or "")[:200], str(pr.get("body") or "")[:20_000])
    respuesta["sandbox"] = store.publico(sb)
    return respuesta


# ------------------------------------------------------------------ proxy git

async def _token_github(user_id: int) -> str:
    try:
        return await gh.token_de(user_id)
    except gh.GitHubError as exc:
        raise _error(401, "github_not_connected", str(exc))


@router.get("/api/coding/sessions/{session_id}/git/info/refs")
async def git_refs(session_id: str, request: Request, service: str = "",
                   authorization: str | None = Header(default=None)):
    sb = await asyncio.to_thread(_contenedor, session_id, authorization)
    if service not in ("git-upload-pack", "git-receive-pack"):
        raise _error(403, "git_dumb_http", "Solo git smart HTTP")
    return await _reenviar_git(sb, request, "info/refs", params={"service": service})


@router.post("/api/coding/sessions/{session_id}/git/git-upload-pack")
async def git_upload(session_id: str, request: Request, authorization: str | None = Header(default=None)):
    sb = await asyncio.to_thread(_contenedor, session_id, authorization)
    return await _reenviar_git(sb, request, "git-upload-pack")


@router.post("/api/coding/sessions/{session_id}/git/git-receive-pack")
async def git_receive(session_id: str, request: Request, authorization: str | None = Header(default=None)):
    sb = await asyncio.to_thread(_contenedor, session_id, authorization)
    codificacion = request.headers.get("content-encoding", "identity").strip().lower()
    if codificacion not in ("identity", "gzip"):
        raise _error(415, "push_encoding_unsupported", "Codificación de push no admitida")
    cuerpo = bytearray()
    async for trozo in request.stream():
        cuerpo += trozo
        if len(cuerpo) > MAX_PUSH:
            raise _error(413, "push_too_large", "El push es demasiado grande")
    try:
        datos = bytes(cuerpo)
        refs = await asyncio.to_thread(validar_push, datos, codificacion == "gzip")
    except PushRechazado as exc:
        log.info("[coding] push rechazado en %s: %s", session_id, exc)
        raise _error(403, "push_rejected", str(exc))
    rama = refs[0].removeprefix("refs/heads/")
    if sb.get("branch") != rama:
        sb = await asyncio.to_thread(store.actualizar, session_id, branch=rama)
    return await _reenviar_git(sb, request, "git-receive-pack", cuerpo=datos)


async def _reenviar_git(sb: dict[str, Any], request: Request, resto: str, *,
                        params: dict[str, str] | None = None, cuerpo: bytes | None = None):
    token = await _token_github(sb["user_id"])
    basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    cabeceras = {"Authorization": f"Basic {basic}", "User-Agent": "git/lixbon-coding"}
    for h in ("content-type", "accept", "git-protocol", "content-encoding"):
        if h in request.headers:
            cabeceras[h] = request.headers[h]
    cliente = httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=15.0))
    if cuerpo is None and request.method == "POST":
        contenido: Any = request.stream()
    else:
        contenido = cuerpo
    req = cliente.build_request(request.method, ruta_github(sb["repo"], resto), params=params,
                                headers=cabeceras, content=contenido)
    try:
        resp = await cliente.send(req, stream=True)
    except httpx.HTTPError as exc:
        await cliente.aclose()
        raise _error(502, "github_unreachable", f"No se pudo contactar con GitHub: {exc}")
    if resp.status_code in (401, 403):
        await resp.aclose()
        await cliente.aclose()
        raise _error(403, "github_denied", "GitHub rechazó el acceso al repositorio")

    async def cuerpo_resp():
        try:
            async for trozo in resp.aiter_raw():
                yield trozo
        finally:
            await resp.aclose()
            await cliente.aclose()

    salida = {k: v for k, v in resp.headers.items()
              if k.lower() in ("content-type", "cache-control", "content-encoding", "expires", "pragma")}
    return StreamingResponse(cuerpo_resp(), status_code=resp.status_code, headers=salida)


# ------------------------------------------------------------------ vista previa

_CABECERAS_PETICION = ("accept", "accept-language", "content-type", "range", "if-none-match",
                       "if-modified-since", "user-agent", "cache-control")
# Sin content-length/content-encoding: httpx ya descomprimió el cuerpo.
_CABECERAS_RESPUESTA = ("content-type", "etag", "last-modified", "content-range", "accept-ranges",
                        "location", "vary")
# La app del repo es contenido NO confiable servido bajo el origen de Lixbon:
# CSP sandbox la deja en un origen opaco (sin cookies ni storage de Lixbon).
CSP_VISTA = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads"


@router.api_route("/api/coding/sessions/{session_id}/preview/{port}/{path:path}",
                  methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
async def vista_previa(session_id: str, port: int, path: str, request: Request,
                       lixbon_session: str | None = Cookie(default=None),
                       authorization: str | None = Header(default=None)):
    user = _usuario(lixbon_session, authorization)
    sb = await _propia(session_id, user)
    if not 1024 <= port <= 65535 or port == 7000:
        raise _error(422, "port_invalid", "Puerto no válido")
    if sb["estado"] != "activa":
        raise _error(409, "not_active", "La sesión no está activa")
    cuerpo = await request.body() if request.method not in ("GET", "HEAD") else None
    if cuerpo and len(cuerpo) > MAX_PREVIEW_BODY:
        raise _error(413, "too_large", "Petición demasiado grande")
    # Ni cookies ni Authorization de Lixbon llegan a la app del repo.
    cabeceras = {h: request.headers[h] for h in _CABECERAS_PETICION if h in request.headers}
    # Ruta COMPLETA: la app se arranca con base = /api/coding/sessions/<sid>/preview/<puerto>/
    # (LIXBON_PREVIEW_BASE en el contenedor) para que sus rutas absolutas sigan
    # dentro de la vista previa. El proxy del contenedor reintenta sin prefijo.
    url = f"http://lixbon-sbx-{session_id}:7000/{port}{request.url.path}"
    try:
        for intento in range(2):
            async with httpx.AsyncClient(proxy=runner().proxy_vista_previa(), timeout=30.0) as cli:
                resp = await cli.request(request.method, url, params=dict(request.query_params),
                                         headers=cabeceras, content=cuerpo)
            # 401 del propio proxy de entrada (no de la app): su clave es de otro
            # arranque del gateway. Se recrea una vez y se reintenta.
            if not (intento == 0 and resp.status_code == 401
                    and resp.headers.get("server", "").startswith("tinyproxy")
                    and "tinyproxy" in resp.headers.get("www-authenticate", "").lower()):
                break
            log.warning("[coding] el proxy de entrada no reconoce la clave: se recrea")
            try:
                await asyncio.to_thread(runner().reparar_vista_previa)
            except SandboxError:
                raise _error(503, "sandbox_unavailable", "La vista previa no está disponible ahora")
    except httpx.HTTPError:
        raise _error(502, "preview_unreachable", f"Nada responde en el puerto {port}. Pídele al agente que arranque la app")
    salida = {k: v for k, v in resp.headers.items() if k.lower() in _CABECERAS_RESPUESTA}
    # Nunca Set-Cookie: la app podría pisar la sesión de Lixbon.
    salida["Content-Security-Policy"] = CSP_VISTA
    salida["X-Content-Type-Options"] = "nosniff"
    salida["Cache-Control"] = "no-store"
    if "location" in salida and salida["location"].startswith("/"):
        salida["location"] = f"/api/coding/sessions/{session_id}/preview/{port}{salida['location']}"
    return Response(content=resp.content, status_code=resp.status_code, headers=salida)
