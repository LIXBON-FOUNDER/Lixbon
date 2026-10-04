"""
visual_renders.py — Cola de renders de Visuals (HTML → PNG/MP4) en la base de datos.

El gateway encola; el worker (core/render/worker.py) reclama con arrendamiento,
renderiza y guarda la salida como versión nueva del visual. Cada salida registra
el sha256 del HTML del que sale, así se sabe si quedó desactualizada.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import and_, desc, func, or_, select

from core.persistence import visuals as store
from core.persistence.database import get_session
from core.persistence.models import Visual, VisualRenderJob
from core.persistence.queries import now_iso

MAX_ATTEMPTS = 3
MAX_ASSET_BYTES = 30 * 1024 * 1024
LEASE_S = 300
ACTIVE = ("queued", "running")
parse_meta = store.parse_render_meta


def output_path_for(path: str, kind: str) -> str:
    return path.rsplit(".", 1)[0] + (".mp4" if kind == "video" else ".png")


def _job(j: VisualRenderJob) -> dict[str, Any]:
    return {"id": j.id, "visual_id": j.visual_id, "path": j.path, "kind": j.kind, "status": j.status,
            "attempts": j.attempts, "output_path": j.output_path, "output_version": j.output_version,
            "error": j.error, "origin": j.origin, "created_at": j.created_at, "finished_at": j.finished_at}


def _day_start() -> str:
    return datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()


def _renderable(s, v: Visual) -> dict[str, dict[str, Any]]:
    """Fuentes HTML con <meta name="render"> en la última versión: ruta → meta."""
    out = {}
    for path, f in store._files_at(s, v.id, v.version).items():
        if f.content_text is not None and path.endswith(".html"):
            meta = parse_meta(f.content_text)
            if meta:
                out[path] = meta
    return out


def stale_outputs(visual_id: str, user_id: int) -> list[str]:
    """Fuentes con salida que ya no corresponde a su contenido actual."""
    with get_session() as s:
        v = store._owned(s, visual_id, user_id)
        if not v:
            return []
        files = store._files_at(s, v.id, v.version)
        stale = []
        for path, meta in _renderable(s, v).items():
            out = files.get(output_path_for(path, meta["kind"]))
            if not out:
                continue
            recorded = store._file_info(out).get("meta", {}).get("source_sha256")
            if recorded != files[path].sha256 and (recorded or files[path].version > out.version):
                stale.append(path)
        return stale


def enqueue(visual_id: str, user_id: int, paths: list[str] | None, *, origin: str,
            limits: tuple[int, int]) -> list[dict[str, Any]]:
    """Encola un render por fuente. Reutiliza el trabajo pendiente de la misma fuente
    (no cuenta para la cuota). Sin `paths`, encola todas las fuentes renderizables."""
    with get_session() as s:
        v = store._owned(s, visual_id, user_id)
        if not v:
            raise store.VisualError("not_found", "Visual no encontrado", 404)
        renderable = _renderable(s, v)
        wanted = paths or sorted(renderable)
        missing = [p for p in wanted if p not in renderable]
        if missing:
            raise store.VisualError("not_renderable",
                                    f"Sin <meta name=\"render\"> o no es HTML: {', '.join(missing)}", 400)
        if not wanted:
            raise store.VisualError("not_renderable", "Este visual no tiene piezas que renderizar", 400)

        used = dict(s.execute(
            select(VisualRenderJob.kind, func.count())
            .where(VisualRenderJob.user_id == user_id, VisualRenderJob.created_at >= _day_start())
            .group_by(VisualRenderJob.kind)).all())
        jobs = []
        for path in wanted:
            pending = s.scalars(select(VisualRenderJob).where(
                VisualRenderJob.visual_id == v.id, VisualRenderJob.path == path,
                VisualRenderJob.status.in_(ACTIVE))).first()
            if pending:
                jobs.append(_job(pending))
                continue
            kind = renderable[path]["kind"]
            limit = limits[1] if kind == "video" else limits[0]
            if limit != -1 and used.get(kind, 0) >= limit:
                raise store.VisualError(
                    "render_limit", f"Llegaste al máximo de renders de {'vídeo' if kind == 'video' else 'imagen'} "
                                    f"de hoy en tu plan ({limit}).", 429)
            used[kind] = used.get(kind, 0) + 1
            job = VisualRenderJob(id=f"rj_{secrets.token_urlsafe(10)}", visual_id=v.id, user_id=user_id,
                                  path=path, kind=kind, status="queued", attempts=0, origin=origin,
                                  created_at=now_iso())
            s.add(job)
            s.flush()
            jobs.append(_job(job))
        return jobs


def claim(worker_id: str, lease_s: int = LEASE_S) -> dict[str, Any] | None:
    """Reclama el trabajo más antiguo disponible y devuelve lo necesario para renderizarlo:
    el HTML vigente de la fuente y su sha256 (que la salida guardará)."""
    now = datetime.now(timezone.utc)
    with get_session() as s:
        job = s.scalars(
            select(VisualRenderJob)
            .where(or_(VisualRenderJob.status == "queued",
                       and_(VisualRenderJob.status == "running", VisualRenderJob.lease_until < now.isoformat())))
            .where(VisualRenderJob.attempts < MAX_ATTEMPTS)
            .order_by(VisualRenderJob.created_at)
            .limit(1)
            .with_for_update(skip_locked=True)
        ).first()
        if not job:
            return None
        job.status, job.worker = "running", worker_id
        job.attempts += 1
        job.started_at = now.isoformat()
        job.lease_until = (now + timedelta(seconds=lease_s)).isoformat()
        v = s.get(Visual, job.visual_id)
        source = store._files_at(s, v.id, v.version).get(job.path) if v else None
        meta = parse_meta(source.content_text) if source and source.content_text else None
        if not meta:
            job.status, job.error, job.finished_at = "failed", "La fuente ya no existe o perdió su <meta name=\"render\">", now.isoformat()
            return None
        # Los demás archivos del visual (capturas, SVG, CSS…) viajan con el HTML para
        # que sus rutas relativas resuelvan igual que en la web.
        assets, peso = {}, 0
        for path, f in sorted(store._files_at(s, v.id, v.version).items()):
            if path.endswith(".html") or path == output_path_for(job.path, job.kind) or f.mime.startswith("video/"):
                continue
            if peso + f.size > MAX_ASSET_BYTES:
                continue
            assets[path] = store._content(f)
            peso += f.size
        return {**_job(job), "user_id": job.user_id, "html": source.content_text,
                "source_sha256": source.sha256, "meta": meta, "assets": assets}


def complete(job_id: str, data: bytes, source_sha256: str, *, max_storage_mb: int = -1) -> dict[str, Any]:
    with get_session() as s:
        job = s.get(VisualRenderJob, job_id)
        if not job:
            raise store.VisualError("not_found", "Trabajo no encontrado", 404)
        visual_id, user_id, path, kind = job.visual_id, job.user_id, job.path, job.kind
    out = output_path_for(path, kind)
    res = store.put_files(visual_id, user_id, [{
        "path": out, "role": "output", "data": data,
        "meta": {"source": path, "source_sha256": source_sha256, "render_job": job_id},
    }], max_storage_mb=max_storage_mb)
    with get_session() as s:
        job = s.get(VisualRenderJob, job_id)
        job.status, job.output_path, job.output_version = "done", out, res["version"]
        job.error, job.finished_at, job.lease_until = None, now_iso(), None
        return {**_job(job), "user_id": user_id, "title": res["title"]}


def fail(job_id: str, error: str, *, retry: bool) -> dict[str, Any] | None:
    with get_session() as s:
        job = s.get(VisualRenderJob, job_id)
        if not job:
            return None
        job.error = error[:500]
        job.lease_until = None
        if retry and job.attempts < MAX_ATTEMPTS:
            job.status = "queued"
        else:
            job.status, job.finished_at = "failed", now_iso()
        return {**_job(job), "user_id": job.user_id}


def list_jobs(visual_id: str, user_id: int, limit: int = 30) -> list[dict[str, Any]] | None:
    with get_session() as s:
        if not store._owned(s, visual_id, user_id):
            return None
        rows = s.scalars(select(VisualRenderJob).where(VisualRenderJob.visual_id == visual_id)
                         .order_by(desc(VisualRenderJob.created_at)).limit(limit)).all()
        return [_job(j) for j in rows]
