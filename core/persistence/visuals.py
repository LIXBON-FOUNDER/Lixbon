"""
visuals.py — Persistencia de Visuals: diseños y piezas de marketing que crean el
chat web, el CLI y los agentes del IDE. Versionado lineal por copia en escritura:
cada escritura crea una versión nueva con los archivos que cambian y hereda el resto.
"""
from __future__ import annotations

import hashlib
import json
import mimetypes
import posixpath
import re
import secrets
from typing import Any

from sqlalchemy import delete, desc, func, select

from core.inference.visual_files import apply_edits
from core.persistence.database import get_session
from core.persistence.models import Visual, VisualFile, VisualVersion
from core.persistence.queries import now_iso

KINDS = ("design", "marketing")
ROLES = ("source", "output")
TEXT_EXTENSIONS = {".html", ".md", ".svg", ".json", ".txt", ".css", ".js"}
BINARY_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".woff2"}
MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_VISUAL_BYTES = 100 * 1024 * 1024
MAX_FILES_PER_PUSH = 100
MAX_PATH_LEN = 200
MAX_LABEL_LEN = 80
MB = 1024 * 1024
RENDER_META = re.compile(r'<meta\s+name="render"\s+content="(image|video)\s+(\d+)x(\d+)(?:\s+([\d.]+))?"', re.I)


def parse_render_meta(html: str) -> dict[str, Any] | None:
    m = RENDER_META.search(html or "")
    if not m:
        return None
    return {"kind": m.group(1).lower(), "width": int(m.group(2)), "height": int(m.group(3)),
            "seconds": float(m.group(4)) if m.group(4) else 12.0}


class VisualError(Exception):
    def __init__(self, code: str, message: str, status: int = 400, **extra: Any):
        super().__init__(message)
        self.code, self.message, self.status, self.extra = code, message, status, extra


def normalize_path(raw: str) -> str:
    if not isinstance(raw, str) or not raw or "\\" in raw or "\x00" in raw:
        raise VisualError("invalid_path", "Ruta de archivo no válida")
    path = posixpath.normpath(raw)
    if path.startswith(("/", "../")) or path in (".", "..") or len(path) > MAX_PATH_LEN:
        raise VisualError("invalid_path", f"Ruta de archivo no válida: {raw}")
    ext = posixpath.splitext(path)[1].lower()
    if ext not in TEXT_EXTENSIONS | BINARY_EXTENSIONS:
        raise VisualError("invalid_extension", f"Extensión no permitida: {ext or '(ninguna)'}")
    return path


def _row(v: Visual) -> dict[str, Any]:
    return {
        "id": v.id, "kind": v.kind, "title": v.title, "version": v.version,
        "shared": bool(v.share_token), "meta": json.loads(v.meta_json) if v.meta_json else {},
        "created_at": v.created_at, "updated_at": v.updated_at,
    }


def _owned(s, visual_id: str, user_id: int) -> Visual | None:
    v = s.get(Visual, visual_id)
    return v if v and v.user_id == user_id else None


def _files_at(s, visual_id: str, version: int) -> dict[str, VisualFile]:
    rows = s.scalars(
        select(VisualFile)
        .where(VisualFile.visual_id == visual_id, VisualFile.version <= version)
        .order_by(desc(VisualFile.version))
    ).all()
    out: dict[str, VisualFile] = {}
    for f in rows:
        out.setdefault(f.path, f)
    return out


def _clamp(v: Visual, version: int | None) -> int:
    return v.version if version is None else max(0, min(version, v.version))


def _file_info(f: VisualFile) -> dict[str, Any]:
    info = {"path": f.path, "role": f.role, "mime": f.mime, "size": f.size,
            "sha256": f.sha256, "version": f.version}
    if f.meta_json:
        info["meta"] = json.loads(f.meta_json)
    if f.content_text is not None and f.path.endswith(".html"):
        render = parse_render_meta(f.content_text)
        if render:
            info["render"] = render
    return info


def _content(f: VisualFile) -> bytes:
    return f.content_blob if f.content_blob is not None else (f.content_text or "").encode("utf-8")


def user_storage_bytes(user_id: int) -> int:
    with get_session() as s:
        return int(s.scalar(
            select(func.coalesce(func.sum(VisualFile.size), 0))
            .join(Visual, Visual.id == VisualFile.visual_id)
            .where(Visual.user_id == user_id)) or 0)


def create_visual(user_id: int, kind: str, title: str, meta: dict | None = None,
                  max_count: int = -1) -> dict[str, Any]:
    if kind not in KINDS:
        raise VisualError("invalid_kind", f"Tipo no válido: {kind}. Usa: {', '.join(KINDS)}")
    with get_session() as s:
        total = s.scalar(select(func.count()).select_from(Visual).where(Visual.user_id == user_id))
        if max_count != -1 and total >= max_count:
            raise VisualError("visual_limit", f"Tu plan permite {max_count} visuals. Borra alguno o mejora tu plan.", 403)
        now = now_iso()
        v = Visual(id=f"vis_{secrets.token_urlsafe(12)}", user_id=user_id, kind=kind,
                   title=title.strip()[:200] or "Sin título", version=0,
                   meta_json=json.dumps(meta) if meta else None, created_at=now, updated_at=now)
        s.add(v)
        s.flush()
        return _row(v)


def _prepare(files: list[dict[str, Any]]) -> list[tuple]:
    if not files or len(files) > MAX_FILES_PER_PUSH:
        raise VisualError("invalid_batch", f"Envía entre 1 y {MAX_FILES_PER_PUSH} archivos por vez")
    prepared = []
    for f in files:
        path = normalize_path(f.get("path"))
        role = f.get("role") or ("source" if path.endswith(".html") else "output")
        if role not in ROLES:
            raise VisualError("invalid_role", f"Rol no válido: {role}")
        ext = posixpath.splitext(path)[1].lower()
        text, data = f.get("text"), f.get("data")
        if ext in TEXT_EXTENSIONS:
            if not isinstance(text, str):
                raise VisualError("invalid_content", f"{path} debe ir como texto")
            raw = text.encode("utf-8")
        else:
            if not isinstance(data, (bytes, bytearray)) or not data:
                raise VisualError("invalid_content", f"{path} debe ir como binario (base64)")
            raw = bytes(data)
        if len(raw) > MAX_FILE_BYTES:
            raise VisualError("file_too_large", f"{path} supera {MAX_FILE_BYTES // MB} MB", 413)
        prepared.append((path, role, ext, text, raw, f.get("meta")))
    return prepared


def _clean_label(label: str | None) -> str | None:
    label = " ".join((label or "").split())
    return label[:MAX_LABEL_LEN].rstrip() or None


def put_files(visual_id: str, user_id: int, files: list[dict[str, Any]], *, title: str | None = None,
              base_version: int | None = None, max_storage_mb: int = -1, mode: str = "new",
              origin: str | None = None, label: str | None = None) -> dict[str, Any]:
    """Escribe un lote. Con `base_version`, rechaza la escritura si alguien guardó otra
    versión antes (`stale_base`): quien escribe debe releer.

    mode: "new" crea una versión; "amend" funde la última versión con el lote en una
    versión nueva y la anterior desaparece del historial (el número sube igual, así
    quien tenía la vieja recibe stale_base); "attach" añade el lote a la última versión
    sin cambiar su número (solo salidas que genera el servidor, como los renders).
    `label` nombra la versión; al rehacerla sin nombre nuevo conserva el que tenía."""
    if mode not in ("new", "amend", "attach"):
        raise VisualError("invalid_mode", f"Modo de escritura no válido: {mode}")
    prepared = _prepare(files)
    incoming = sum(len(p[4]) for p in prepared)
    if max_storage_mb != -1 and user_storage_bytes(user_id) + incoming > max_storage_mb * MB:
        raise VisualError("storage_limit", f"Superas el almacenamiento de tu plan ({max_storage_mb} MB).", 413)

    with get_session() as s:
        v = _owned(s, visual_id, user_id)
        if not v:
            raise VisualError("not_found", "Visual no encontrado", 404)
        if base_version is not None and base_version != v.version:
            raise VisualError("stale_base", f"La última versión es la {v.version}; vuelve a leerla antes de escribir.",
                              409, latest_version=v.version)
        sizes = {p: f.size for p, f in _files_at(s, visual_id, v.version).items()}
        for path, _role, _ext, _text, raw, _meta in prepared:
            sizes[path] = len(raw)
        if sum(sizes.values()) > MAX_VISUAL_BYTES:
            raise VisualError("visual_too_large", f"El visual supera {MAX_VISUAL_BYTES // MB} MB", 413)
        head = v.version
        incoming = {p[0] for p in prepared}
        label = _clean_label(label)
        v.updated_at = now_iso()
        if mode == "attach" and head > 0:
            s.execute(delete(VisualFile).where(VisualFile.visual_id == v.id, VisualFile.version == head,
                                               VisualFile.path.in_(incoming)))
        else:
            v.version += 1
            if mode == "amend" and head > 0:
                for f in s.scalars(select(VisualFile).where(VisualFile.visual_id == v.id, VisualFile.version == head)).all():
                    if f.path in incoming:
                        s.delete(f)
                    else:
                        f.version = v.version
                previa = _labels(s, v.id).get(head)
                if previa:
                    label = label or previa.label
                    s.delete(previa)
            s.add(VisualVersion(visual_id=v.id, version=v.version, label=label, origin=origin, created_at=v.updated_at))
        s.flush()
        if title:
            v.title = title.strip()[:200] or v.title
        if origin and mode != "attach":
            current = json.loads(v.meta_json) if v.meta_json else {}
            current["last_origin"] = origin
            v.meta_json = json.dumps(current)
        for path, role, ext, text, raw, meta in prepared:
            is_text = ext in TEXT_EXTENSIONS
            s.add(VisualFile(
                visual_id=v.id, version=v.version, path=path, role=role,
                mime=mimetypes.guess_type(path)[0] or "application/octet-stream",
                size=len(raw), sha256=hashlib.sha256(raw).hexdigest(),
                content_text=text if is_text else None,
                content_blob=None if is_text else raw,
                meta_json=json.dumps(meta) if meta else None, created_at=v.updated_at))
        return {**_row(v), "files": [p[0] for p in prepared], "label": None if mode == "attach" else label}


def edit_files(visual_id: str, user_id: int, edits: list[dict[str, Any]], *, base_version: int,
               title: str | None = None, max_storage_mb: int = -1, mode: str = "new",
               origin: str | None = None, label: str | None = None) -> dict[str, Any]:
    """Aplica pares SEARCH/REPLACE sobre los archivos de texto de `base_version`.
    Cada edición: {path, search, replace}. Si un fragmento no encaja, no se escribe nada."""
    if not edits:
        raise VisualError("invalid_batch", "No hay ediciones")
    with get_session() as s:
        v = _owned(s, visual_id, user_id)
        if not v:
            raise VisualError("not_found", "Visual no encontrado", 404)
        if base_version != v.version:
            raise VisualError("stale_base", f"La última versión es la {v.version}; vuelve a leerla antes de escribir.",
                              409, latest_version=v.version)
        files = _files_at(s, visual_id, v.version)
        texts = {p: f.content_text for p, f in files.items() if f.content_text is not None}
        roles = {p: f.role for p, f in files.items()}
    for e in edits:
        path = normalize_path(e.get("path"))
        if path not in texts:
            raise VisualError("not_found", f"{path} no existe o no es de texto en la versión {base_version}", 404)
        try:
            texts[path] = apply_edits(texts[path], [(e.get("search", ""), e.get("replace", ""))])
        except ValueError as err:
            raise VisualError("edit_mismatch", f"En {path} no se encontró el fragmento: «{err}». Lee el archivo y reintenta.", 422)
    changed = sorted({normalize_path(e["path"]) for e in edits})
    return put_files(visual_id, user_id, [{"path": p, "role": roles[p], "text": texts[p]} for p in changed],
                     title=title, base_version=base_version, max_storage_mb=max_storage_mb,
                     mode=mode, origin=origin, label=label)


def _cover(files: dict[str, VisualFile]) -> str | None:
    """Portada de la galería: la primera imagen de salida o, si no hay, la página principal."""
    images = sorted(p for p, f in files.items() if f.mime.startswith("image/") and f.role == "output")
    if images:
        return images[0]
    pages = sorted(p for p in files if p.endswith((".html", ".svg")))
    return "index.html" if "index.html" in pages else (pages[0] if pages else None)


def list_visuals(user_id: int, kind: str | None = None, query: str | None = None,
                 limit: int = 60, offset: int = 0, conversation_id: str | None = None) -> list[dict[str, Any]]:
    with get_session() as s:
        q = select(Visual).where(Visual.user_id == user_id)
        if kind:
            q = q.where(Visual.kind == kind)
        if query:
            q = q.where(Visual.title.ilike(f"%{query}%"))
        if conversation_id:
            q = q.where(Visual.meta_json.contains(conversation_id, autoescape=True))
        items = s.scalars(q.order_by(desc(Visual.updated_at)).limit(limit).offset(offset)).all()
        out = []
        for v in items:
            row = _row(v)
            if conversation_id and row["meta"].get("conversation_id") != conversation_id:
                continue
            files = _files_at(s, v.id, v.version)
            previews = sorted(p for p, f in files.items() if f.mime.startswith("image/") and f.role == "output")
            out.append({**row, "file_count": len(files), "previews": previews[:4], "cover": _cover(files),
                        "pages": sum(1 for p in files if p.endswith((".html", ".svg")))})
        return out


META_KEYS = {"conversation_id", "design_system", "origin", "mode"}


def update_visual(visual_id: str, user_id: int, *, title: str | None = None,
                  meta: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Título y metadatos (conversación del estudio, design system): no crean versión."""
    with get_session() as s:
        v = _owned(s, visual_id, user_id)
        if not v:
            return None
        if title is not None:
            title = title.strip()[:200]
            if not title:
                raise VisualError("invalid_title", "El título no puede estar vacío")
            v.title = title
        if meta:
            unknown = set(meta) - META_KEYS
            if unknown:
                raise VisualError("invalid_meta", f"Metadatos no admitidos: {', '.join(sorted(unknown))}")
            current = json.loads(v.meta_json) if v.meta_json else {}
            current.update(meta)
            v.meta_json = json.dumps(current)
            if len(v.meta_json) > 20_000:
                raise VisualError("invalid_meta", "Metadatos demasiado grandes")
        v.updated_at = now_iso()
        return _row(v)


def _labels(s, visual_id: str) -> dict[int, VisualVersion]:
    return {r.version: r for r in s.scalars(select(VisualVersion).where(VisualVersion.visual_id == visual_id)).all()}


def list_versions(visual_id: str, user_id: int) -> list[dict[str, Any]] | None:
    """Cada versión con su nombre, fecha y los archivos que cambió."""
    with get_session() as s:
        v = _owned(s, visual_id, user_id)
        if not v:
            return None
        rows = s.execute(select(VisualFile.version, VisualFile.path, VisualFile.role, VisualFile.created_at)
                         .where(VisualFile.visual_id == visual_id).order_by(VisualFile.version)).all()
        names = _labels(s, visual_id)
        out: dict[int, dict[str, Any]] = {}
        for version, path, role, created in rows:
            meta = names.get(version)
            item = out.setdefault(version, {"version": version, "created_at": meta.created_at if meta else created,
                                            "label": meta.label if meta else None,
                                            "origin": meta.origin if meta else None, "sources": [], "outputs": []})
            item["sources" if role == "source" else "outputs"].append(path)
        return sorted(out.values(), key=lambda i: i["version"], reverse=True)


def rename_version(visual_id: str, user_id: int, version: int, label: str) -> dict[str, Any] | None:
    label = _clean_label(label)
    if not label:
        raise VisualError("invalid_label", "El nombre no puede estar vacío")
    with get_session() as s:
        v = _owned(s, visual_id, user_id)
        if not v:
            return None
        exists = s.scalar(select(func.count()).select_from(VisualFile)
                          .where(VisualFile.visual_id == v.id, VisualFile.version == version))
        if not exists:
            raise VisualError("not_found", f"La versión {version} no existe", 404)
        row = _labels(s, v.id).get(version)
        if row:
            row.label = label
        else:
            s.add(VisualVersion(visual_id=v.id, version=version, label=label, created_at=now_iso()))
        return {"version": version, "label": label}


def _manifest(s, v: Visual, version: int | None) -> dict[str, Any]:
    ver = _clamp(v, version)
    files = _files_at(s, v.id, ver)
    names = _labels(s, v.id)
    return {**_row(v), "share_token": v.share_token, "viewing": ver,
            "viewing_label": names[ver].label if ver in names else None,
            "files": sorted((_file_info(f) for f in files.values()), key=lambda f: f["path"])}


def get_manifest(visual_id: str, user_id: int, version: int | None = None) -> dict[str, Any] | None:
    with get_session() as s:
        v = _owned(s, visual_id, user_id)
        return _manifest(s, v, version) if v else None


def get_texts(visual_id: str, user_id: int, version: int | None = None,
              paths: list[str] | None = None) -> dict[str, str] | None:
    """Contenido de los archivos de texto de una versión (para el agente)."""
    with get_session() as s:
        v = _owned(s, visual_id, user_id)
        if not v:
            return None
        files = _files_at(s, v.id, _clamp(v, version))
        wanted = set(paths) if paths else None
        return {p: f.content_text for p, f in sorted(files.items())
                if f.content_text is not None and (wanted is None or p in wanted)}


def read_file(visual_id: str, path: str, *, user_id: int, version: int | None = None) -> tuple[str, bytes] | None:
    with get_session() as s:
        v = _owned(s, visual_id, user_id)
        if not v:
            return None
        f = _files_at(s, v.id, _clamp(v, version)).get(path)
        return (f.mime, _content(f)) if f else None


def delete_visual(visual_id: str, user_id: int) -> bool:
    with get_session() as s:
        v = _owned(s, visual_id, user_id)
        if not v:
            return False
        s.execute(delete(VisualFile).where(VisualFile.visual_id == v.id))
        s.execute(delete(VisualVersion).where(VisualVersion.visual_id == v.id))
        s.delete(v)
        return True


def set_share(visual_id: str, user_id: int, enabled: bool) -> str | None:
    with get_session() as s:
        v = _owned(s, visual_id, user_id)
        if not v:
            return None
        v.share_token = (v.share_token or f"sv_{secrets.token_urlsafe(16)}") if enabled else None
        return v.share_token


def _by_token(s, token: str) -> Visual | None:
    return s.scalars(select(Visual).where(Visual.share_token == token)).first() if token else None


def get_shared_manifest(token: str) -> dict[str, Any] | None:
    with get_session() as s:
        v = _by_token(s, token)
        if not v:
            return None
        m = _manifest(s, v, None)
        for k in ("id", "shared", "share_token"):
            m.pop(k, None)
        return m


def read_shared_file(token: str, path: str) -> tuple[str, bytes] | None:
    with get_session() as s:
        v = _by_token(s, token)
        if not v:
            return None
        f = _files_at(s, v.id, v.version).get(path)
        return (f.mime, _content(f)) if f else None


def owner_of(visual_id: str) -> int | None:
    with get_session() as s:
        v = s.get(Visual, visual_id)
        return v.user_id if v else None
