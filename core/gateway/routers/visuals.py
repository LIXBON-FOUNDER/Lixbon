"""
visuals.py — API de Visuals: diseños y piezas de marketing con versiones.

- POST   /api/visuals                       : crea un visual (opcionalmente con archivos)
- GET    /api/visuals                       : lista del usuario
- GET    /api/visuals/{id}                  : manifiesto de una versión
- POST   /api/visuals/{id}/files            : escribe un lote → versión nueva (base_version opcional)
- GET    /api/visuals/{id}/files/{path}     : un archivo
- GET    /api/visuals/{id}/events           : avisos en vivo (SSE)
- POST   /api/visuals/{id}/render           : encola renders (PNG/MP4) de sus piezas
- GET    /api/visuals/{id}/renders          : estado de los renders
- POST   /api/internal/render-events        : el worker avisa de un render terminado
- DELETE /api/visuals/{id}
- POST/DELETE /api/visuals/{id}/share       : enlace público de solo lectura
- GET    /api/shared-visuals/{token}[/files/{path}]

Leer es para todos; crear y escribir, para Pro y Advance (visuals_service).
El HTML de un visual es contenido no confiable: se sirve con CSP `sandbox`.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import hmac
import json
import os
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from core.gateway import visuals_service as svc
from core.gateway.visual_events import bus
from core.persistence import visual_renders as renders
from core.persistence import visuals as store
from core.persistence.queries import log_audit_event
from core.security.auth import web_or_api_key_auth

router = APIRouter(tags=["visuals"])

ACTIVE_CONTENT = ("text/html", "image/svg+xml")
KEEPALIVE_S = 20


class FileIn(BaseModel):
    path: str = Field(..., min_length=1, max_length=store.MAX_PATH_LEN)
    role: str | None = Field(None, max_length=10)
    text: str | None = None
    base64: str | None = None


class VisualCreate(BaseModel):
    kind: str = Field("design", max_length=20)
    title: str = Field(..., min_length=1, max_length=200)
    meta: dict[str, Any] | None = None
    files: list[FileIn] | None = Field(None, max_length=store.MAX_FILES_PER_PUSH)


class RenderRequest(BaseModel):
    paths: list[str] | None = Field(None, max_length=store.MAX_FILES_PER_PUSH)


class FilesPush(BaseModel):
    files: list[FileIn] = Field(..., min_length=1, max_length=store.MAX_FILES_PER_PUSH)
    title: str | None = Field(None, max_length=200)
    base_version: int | None = Field(None, ge=0)


def decode_files(files: list[FileIn] | list[dict] | None) -> list[dict[str, Any]]:
    out = []
    for f in files or []:
        d = f.model_dump() if isinstance(f, BaseModel) else dict(f)
        item = {"path": d.get("path"), "role": d.get("role"), "text": d.get("text")}
        if d.get("base64") is not None:
            try:
                item["data"] = base64.b64decode(d["base64"], validate=True)
            except (binascii.Error, ValueError):
                raise store.VisualError("invalid_content", f"{d.get('path')}: base64 no válido")
        out.append(item)
    return out


def _fail(e: store.VisualError) -> HTTPException:
    return HTTPException(e.status, {"code": e.code, "message": e.message, **e.extra})


def _not_found() -> HTTPException:
    return HTTPException(404, {"code": "not_found", "message": "Visual no encontrado"})


def _file_response(found: tuple[str, bytes] | None) -> Response:
    if not found:
        raise HTTPException(404, {"code": "not_found", "message": "Archivo no encontrado"})
    mime, data = found
    headers = {"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"}
    if mime in ACTIVE_CONTENT:
        headers["Content-Security-Policy"] = "sandbox allow-scripts"
    return Response(content=data, media_type=mime, headers=headers)


@router.post("/api/visuals", status_code=201)
async def api_create_visual(body: VisualCreate, request: Request,
                            user: dict[str, Any] = Depends(web_or_api_key_auth)):
    try:
        return svc.create(user, kind=body.kind, title=body.title, meta=body.meta,
                          files=decode_files(body.files), origin="api", base=str(request.base_url))
    except store.VisualError as e:
        raise _fail(e)


@router.get("/api/visuals")
async def api_list_visuals(kind: str | None = Query(None, max_length=20), q: str | None = Query(None, max_length=100),
                           conversation_id: str | None = Query(None, max_length=64),
                           limit: int = Query(60, ge=1, le=200), offset: int = Query(0, ge=0),
                           user: dict[str, Any] = Depends(web_or_api_key_auth)):
    return {"items": store.list_visuals(user["id"], kind=kind, query=q, limit=limit, offset=offset,
                                        conversation_id=conversation_id)}


class VisualPatch(BaseModel):
    title: str | None = Field(None, max_length=200)
    meta: dict[str, Any] | None = None


@router.patch("/api/visuals/{visual_id}")
async def api_update_visual(visual_id: str, body: VisualPatch, user: dict[str, Any] = Depends(web_or_api_key_auth)):
    try:
        row = store.update_visual(visual_id, user["id"], title=body.title, meta=body.meta)
    except store.VisualError as e:
        raise _fail(e)
    if not row:
        raise _not_found()
    bus.publish(visual_id, {"type": "meta", "title": row["title"]})
    return row


@router.get("/api/visuals/{visual_id}/versions")
async def api_list_versions(visual_id: str, user: dict[str, Any] = Depends(web_or_api_key_auth)):
    items = store.list_versions(visual_id, user["id"])
    if items is None:
        raise _not_found()
    return {"items": items}


@router.get("/api/visuals/{visual_id}")
async def api_get_visual(visual_id: str, request: Request, version: int | None = Query(None, ge=0),
                         user: dict[str, Any] = Depends(web_or_api_key_auth)):
    manifest = store.get_manifest(visual_id, user["id"], version)
    if not manifest:
        raise _not_found()
    return {**manifest, "url": svc.url_for(visual_id, str(request.base_url))}


@router.post("/api/visuals/{visual_id}/files")
async def api_push_files(visual_id: str, body: FilesPush, request: Request,
                         user: dict[str, Any] = Depends(web_or_api_key_auth)):
    try:
        return svc.write(user, visual_id, files=decode_files(body.files), title=body.title,
                         base_version=body.base_version, origin="web", base=str(request.base_url))
    except store.VisualError as e:
        raise _fail(e)


@router.get("/api/visuals/{visual_id}/files/{path:path}")
async def api_get_file(visual_id: str, path: str, v: int | None = Query(None, ge=0),
                       user: dict[str, Any] = Depends(web_or_api_key_auth)):
    return _file_response(store.read_file(visual_id, path, user_id=user["id"], version=v))


@router.get("/api/visuals/{visual_id}/events")
async def api_visual_events(visual_id: str, request: Request,
                            user: dict[str, Any] = Depends(web_or_api_key_auth)):
    manifest = store.get_manifest(visual_id, user["id"])
    if not manifest:
        raise _not_found()

    async def stream():
        q = bus.subscribe(visual_id)
        try:
            yield f"event: hello\ndata: {json.dumps({'version': manifest['version']})}\n\n"
            while not await request.is_disconnected():
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=KEEPALIVE_S)
                    yield f"event: {ev['type']}\ndata: {json.dumps(ev)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            bus.unsubscribe(visual_id, q)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@router.post("/api/visuals/{visual_id}/render", status_code=202)
async def api_render(visual_id: str, body: RenderRequest | None = None,
                     user: dict[str, Any] = Depends(web_or_api_key_auth)):
    try:
        return {"jobs": svc.request_render(user, visual_id, body.paths if body else None, origin="web")}
    except store.VisualError as e:
        raise _fail(e)


@router.get("/api/visuals/{visual_id}/renders")
async def api_renders(visual_id: str, user: dict[str, Any] = Depends(web_or_api_key_auth)):
    jobs = renders.list_jobs(visual_id, user["id"])
    if jobs is None:
        raise _not_found()
    return {"jobs": jobs}


@router.post("/api/internal/render-events", status_code=204)
async def api_render_event(event: dict[str, Any], x_render_token: str | None = Header(default=None)):
    expected = os.getenv("RENDER_WORKER_TOKEN", "")
    if not expected or not x_render_token or not hmac.compare_digest(expected, x_render_token):
        raise HTTPException(403, {"code": "forbidden", "message": "Token del worker no válido"})
    visual_id = str(event.get("visual_id") or "")
    if visual_id:
        bus.publish(visual_id, {k: event[k] for k in ("type", "visual_id", "job_id", "path", "status",
                                                       "output_path", "version", "error") if k in event})
    return Response(status_code=204)


@router.delete("/api/visuals/{visual_id}")
async def api_delete_visual(visual_id: str, user: dict[str, Any] = Depends(web_or_api_key_auth)):
    if not store.delete_visual(visual_id, user["id"]):
        raise _not_found()
    log_audit_event("visual_deleted", user_id=user["id"])
    return {"deleted": True}


@router.post("/api/visuals/{visual_id}/share")
async def api_enable_share(visual_id: str, user: dict[str, Any] = Depends(web_or_api_key_auth)):
    token = store.set_share(visual_id, user["id"], True)
    if not token:
        raise _not_found()
    log_audit_event("visual_shared", user_id=user["id"])
    return {"shared": True, "token": token, "path": f"/s/v/{token}"}


@router.delete("/api/visuals/{visual_id}/share")
async def api_disable_share(visual_id: str, user: dict[str, Any] = Depends(web_or_api_key_auth)):
    if store.get_manifest(visual_id, user["id"]) is None:
        raise _not_found()
    store.set_share(visual_id, user["id"], False)
    return {"shared": False}


@router.get("/api/shared-visuals/{token}")
async def api_shared_visual(token: str):
    manifest = store.get_shared_manifest(token)
    if not manifest:
        raise HTTPException(404, {"code": "not_found", "message": "Enlace no válido o revocado"})
    return manifest


@router.get("/api/shared-visuals/{token}/files/{path:path}")
async def api_shared_file(token: str, path: str):
    return _file_response(store.read_shared_file(token, path))
