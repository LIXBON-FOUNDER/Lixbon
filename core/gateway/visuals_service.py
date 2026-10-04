"""
visuals_service.py — Reglas de Visuals compartidas por la API REST y el servidor
MCP: quién puede crear (Pro/Advance), límites del plan, URL pública y avisos en vivo.
"""
from __future__ import annotations

from typing import Any

from core.billing.quota import PLANES_CON_VISUALS, render_limits, visual_limits
from core.config import PUBLIC_BASE_URL
from core.gateway.visual_events import bus
from core.persistence import visual_renders as renders
from core.persistence import visuals as store
from core.persistence.queries import get_plan_for_user, log_audit_event

VisualError = store.VisualError


def base_url(fallback: str = "") -> str:
    return PUBLIC_BASE_URL or fallback.rstrip("/") or "https://lixbon.com"


def url_for(visual_id: str, base: str = "") -> str:
    return f"{base_url(base)}/visuals/{visual_id}"


def _plan_for_creator(user: dict[str, Any]) -> dict[str, Any]:
    plan = get_plan_for_user(user["id"])
    if user.get("role") != "admin" and plan.get("id") not in PLANES_CON_VISUALS:
        raise VisualError("visuals_requires_plan",
                          "Crear y editar Visuals está incluido en los planes Pro y Advance. "
                          "Mejora tu plan en https://lixbon.com/plans.", 403)
    return plan


def creator_limits(user: dict[str, Any]) -> tuple[int, int]:
    return visual_limits(user, _plan_for_creator(user))


def request_render(user: dict[str, Any], visual_id: str, paths: list[str] | None = None,
                   origin: str = "web") -> list[dict[str, Any]]:
    jobs = renders.enqueue(visual_id, user["id"], paths, origin=origin,
                           limits=render_limits(user, _plan_for_creator(user)))
    for job in jobs:
        bus.publish(visual_id, {"type": "render", "visual_id": visual_id, "job_id": job["id"],
                                "path": job["path"], "status": job["status"]})
    return jobs


def _auto_render(user: dict[str, Any], visual_id: str) -> list[dict[str, Any]]:
    """Tras una edición, vuelve a renderizar las piezas cuya salida quedó vieja.
    Sin cuota disponible no hace nada: la pieza queda marcada como desactualizada."""
    stale = renders.stale_outputs(visual_id, user["id"])
    if not stale:
        return []
    try:
        return request_render(user, visual_id, stale, origin="auto")
    except VisualError:
        return []


def _announce(visual_id: str, res: dict[str, Any], origin: str) -> None:
    bus.publish(visual_id, {"type": "version", "version": res["version"], "files": res.get("files", []),
                            "title": res["title"], "origin": origin})


def create(user: dict[str, Any], *, kind: str, title: str, meta: dict | None = None,
           files: list[dict] | None = None, origin: str = "web", base: str = "") -> dict[str, Any]:
    max_count, max_mb = creator_limits(user)
    vis = store.create_visual(user["id"], kind, title, meta, max_count=max_count)
    log_audit_event("visual_created", user_id=user["id"], kind=kind, origin=origin)
    if files:
        try:
            vis = store.put_files(vis["id"], user["id"], files, base_version=0, max_storage_mb=max_mb)
        except VisualError:
            store.delete_visual(vis["id"], user["id"])
            raise
        _announce(vis["id"], vis, origin)
    return {**vis, "url": url_for(vis["id"], base)}


def write(user: dict[str, Any], visual_id: str, *, files: list[dict] | None = None,
          edits: list[dict] | None = None, base_version: int | None = None, title: str | None = None,
          origin: str = "web", base: str = "") -> dict[str, Any]:
    _, max_mb = creator_limits(user)
    if edits and files:
        raise VisualError("invalid_params", "Envía edits o files, no ambos en la misma llamada")
    if edits:
        if base_version is None:
            raise VisualError("invalid_params", "Las ediciones necesitan base_version")
        res = store.edit_files(visual_id, user["id"], edits, base_version=base_version,
                               title=title, max_storage_mb=max_mb)
    else:
        res = store.put_files(visual_id, user["id"], files or [], title=title,
                              base_version=base_version, max_storage_mb=max_mb)
    _announce(visual_id, res, origin)
    return {**res, "url": url_for(visual_id, base), "renders": _auto_render(user, visual_id)}
