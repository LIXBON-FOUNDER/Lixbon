"""
skills.py — Catálogo de skills oficiales de Lixbon: paquetes versionados, instalaciones
y calificaciones. Solo los administradores publican; el IDE y la web descargan el
paquete (zip con `<slug>/SKILL.md` y el resto de archivos) y verifican su sha256.
"""
from __future__ import annotations

import hashlib
import io
import json
import posixpath
import re
import zipfile
from typing import Any

import yaml
from packaging.version import InvalidVersion, Version
from sqlalchemy import delete, func, select

from core.persistence.database import get_session
from core.persistence.models import Skill, SkillInstall, SkillRating, SkillVersion
from core.persistence.queries import now_iso

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
MAX_PACKAGE_BYTES = 10 * 1024 * 1024
MAX_FILES = 200
CLIENTS = ("ide", "web", "cli")
# Restos de desarrollo que no deben llegar al usuario aunque estén en la carpeta subida.
EXCLUDED_DIRS = {"evals", "__pycache__", ".git", "node_modules"}
EXCLUDED_FILES = {".DS_Store", "Thumbs.db"}
ZIP_DATE = (1980, 1, 1, 0, 0, 0)


class SkillError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def parse_frontmatter(text: str) -> dict[str, Any]:
    m = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n", text, re.S)
    if not m:
        raise SkillError("invalid_skill", "SKILL.md no empieza con un frontmatter YAML (---)")
    try:
        data = yaml.safe_load(m.group(1))
    except yaml.YAMLError as exc:
        raise SkillError("invalid_skill", f"Frontmatter YAML no válido: {exc}") from exc
    if not isinstance(data, dict) or not data.get("name") or not data.get("description"):
        raise SkillError("invalid_skill", "El frontmatter necesita `name` y `description`")
    return data


def _clean_path(raw: str) -> str | None:
    if not isinstance(raw, str) or not raw or "\x00" in raw:
        raise SkillError("invalid_path", "Ruta de archivo no válida")
    path = posixpath.normpath(raw.replace("\\", "/"))
    if path.startswith(("/", "../")) or path in (".", "..") or ":" in path:
        raise SkillError("invalid_path", f"Ruta de archivo no válida: {raw}")
    parts = path.split("/")
    if any(p in EXCLUDED_DIRS for p in parts[:-1]) or parts[-1] in EXCLUDED_FILES or path.endswith(".pyc"):
        return None
    return path


def _strip_root(files: dict[str, bytes]) -> dict[str, bytes]:
    """Al subir una carpeta, el navegador antepone su nombre: `marketing-lxo/SKILL.md`."""
    if "SKILL.md" in files:
        return files
    roots = {p.split("/", 1)[0] for p in files}
    if len(roots) == 1 and all("/" in p for p in files):
        root = roots.pop() + "/"
        return {p[len(root):]: d for p, d in files.items()}
    return files


def build_package(raw_files: list[dict[str, Any]]) -> dict[str, Any]:
    """Valida los archivos de una skill y arma un zip determinista (mismo contenido,
    mismo sha256). Devuelve slug, frontmatter, zip, sha256 y lista de archivos."""
    files: dict[str, bytes] = {}
    for f in raw_files:
        path = _clean_path(f.get("path"))
        if path is not None:
            files[path] = f["data"]
    files = _strip_root(files)
    if "SKILL.md" not in files:
        raise SkillError("invalid_skill", "Falta SKILL.md en la raíz de la carpeta")
    if len(files) > MAX_FILES:
        raise SkillError("too_many_files", f"Una skill admite como máximo {MAX_FILES} archivos")
    try:
        meta = parse_frontmatter(files["SKILL.md"].decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise SkillError("invalid_skill", "SKILL.md debe estar en UTF-8") from exc
    slug = str(meta["name"])
    if not SLUG_RE.match(slug):
        raise SkillError("invalid_skill", f"`name` no válido para un comando: {slug}")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(files):
            info = zipfile.ZipInfo(f"{slug}/{path}", date_time=ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, files[path])
    package = buf.getvalue()
    if len(package) > MAX_PACKAGE_BYTES:
        raise SkillError("too_large", f"El paquete supera {MAX_PACKAGE_BYTES // (1024 * 1024)} MB", 413)
    return {
        "slug": slug, "meta": meta, "package": package,
        "sha256": hashlib.sha256(package).hexdigest(),
        "files": [{"path": p, "size": len(files[p])} for p in sorted(files)],
    }


def _summary_from(description: str) -> str:
    text = " ".join(str(description).split())
    first = re.split(r"(?<=[.!?])\s", text, maxsplit=1)[0]
    return first if len(first) <= 200 else first[:197].rstrip() + "…"


def _version_key(v: str) -> Version:
    try:
        return Version(v)
    except InvalidVersion:
        return Version("0")


def _latest(s, skill_id: int) -> SkillVersion | None:
    rows = s.scalars(select(SkillVersion).where(SkillVersion.skill_id == skill_id)).all()
    return max(rows, key=lambda r: _version_key(r.version), default=None)


def publish_version(raw_files: list[dict[str, Any]], version: str, changelog: str = "",
                    user_id: int | None = None) -> dict[str, Any]:
    if not VERSION_RE.match(version or ""):
        raise SkillError("invalid_version", "La versión debe tener la forma 1.2.0")
    pkg = build_package(raw_files)
    now = now_iso()
    with get_session() as s:
        skill = s.scalar(select(Skill).where(Skill.slug == pkg["slug"]))
        if skill is None:
            skill = Skill(slug=pkg["slug"], title=pkg["slug"], summary=_summary_from(pkg["meta"]["description"]),
                          description_md="", published=0, created_at=now, updated_at=now)
            s.add(skill)
            s.flush()
        latest = _latest(s, skill.id)
        if latest and _version_key(version) <= _version_key(latest.version):
            raise SkillError("version_not_newer",
                             f"La versión {version} no es mayor que la publicada ({latest.version})", 409)
        s.add(SkillVersion(skill_id=skill.id, version=version, changelog=changelog.strip(),
                           package=pkg["package"], sha256=pkg["sha256"], size=len(pkg["package"]),
                           files_json=json.dumps(pkg["files"]), published_by=user_id, created_at=now))
        skill.updated_at = now
        slug = skill.slug
    return get_skill(slug, published_only=False)


def update_skill(slug: str, **fields: Any) -> dict[str, Any]:
    allowed = {"title", "summary", "description_md", "category", "published"}
    with get_session() as s:
        skill = s.scalar(select(Skill).where(Skill.slug == slug))
        if skill is None:
            raise SkillError("not_found", "Skill no encontrada", 404)
        for key, value in fields.items():
            if key not in allowed or value is None:
                continue
            if key == "published":
                if value and _latest(s, skill.id) is None:
                    raise SkillError("no_versions", "Publica una versión antes de mostrar la skill")
                value = 1 if value else 0
            setattr(skill, key, value)
        skill.updated_at = now_iso()
    return get_skill(slug, published_only=False)


def delete_skill(slug: str) -> None:
    with get_session() as s:
        skill = s.scalar(select(Skill).where(Skill.slug == slug))
        if skill is None:
            raise SkillError("not_found", "Skill no encontrada", 404)
        for model in (SkillRating, SkillInstall, SkillVersion):
            s.execute(delete(model).where(model.skill_id == skill.id))
        s.delete(skill)


def _stats(s, skill_ids: list[int], user_id: int | None) -> dict[int, dict[str, Any]]:
    out = {i: {"rating_avg": None, "rating_count": 0, "installs": 0, "my_rating": None} for i in skill_ids}
    if not skill_ids:
        return out
    for sid, avg, count in s.execute(
            select(SkillRating.skill_id, func.avg(SkillRating.stars), func.count())
            .where(SkillRating.skill_id.in_(skill_ids)).group_by(SkillRating.skill_id)):
        out[sid]["rating_avg"] = round(float(avg), 2)
        out[sid]["rating_count"] = count
    for sid, count in s.execute(
            select(SkillInstall.skill_id, func.count()).where(SkillInstall.skill_id.in_(skill_ids))
            .group_by(SkillInstall.skill_id)):
        out[sid]["installs"] = count
    if user_id is not None:
        for sid, stars in s.execute(select(SkillRating.skill_id, SkillRating.stars)
                                    .where(SkillRating.skill_id.in_(skill_ids), SkillRating.user_id == user_id)):
            out[sid]["my_rating"] = stars
    return out


def _card(skill: Skill, latest: SkillVersion | None, stats: dict[str, Any]) -> dict[str, Any]:
    return {
        "slug": skill.slug, "command": f"/{skill.slug}", "title": skill.title, "summary": skill.summary,
        "category": skill.category, "published": bool(skill.published),
        "version": latest.version if latest else None,
        "released_at": latest.created_at if latest else None,
        "sha256": latest.sha256 if latest else None,
        "size": latest.size if latest else None,
        "created_at": skill.created_at, "updated_at": skill.updated_at, **stats,
    }


def list_skills(*, published_only: bool = True, user_id: int | None = None) -> list[dict[str, Any]]:
    with get_session() as s:
        q = select(Skill).order_by(Skill.title)
        if published_only:
            q = q.where(Skill.published == 1)
        skills = s.scalars(q).all()
        stats = _stats(s, [k.id for k in skills], user_id)
        return [_card(k, _latest(s, k.id), stats[k.id]) for k in skills]


def get_skill(slug: str, *, published_only: bool = True, user_id: int | None = None) -> dict[str, Any]:
    with get_session() as s:
        skill = s.scalar(select(Skill).where(Skill.slug == slug))
        if skill is None or (published_only and not skill.published):
            raise SkillError("not_found", "Skill no encontrada", 404)
        versions = sorted(s.scalars(select(SkillVersion).where(SkillVersion.skill_id == skill.id)).all(),
                          key=lambda r: _version_key(r.version), reverse=True)
        latest = versions[0] if versions else None
        out = _card(skill, latest, _stats(s, [skill.id], user_id)[skill.id])
        out["description_md"] = skill.description_md
        out["files"] = json.loads(latest.files_json) if latest else []
        out["versions"] = [{"version": v.version, "changelog": v.changelog, "released_at": v.created_at,
                            "sha256": v.sha256, "size": v.size} for v in versions]
        if user_id is not None:
            out["installed_by_me"] = s.scalar(select(func.count()).select_from(SkillInstall).where(
                SkillInstall.skill_id == skill.id, SkillInstall.user_id == user_id)) > 0
        return out


def download(slug: str, version: str | None, user_id: int | None, client: str | None) -> dict[str, Any]:
    """Paquete publicado y registro de la instalación."""
    with get_session() as s:
        skill = s.scalar(select(Skill).where(Skill.slug == slug, Skill.published == 1))
        if skill is None:
            raise SkillError("not_found", "Skill no encontrada", 404)
        if version:
            row = s.scalar(select(SkillVersion).where(SkillVersion.skill_id == skill.id,
                                                      SkillVersion.version == version))
        else:
            row = _latest(s, skill.id)
        if row is None:
            raise SkillError("not_found", "Versión no encontrada", 404)
        s.add(SkillInstall(skill_id=skill.id, version_id=row.id, user_id=user_id,
                           client=client if client in CLIENTS else None, created_at=now_iso()))
        return {"slug": skill.slug, "version": row.version, "sha256": row.sha256, "package": bytes(row.package)}


def rate(slug: str, user_id: int, stars: int | None) -> dict[str, Any]:
    """Un voto por usuario y skill, que se puede cambiar o retirar (stars=None).
    Solo vota quien la ha descargado alguna vez."""
    if stars is not None and not (isinstance(stars, int) and 1 <= stars <= 5):
        raise SkillError("invalid_rating", "La calificación va de 1 a 5")
    with get_session() as s:
        skill = s.scalar(select(Skill).where(Skill.slug == slug, Skill.published == 1))
        if skill is None:
            raise SkillError("not_found", "Skill no encontrada", 404)
        row = s.scalar(select(SkillRating).where(SkillRating.skill_id == skill.id,
                                                 SkillRating.user_id == user_id))
        if stars is None:
            if row is not None:
                s.delete(row)
        else:
            installed = s.scalar(select(func.count()).select_from(SkillInstall).where(
                SkillInstall.skill_id == skill.id, SkillInstall.user_id == user_id))
            if not installed:
                raise SkillError("rating_requires_install", "Instala la skill antes de calificarla", 403)
            now = now_iso()
            if row is None:
                s.add(SkillRating(skill_id=skill.id, user_id=user_id, stars=stars, created_at=now, updated_at=now))
            else:
                row.stars, row.updated_at = stars, now
        s.flush()
        return _stats(s, [skill.id], user_id)[skill.id]
