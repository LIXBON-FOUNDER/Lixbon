"""Archivos de un diseño de Visuals a partir de los mensajes de su conversación.

Mismo criterio que `apps/web/src/lib/visuals.js`: cada bloque de código es un
archivo si trae nombre (en el lenguaje del bloque, en la primera línea o en la
línea anterior) o si es HTML/SVG; un bloque edit:nombre trae pares
SEARCH/REPLACE sobre el archivo anterior; cada respuesta es una versión y las
páginas que no toca se heredan de la anterior.
"""
from __future__ import annotations

import re
import unicodedata

FENCE = re.compile(r"(^|\n)([^\n]*)\n?```([^\n`]*)\n(.*?)(?:\n```|\Z)", re.S)
NOMBRE = re.compile(r"(?:^|[\s`*_(:])file:\s*([\w./-]+\.(?:html?|svg))\b", re.I)
NOMBRE_SUELTO = re.compile(r"^\s*([\w./-]+\.(?:html?|svg))\s*$", re.I)
TITULO = re.compile(r"<title>([^<]{1,40})</title>", re.I)
EDIT_INFO = re.compile(r"^(?:edit|patch|diff):\s*([\w./-]+\.(?:html?|svg))$", re.I)
PAR = re.compile(r"<{5,9} *(?:SEARCH|BUSCAR)\n(.*?)\n={5,9}\n(.*?)\n>{5,9} *(?:REPLACE|REEMPLAZAR)", re.S)


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


def extract_edits(texto: str) -> list[dict]:
    """Bloques edit:nombre de UNA respuesta: [{name, pares: [(buscar, reemplazar)]}]."""
    out: list[dict] = []
    for m in FENCE.finditer(texto or ""):
        info = EDIT_INFO.match((m.group(3) or "").strip())
        if not info:
            continue
        out.append({"name": _limpiar(info.group(1)), "pares": PAR.findall(m.group(4))})
    return out


def _norm(linea: str) -> str:
    return " ".join(linea.split())


def apply_edits(code: str, pares: list[tuple[str, str]]) -> str:
    """Aplica pares SEARCH/REPLACE; ValueError con el fragmento que no encaja.
    Compara línea a línea sin espacios sobrantes (el modelo altera la
    indentación al copiar) y solo después prueba el texto exacto."""
    for buscar, reemplazar in pares:
        lineas = code.split("\n")
        buscadas = buscar.split("\n")
        objetivo = [_norm(l) for l in buscadas]
        idx = -1
        if buscar.strip():
            for i in range(len(lineas) - len(objetivo) + 1):
                if all(_norm(lineas[i + k]) == o for k, o in enumerate(objetivo)):
                    idx = i
                    break
        if idx >= 0:
            lineas[idx:idx + len(buscadas)] = reemplazar.split("\n")
            code = "\n".join(lineas)
        elif buscar and buscar in code:
            code = code.replace(buscar, reemplazar, 1)
        else:
            raise ValueError(buscadas[0].strip()[:60] or "(vacío)")
    return code


def latest_version(messages: list[dict]) -> tuple[list[dict], int]:
    """(archivos de la última versión con las páginas heredadas, nº de versiones).
    Una edición que no encaja se ignora: la página se queda como estaba."""
    versiones: list[list[dict]] = []
    for m in messages:
        if m.get("role") != "assistant":
            continue
        contenido = m.get("content") or ""
        nuevos = extract_files(contenido)
        previos = versiones[-1] if versiones else []
        for e in extract_edits(contenido):
            base = next((f for f in nuevos if f["name"] == e["name"]), None) or \
                next((f for f in previos if f["name"] == e["name"]), None)
            if not base:
                continue
            try:
                code = apply_edits(base["code"], e["pares"])
            except ValueError:
                continue
            if base in nuevos:
                base["code"] = code
            else:
                nuevos.append({"name": e["name"], "code": code})
        if not nuevos:
            continue
        nombres = {f["name"] for f in nuevos}
        files = nuevos + [f for f in previos if f["name"] not in nombres]
        files.sort(key=lambda f: 0 if f["name"] == "index.html" else 1)
        versiones.append(files)
    return (versiones[-1] if versiones else []), len(versiones)
