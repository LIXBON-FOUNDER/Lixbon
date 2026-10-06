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


def sanear_html(code: str) -> str:
    """Mismos arreglos que `sanearHtml` en visuals.js: @apply en <style> sin
    type="text/tailwindcss" y la clase .focus-visible en vez del pseudo-selector."""
    if "cdn.tailwindcss.com" in code:
        code = re.sub(
            r"<style>(.*?)</style>",
            lambda m: f'<style type="text/tailwindcss">{m.group(1)}</style>' if re.search(r"@apply|@layer|theme\(", m.group(1)) else m.group(0),
            code, flags=re.S)
    return re.sub(r"(^|[\s,}])\.focus-visible(\s*[{,:])", r"\1:focus-visible\2", code)


def extract_files(texto: str) -> list[dict]:
    """Archivos de UNA respuesta, en orden."""
    out: list[dict] = []
    anonimos = 0
    for m in FENCE.finditer(texto or ""):
        previa, info, code = m.group(2) or "", (m.group(3) or "").strip(), m.group(4)
        name = None
        anonimo = False
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
                name = "index.html" if anonimos == 0 else f"{_slug(_primer_segmento(t.group(1)) if t else f'pagina-{anonimos + 1}')}.html"
                anonimo = anonimos > 0
            anonimos += 1
        out.append({"name": _limpiar(name), "code": sanear_html(code), **({"anonimo": True} if anonimo else {})})
    return _nombrar_por_enlaces(out)


# ── Nombres de las páginas sin nombre (mismo criterio que nombrarPorEnlaces) ─
# El nombre sacado del <title> rara vez coincide con los href de las otras
# páginas; se empareja cada página sin nombre con el destino de enlace que
# mejor encaja con su título y su <h1>.

VACIAS = {"para", "por", "con", "los", "las", "del", "una", "uno", "que", "mas", "the", "and", "for", "our", "your", "html", "htm", "page", "pagina"}
ENLACE = re.compile(r"""<a\b[^>]*\bhref\s*=\s*["']([^"'#?][^"']*)["'][^>]*>(.*?)</a>""", re.I | re.S)


def _primer_segmento(titulo: str) -> str:
    """«Proyectos | Nimbus Arquitectura» → «Proyectos»."""
    return re.split(r"\s+[|·—–:-]\s+|\s*[|·—–]\s*", titulo or "")[0].strip() or (titulo or "")


def _slug_simple(texto: str) -> str:
    plano = unicodedata.normalize("NFD", texto or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", plano).strip("-")


def _fichas(texto: str) -> set[str]:
    return {re.sub(r"(es|s)$", "", w) for w in _slug_simple(texto).split("-") if len(w) >= 3 and w not in VACIAS}


def _plano(html: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html or "")).strip()


def _rotulo(code: str) -> str:
    t = re.search(r"<title>([^<]{1,120})</title>", code or "", re.I)
    h = re.search(r"<h1\b[^>]*>(.{1,300}?)</h1>", code or "", re.I | re.S)
    return f"{t.group(1) if t else ''} {_plano(h.group(1)) if h else ''}".strip()


def _destinos(codigos: list[str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for code in codigos:
        for m in ENLACE.finditer(code or ""):
            href = m.group(1).strip()
            if re.match(r"([a-z][a-z0-9+.-]*:|//)", href, re.I):
                continue
            partes = [p for p in re.split(r"[?#]", href)[0].split("/") if p]
            ruta = partes[-1] if partes else ""
            if not ruta or (re.search(r"\.[a-z0-9]+$", ruta, re.I) and not re.search(r"\.html?$", ruta, re.I)):
                continue
            name = ruta if re.search(r"\.html?$", ruta, re.I) else f"{ruta}.html"
            out.setdefault(name, []).append(_plano(m.group(2)))
    return out


def _nombrar_por_enlaces(files: list[dict]) -> list[dict]:
    sueltos = [f for f in files if f.get("anonimo")]
    if not sueltos:
        return files
    destinos = _destinos([f["code"] for f in files])
    ocupados = {f["name"].lower() for f in files if not f.get("anonimo")}
    parejas = []
    for i, f in enumerate(sueltos):
        t = re.search(r"<title>([^<]{1,120})</title>", f["code"], re.I)
        principal = _slug_simple(_primer_segmento(t.group(1))) if t else ""
        propias = _fichas(f"{_rotulo(f['code'])} {f['name']}")
        for destino, textos in destinos.items():
            if destino.lower() in ocupados:
                continue
            base = _slug_simple(re.sub(r"\.html?$", "", destino, flags=re.I))
            puntos = 0
            if principal and base == principal:
                puntos += 100
            if principal and any(_slug_simple(tx) == principal for tx in textos):
                puntos += 60
            puntos += 10 * len(_fichas(f"{base} {' '.join(textos)}") & propias)
            if puntos > 0:
                parejas.append((puntos, i, destino))
    parejas.sort(key=lambda p: -p[0])  # estable: a igualdad, el orden de aparición
    asignado: dict[int, str] = {}
    for _, i, destino in parejas:
        if i in asignado or destino.lower() in ocupados:
            continue
        asignado[i] = destino
        ocupados.add(destino.lower())
    sin_pareja = [i for i in range(len(sueltos)) if i not in asignado]
    libres = [d for d in destinos if d.lower() not in ocupados]
    if len(sin_pareja) == 1 and len(libres) == 1:
        asignado[sin_pareja[0]] = libres[0]
        ocupados.add(libres[0].lower())
    out = []
    for f in files:
        if not f.get("anonimo"):
            out.append(f)
            continue
        i = sueltos.index(f)
        name = asignado.get(i, f["name"])
        if i not in asignado and name.lower() in ocupados:
            name = re.sub(r"\.html$", "-2.html", name)
        ocupados.add(name.lower())
        out.append({"name": name, "code": f["code"]})
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
