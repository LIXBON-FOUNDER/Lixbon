"""Archivos de un diseño de Visuals a partir de los mensajes de su conversación.

Mismo criterio que `apps/web/src/lib/visuals.js`: cada bloque de código es un
archivo si trae nombre (en el lenguaje del bloque, en la primera línea o en la
línea anterior) o si es HTML/SVG; cada respuesta es una versión y las páginas
que no reescribe se heredan de la anterior.
"""
from __future__ import annotations

import re
import unicodedata

FENCE = re.compile(r"(^|\n)([^\n]*)\n?```([^\n`]*)\n(.*?)(?:\n```|\Z)", re.S)
NOMBRE = re.compile(r"(?:^|[\s`*_(:])file:\s*([\w./-]+\.(?:html?|svg))\b", re.I)
NOMBRE_SUELTO = re.compile(r"^\s*([\w./-]+\.(?:html?|svg))\s*$", re.I)
TITULO = re.compile(r"<title>([^<]{1,40})</title>", re.I)


def _slug(texto: str) -> str:
    plano = unicodedata.normalize("NFD", texto).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", plano).strip("-") or "pagina"


def _limpiar(nombre: str) -> str:
    return re.sub(r'[\\:*?"<>|]', "_", re.sub(r"^\.?/", "", nombre.strip()))


def extract_files(texto: str) -> list[dict]:
    """Archivos de UNA respuesta, en orden."""
    out: list[dict] = []
    anonimos = 0
    for m in FENCE.finditer(texto or ""):
        previa, info, code = m.group(2) or "", (m.group(3) or "").strip(), m.group(4)
        name = None
        enc = NOMBRE.search(f" {info}")
        if enc:
            name = enc.group(1)
        if not name:
            lineas = code.split("\n")
            for i in range(min(2, len(lineas))):
                l = lineas[i]
                sin_marcas = re.sub(r"^\s*(<!--|//|#)\s*|\s*-->\s*$", "", l)
                d = NOMBRE.search(f" {l}") or NOMBRE_SUELTO.match(sin_marcas)
                if d:
                    name = d.group(1)
                    del lineas[i]
                    code = "\n".join(lineas)
                    break
                if l.strip():
                    break
        if not name:
            a = NOMBRE.search(f" {previa}")
            if a:
                name = a.group(1)
        es_html = bool(re.match(r"\s*(<!doctype|<html|<svg)", code, re.I)) or info.lower() in ("html", "svg", "xml")
        if not name and not es_html:
            continue
        if not name:
            if re.match(r"\s*<svg", code, re.I) or info.lower() == "svg":
                name = "logo.svg"
            else:
                t = TITULO.search(code)
                name = "index.html" if anonimos == 0 else f"{_slug(t.group(1) if t else f'pagina-{anonimos + 1}')}.html"
            anonimos += 1
        out.append({"name": _limpiar(name), "code": code})
    return out


def latest_version(messages: list[dict]) -> tuple[list[dict], int]:
    """(archivos de la última versión con las páginas heredadas, nº de versiones)."""
    versiones: list[list[dict]] = []
    for m in messages:
        if m.get("role") != "assistant":
            continue
        nuevos = extract_files(m.get("content") or "")
        if not nuevos:
            continue
        previos = versiones[-1] if versiones else []
        nombres = {f["name"] for f in nuevos}
        files = nuevos + [f for f in previos if f["name"] not in nombres]
        files.sort(key=lambda f: 0 if f["name"] == "index.html" else 1)
        versiones.append(files)
    return (versiones[-1] if versiones else []), len(versiones)
