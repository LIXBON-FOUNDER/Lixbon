"""
mcp.py — Servidor MCP remoto de Lixbon en /mcp (transporte Streamable HTTP, sin
sesión: cada POST lleva un mensaje JSON-RPC y se responde con JSON).

Expone Visuals a cualquier agente con MCP (Claude Code, Codex, Cursor, Gemini,
OpenCode, el CLI de Lixbon): herramientas visual_* y el prompt `visual`.
Auth: `Authorization: Bearer lixbon_sk_…` (el flujo OAuth llega en otra fase sin
cambiar las herramientas). GET/DELETE responden 405: no hay stream de servidor
ni sesiones.
"""
from __future__ import annotations

import asyncio
import base64
import json
import time
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from core.gateway import visuals_service as svc
from core.gateway.routers.visuals import decode_files
from core.inference.visual_prompts import export_instructions, visual_prompt
from core.persistence import visual_renders as renders
from core.persistence import visuals as store
from core.security.auth import web_or_api_key_auth

router = APIRouter(tags=["mcp"])

SUPPORTED_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
SERVER_INFO = {"name": "lixbon", "title": "Lixbon Visuals", "version": "1.0.0"}
MAX_TEXT_CHARS = 1_500_000
MAX_BINARY_BYTES = 8 * 1024 * 1024
MAX_VIEW_BYTES = 4 * 1024 * 1024
MAX_WAIT_S = 60
VIEWABLE = {"image/png", "image/jpeg", "image/webp", "image/gif"}
INSTRUCTIONS = (
    "Lixbon Visuals: crea, edita y pasa a código diseños de interfaz y piezas de marketing. "
    "Antes de editar, lee la versión actual con visual_get y escribe con base_version. "
    "El prompt `visual` trae las reglas completas de diseño."
)

_FILE = {
    "type": "object",
    "properties": {
        "path": {"type": "string", "description": "Ruta relativa, p. ej. index.html o piezas/post-1.html"},
        "text": {"type": "string", "description": "Contenido de un archivo de texto (.html, .md, .svg, .css, .js, .json)"},
        "base64": {"type": "string", "description": "Contenido de un binario (.png, .jpg, .webp, .gif, .mp4, .webm, .woff2)"},
        "role": {"type": "string", "enum": ["source", "output"],
                 "description": "source = HTML editable; output = resultado (PNG/MP4/MD). Por defecto según la extensión"},
    },
    "required": ["path"],
}

TOOLS = [
    {
        "name": "visual_create",
        "title": "Crear visual",
        "description": "Crea un visual nuevo en Lixbon Visuals con sus archivos y devuelve su id, versión y enlace. "
                       "kind: design (interfaces, páginas, prototipos) o marketing (imágenes, carruseles, vídeos).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Título corto del visual"},
                "kind": {"type": "string", "enum": list(store.KINDS), "default": "design"},
                "files": {"type": "array", "items": _FILE, "minItems": 1},
            },
            "required": ["title", "files"],
        },
    },
    {
        "name": "visual_update",
        "title": "Editar visual",
        "description": "Crea una versión nueva de un visual. Exige base_version = la versión que leíste con visual_get; "
                       "si alguien guardó después (p. ej. retoques del usuario en la web) responde stale_base y debes releer. "
                       "Usa edits (search/replace exacto) para cambios pequeños o files para archivos completos, no ambos.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Id del visual (vis_…)"},
                "base_version": {"type": "integer", "minimum": 0},
                "edits": {"type": "array", "items": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}, "search": {"type": "string"}, "replace": {"type": "string"}},
                    "required": ["path", "search", "replace"]}},
                "files": {"type": "array", "items": _FILE},
                "title": {"type": "string"},
            },
            "required": ["id", "base_version"],
        },
    },
    {
        "name": "visual_get",
        "title": "Leer visual",
        "description": "Devuelve el manifiesto de un visual (versión actual o la pedida) y el contenido de sus archivos de texto. "
                       "Con include_binary también los binarios en base64.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "version": {"type": "integer", "minimum": 0},
                "paths": {"type": "array", "items": {"type": "string"}, "description": "Limita a estas rutas"},
                "include_binary": {"type": "boolean", "default": False},
            },
            "required": ["id"],
        },
    },
    {
        "name": "visual_list",
        "title": "Listar visuals",
        "description": "Lista los visuals del usuario, del más reciente al más antiguo.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "kind": {"type": "string", "enum": list(store.KINDS)},
                "query": {"type": "string", "description": "Texto a buscar en el título"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20},
            },
        },
    },
    {
        "name": "visual_export",
        "title": "Pasar visual a código",
        "description": "Paquete para implementar un visual en el proyecto: instrucciones, páginas HTML y estilos completos, "
                       "y la lista de assets binarios (pídelos con visual_get include_binary si los necesitas).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "stack": {"type": "string", "description": "react, next, vue, html o una descripción libre; vacío = el del proyecto"},
            },
            "required": ["id"],
        },
    },
]

TOOLS += [
    {
        "name": "visual_render",
        "title": "Renderizar piezas",
        "description": "Encola el render a PNG o MP4 de las piezas de un visual (HTML con <meta name=\"render\">). "
                       "El servidor lo hace en segundo plano y guarda la salida como versión nueva; consulta el estado "
                       "con visual_render_status. Sin paths, renderiza todas las piezas.",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string"}, "paths": {"type": "array", "items": {"type": "string"}}},
            "required": ["id"],
        },
    },
    {
        "name": "visual_render_status",
        "title": "Estado de los renders",
        "description": "Últimos renders de un visual: queued, running, done (con la ruta y versión de la salida) o failed "
                       "(con el error). Con wait_seconds espera hasta que no quede ninguno pendiente (máx. 60 s).",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string"},
                           "wait_seconds": {"type": "integer", "minimum": 0, "maximum": MAX_WAIT_S, "default": 0}},
            "required": ["id"],
        },
    },
    {
        "name": "visual_view",
        "title": "Ver una pieza",
        "description": "Devuelve como imagen el PNG/JPG renderizado de una pieza para que puedas mirarlo y juzgar el diseño. "
                       "path puede ser la salida (post-1.png) o su HTML (post-1.html). Los vídeos no se pueden ver aquí.",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string"}, "path": {"type": "string"},
                           "version": {"type": "integer", "minimum": 0}},
            "required": ["id", "path"],
        },
    },
]

PROMPTS = [{
    "name": "visual",
    "title": "Visual",
    "description": "Diseña en Lixbon Visuals: crear («una landing para…»), editar («vis_… haz el título más grande») "
                   "o pasar a código («codigo vis_… react»).",
    "arguments": [{"name": "peticion", "description": "Qué quieres crear, editar o pasar a código", "required": False}],
}]


class RpcError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def _auth(request: Request, authorization: str | None) -> dict[str, Any]:
    try:
        return web_or_api_key_auth(request, None, authorization)
    except HTTPException as e:
        if e.status_code != 401:
            raise
        raise HTTPException(401, "Falta una API key de Lixbon válida (Authorization: Bearer lixbon_sk_…)",
                            headers={"WWW-Authenticate": 'Bearer realm="lixbon"'})


def _text_result(data: Any, is_error: bool = False) -> dict[str, Any]:
    text = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False, indent=2)
    out: dict[str, Any] = {"content": [{"type": "text", "text": text}], "isError": is_error}
    if isinstance(data, dict) and not is_error:
        out["structuredContent"] = data
    return out


def _require(args: dict, key: str, kind: type) -> Any:
    val = args.get(key)
    if not isinstance(val, kind) or (kind is str and not val.strip()):
        raise RpcError(-32602, f"Falta el parámetro «{key}» o no es válido")
    return val


def _normalize_id(raw: str) -> str:
    return raw.rstrip("/").split("/")[-1].strip()


def _files_payload(visual_id: str, user_id: int, version: int | None, paths: list[str] | None,
                   include_binary: bool) -> tuple[dict, list[dict]]:
    manifest = store.get_manifest(visual_id, user_id, version)
    if not manifest:
        raise store.VisualError("not_found", "Visual no encontrado", 404)
    texts = store.get_texts(visual_id, user_id, manifest["viewing"], paths) or {}
    if sum(len(t) for t in texts.values()) > MAX_TEXT_CHARS:
        raise store.VisualError("too_large", "El contenido es demasiado grande para una sola respuesta: pide rutas concretas con paths.")
    files = []
    budget = MAX_BINARY_BYTES
    for f in manifest["files"]:
        if paths and f["path"] not in paths:
            continue
        item = {k: f[k] for k in ("path", "role", "mime", "size", "version")}
        if f["path"] in texts:
            item["text"] = texts[f["path"]]
        elif include_binary and f["size"] <= budget:
            found = store.read_file(visual_id, f["path"], user_id=user_id, version=manifest["viewing"])
            if found:
                item["base64"] = base64.b64encode(found[1]).decode()
                budget -= f["size"]
        files.append(item)
    return manifest, files


def _call_tool(name: str, args: dict, user: dict[str, Any], base: str) -> dict[str, Any]:
    uid = user["id"]
    if name == "visual_create":
        res = svc.create(user, kind=args.get("kind") or "design", title=_require(args, "title", str),
                         files=decode_files(_require(args, "files", list)), origin="mcp", base=base)
        return {k: res[k] for k in ("id", "title", "kind", "version", "url")}
    if name == "visual_update":
        vid = _normalize_id(_require(args, "id", str))
        base_version = args.get("base_version")
        if not isinstance(base_version, int) or isinstance(base_version, bool):
            raise RpcError(-32602, "Falta base_version: lee el visual con visual_get y usa su versión")
        if not args.get("edits") and not args.get("files"):
            raise RpcError(-32602, "Envía edits o files")
        res = svc.write(user, vid, files=decode_files(args.get("files")) or None, edits=args.get("edits"),
                        base_version=base_version, title=args.get("title"), origin="mcp", base=base)
        return {k: res[k] for k in ("id", "title", "version", "files", "url")}
    if name == "visual_get":
        vid = _normalize_id(_require(args, "id", str))
        manifest, files = _files_payload(vid, uid, args.get("version"), args.get("paths"), bool(args.get("include_binary")))
        return {"id": vid, "title": manifest["title"], "kind": manifest["kind"], "version": manifest["viewing"],
                "latest_version": manifest["version"], "url": svc.url_for(vid, base), "files": files}
    if name == "visual_list":
        limit = args.get("limit") if isinstance(args.get("limit"), int) else 20
        items = store.list_visuals(uid, kind=args.get("kind"), query=args.get("query"), limit=max(1, min(limit, 100)))
        return {"items": [{"id": i["id"], "title": i["title"], "kind": i["kind"], "version": i["version"],
                           "updated_at": i["updated_at"], "url": svc.url_for(i["id"], base)} for i in items]}
    if name == "visual_export":
        vid = _normalize_id(_require(args, "id", str))
        manifest, files = _files_payload(vid, uid, None, None, False)
        pages = [f["path"] for f in files if f["path"].endswith(".html")]
        return {"id": vid, "title": manifest["title"], "version": manifest["version"],
                "instructions": export_instructions(manifest["title"], pages, args.get("stack")),
                "files": [f for f in files if "text" in f],
                "binary_assets": [f["path"] for f in files if "text" not in f]}
    if name == "visual_render":
        vid = _normalize_id(_require(args, "id", str))
        jobs = svc.request_render(user, vid, args.get("paths") or None, origin="mcp")
        return {"id": vid, "jobs": jobs}
    if name == "visual_render_status":
        vid = _normalize_id(_require(args, "id", str))
        jobs = renders.list_jobs(vid, uid)
        if jobs is None:
            raise store.VisualError("not_found", "Visual no encontrado", 404)
        return {"id": vid, "jobs": jobs}
    raise RpcError(-32602, f"Herramienta desconocida: {name}")


async def _wait_renders(visual_id: str, user_id: int, seconds: int) -> list[dict[str, Any]] | None:
    deadline = time.monotonic() + max(0, min(seconds, MAX_WAIT_S))
    while True:
        jobs = renders.list_jobs(visual_id, user_id)
        if jobs is None or not any(j["status"] in renders.ACTIVE for j in jobs) or time.monotonic() >= deadline:
            return jobs
        await asyncio.sleep(1)


def _view(args: dict, uid: int, base: str) -> dict[str, Any]:
    vid = _normalize_id(_require(args, "id", str))
    path = _require(args, "path", str).strip()
    manifest = store.get_manifest(vid, uid, args.get("version"))
    if not manifest:
        raise store.VisualError("not_found", "Visual no encontrado", 404)
    files = {f["path"]: f for f in manifest["files"]}
    if path.endswith(".html"):
        render = (files.get(path) or {}).get("render")
        if not render:
            raise store.VisualError("not_renderable", f"{path} no es una pieza (le falta <meta name=\"render\">)")
        path = renders.output_path_for(path, render["kind"])
    f = files.get(path)
    if not f:
        raise store.VisualError("not_rendered", f"{path} aún no existe: llama a visual_render y espera con visual_render_status")
    if f["mime"] not in VIEWABLE:
        raise store.VisualError("not_viewable", f"{path} es {f['mime']}: ábrelo en {svc.url_for(vid, base)}")
    if f["size"] > MAX_VIEW_BYTES:
        raise store.VisualError("too_large", f"{path} pesa demasiado para verlo aquí: ábrelo en {svc.url_for(vid, base)}")
    mime, data = store.read_file(vid, path, user_id=uid, version=manifest["viewing"])
    stale = any(src.get("render") and renders.output_path_for(p, src["render"]["kind"]) == path
                and (f.get("meta") or {}).get("source_sha256") not in (None, src["sha256"])
                for p, src in files.items())
    nota = f"{path} · versión {f['version']}" + (" · DESACTUALIZADA: su HTML cambió después del render" if stale else "")
    return {"content": [{"type": "image", "data": base64.b64encode(data).decode(), "mimeType": mime},
                        {"type": "text", "text": nota}], "isError": False}


async def _run_tool(name: str, args: dict, user: dict[str, Any], base: str) -> dict[str, Any]:
    """Resultado MCP de una herramienta (las que esperan o devuelven imágenes, aparte)."""
    try:
        if name == "visual_view":
            return _view(args, user["id"], base)
        if name == "visual_render_status" and args.get("wait_seconds"):
            vid = _normalize_id(_require(args, "id", str))
            wait = args["wait_seconds"]
            if not isinstance(wait, int) or isinstance(wait, bool):
                raise RpcError(-32602, "wait_seconds debe ser un entero")
            jobs = await _wait_renders(vid, user["id"], wait)
            if jobs is None:
                raise store.VisualError("not_found", "Visual no encontrado", 404)
            return _text_result({"id": vid, "jobs": jobs})
        return _text_result(_call_tool(name, args, user, base))
    except store.VisualError as e:
        return _text_result({"error": e.code, "message": e.message, **e.extra}, is_error=True)


async def _handle(msg: Any, user: dict[str, Any], base: str) -> dict[str, Any] | None:
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Petición JSON-RPC no válida"}}
    if "method" not in msg:
        return None  # respuesta del cliente a algo que no pedimos
    mid, method, params = msg.get("id"), msg["method"], msg.get("params") or {}
    if mid is None:
        return None  # notificación (notifications/initialized, cancelled…)
    try:
        if method == "initialize":
            asked = params.get("protocolVersion")
            result = {"protocolVersion": asked if asked in SUPPORTED_VERSIONS else SUPPORTED_VERSIONS[1],
                      "capabilities": {"tools": {"listChanged": False}, "prompts": {"listChanged": False}},
                      "serverInfo": SERVER_INFO, "instructions": INSTRUCTIONS}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": TOOLS}
        elif method == "tools/call":
            name = params.get("name")
            if name not in {t["name"] for t in TOOLS}:
                raise RpcError(-32602, f"Herramienta desconocida: {name}")
            result = await _run_tool(name, params.get("arguments") or {}, user, base)
        elif method == "prompts/list":
            result = {"prompts": PROMPTS}
        elif method == "prompts/get":
            if params.get("name") != "visual":
                raise RpcError(-32602, f"Prompt desconocido: {params.get('name')}")
            peticion = (params.get("arguments") or {}).get("peticion") or ""
            result = {"description": PROMPTS[0]["description"],
                      "messages": [{"role": "user", "content": {"type": "text", "text": visual_prompt(peticion)}}]}
        else:
            raise RpcError(-32601, f"Método no soportado: {method}")
    except RpcError as e:
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": e.code, "message": e.message}}
    return {"jsonrpc": "2.0", "id": mid, "result": result}


@router.post("/mcp")
async def mcp_post(request: Request, authorization: str | None = Header(default=None)):
    user = _auth(request, authorization)
    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JSONResponse({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "JSON no válido"}}, 400)
    base = str(request.base_url)
    if isinstance(body, list):
        replies = [r for r in [await _handle(m, user, base) for m in body] if r is not None]
        return JSONResponse(replies) if replies else Response(status_code=202)
    reply = await _handle(body, user, base)
    return JSONResponse(reply) if reply is not None else Response(status_code=202)


@router.api_route("/mcp", methods=["GET", "DELETE"])
async def mcp_other():
    return Response(status_code=405, headers={"Allow": "POST"})
