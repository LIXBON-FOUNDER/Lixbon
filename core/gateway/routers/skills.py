"""
skills.py — Catálogo de skills oficiales (`/adversary`, `/marketing-lxo`).

- GET    /api/skills                         : catálogo publicado (público)
- GET    /api/skills/{slug}                  : detalle, versiones y archivos (público)
- GET    /api/skills/{slug}/download         : paquete zip (sesión o API key); cuenta la instalación
- PUT    /api/skills/{slug}/rating           : calificar 1–5; DELETE la retira
- /api/admin/skills[...]                     : publicar versiones y editar la ficha (admin)

El paquete lleva su sha256 en la cabecera `X-Skill-Sha256`; el IDE lo verifica antes de instalar.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Query, Response
from pydantic import BaseModel, Field

from core.gateway.routers.visuals import FileIn, decode_files
from core.persistence import skills as store
from core.persistence.queries import log_audit_event
from core.persistence.visuals import VisualError
from core.security.auth import admin_required, cookie_auth_required

router = APIRouter(tags=["skills"])


def optional_user(lixbon_session: str | None = Cookie(default=None),
                  authorization: str | None = Header(default=None)) -> dict[str, Any] | None:
    if not lixbon_session and not authorization:
        return None
    try:
        return cookie_auth_required(lixbon_session, authorization)
    except HTTPException:
        return None


def _raise(exc: store.SkillError | VisualError):
    raise HTTPException(status_code=exc.status, detail={"code": exc.code, "message": exc.message})


def _uid(user: dict[str, Any] | None) -> int | None:
    return user["id"] if user else None


class RatingIn(BaseModel):
    stars: int = Field(..., ge=1, le=5)


class VersionIn(BaseModel):
    version: str = Field(..., max_length=20)
    changelog: str = Field("", max_length=4000)
    files: list[FileIn] = Field(..., min_length=1, max_length=store.MAX_FILES)


class SkillPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=80)
    summary: str | None = Field(None, min_length=1, max_length=240)
    description_md: str | None = Field(None, max_length=20000)
    category: str | None = Field(None, max_length=40)
    published: bool | None = None


@router.get("/api/skills")
async def list_skills(user: dict[str, Any] | None = Depends(optional_user)):
    return {"skills": store.list_skills(user_id=_uid(user))}


@router.get("/api/skills/{slug}")
async def get_skill(slug: str, user: dict[str, Any] | None = Depends(optional_user)):
    try:
        return store.get_skill(slug, user_id=_uid(user))
    except store.SkillError as exc:
        _raise(exc)


@router.get("/api/skills/{slug}/download")
async def download(slug: str, version: str | None = Query(None, max_length=20),
                   client: str | None = Query(None, max_length=10),
                   user: dict[str, Any] = Depends(cookie_auth_required)):
    try:
        pkg = store.download(slug, version, user["id"], client)
    except store.SkillError as exc:
        _raise(exc)
    log_audit_event("skill_downloaded", user_id=user["id"], skill=slug, version=pkg["version"], client=client)
    return Response(pkg["package"], media_type="application/zip", headers={
        "Content-Disposition": f'attachment; filename="{pkg["slug"]}-{pkg["version"]}.zip"',
        "X-Skill-Version": pkg["version"], "X-Skill-Sha256": pkg["sha256"],
        "Access-Control-Expose-Headers": "X-Skill-Version, X-Skill-Sha256",
        "Cache-Control": "no-store",
    })


@router.put("/api/skills/{slug}/rating")
async def rate(slug: str, body: RatingIn, user: dict[str, Any] = Depends(cookie_auth_required)):
    try:
        return store.rate(slug, user["id"], body.stars)
    except store.SkillError as exc:
        _raise(exc)


@router.delete("/api/skills/{slug}/rating")
async def unrate(slug: str, user: dict[str, Any] = Depends(cookie_auth_required)):
    try:
        return store.rate(slug, user["id"], None)
    except store.SkillError as exc:
        _raise(exc)


@router.get("/api/admin/skills")
async def admin_list(_admin: dict[str, Any] = Depends(admin_required)):
    return {"skills": store.list_skills(published_only=False)}


@router.get("/api/admin/skills/{slug}")
async def admin_get(slug: str, _admin: dict[str, Any] = Depends(admin_required)):
    try:
        return store.get_skill(slug, published_only=False)
    except store.SkillError as exc:
        _raise(exc)


@router.post("/api/admin/skills/versions")
async def admin_publish(body: VersionIn, admin: dict[str, Any] = Depends(admin_required)):
    """Sube la carpeta de una skill. El slug sale del `name` de su SKILL.md: si no
    existe se crea oculta, para completar la ficha antes de mostrarla."""
    try:
        out = store.publish_version(decode_files(body.files), body.version.strip(), body.changelog,
                                    user_id=admin["id"])
    except (store.SkillError, VisualError) as exc:
        _raise(exc)
    log_audit_event("skill_version_published", user_id=admin["id"], skill=out["slug"], version=out["version"])
    return out


@router.patch("/api/admin/skills/{slug}")
async def admin_update(slug: str, body: SkillPatch, admin: dict[str, Any] = Depends(admin_required)):
    try:
        out = store.update_skill(slug, **body.model_dump(exclude_none=True))
    except store.SkillError as exc:
        _raise(exc)
    log_audit_event("skill_updated", user_id=admin["id"], skill=slug)
    return out


@router.delete("/api/admin/skills/{slug}", status_code=204)
async def admin_delete(slug: str, admin: dict[str, Any] = Depends(admin_required)):
    try:
        store.delete_skill(slug)
    except store.SkillError as exc:
        _raise(exc)
    log_audit_event("skill_deleted", user_id=admin["id"], skill=slug)
    return Response(status_code=204)
