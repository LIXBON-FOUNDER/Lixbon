"""Proxy git (smart HTTP) entre el entorno de Coding y GitHub.

El contenedor nunca recibe el token de GitHub: su `git` habla con
`/api/coding/sessions/<sid>/git/…` usando el token acotado de la sesión, y el
gateway reenvía a `https://github.com/<repo>.git/…` con el token del usuario.
Así además:
- solo se alcanza el repo de la sesión (la ruta de GitHub la pone el gateway),
- un push solo puede tocar ramas `refs/heads/lixbon/…` (se leen las órdenes
  del receive-pack antes de reenviar nada): nunca la rama por defecto.
"""
from __future__ import annotations

import gzip
import io
import re
import zlib

PREFIJO_RAMA = "refs/heads/lixbon/"
MAX_PUSH = 200 * 1024 * 1024  # un push más grande no tiene sentido desde un entorno
_REF_VALIDA = re.compile(r"^refs/heads/lixbon/[A-Za-z0-9._/-]{1,120}$")


class PushRechazado(ValueError):
    pass


def ordenes_push(cuerpo: bytes) -> list[tuple[str, str, str]]:
    """Las órdenes (viejo, nuevo, ref) del principio de un git-receive-pack.

    Formato pkt-line: 4 dígitos hex de longitud (incluidos) + datos; la primera
    orden lleva las capacidades tras un NUL; termina en un flush "0000"."""
    ordenes: list[tuple[str, str, str]] = []
    i = 0
    while True:
        if i + 4 > len(cuerpo):
            raise PushRechazado("petición de push incompleta")
        try:
            n = int(cuerpo[i:i + 4], 16)
        except ValueError as exc:
            raise PushRechazado("petición de push no válida") from exc
        if n == 0:
            break
        if n < 4 or i + n > len(cuerpo):
            raise PushRechazado("petición de push no válida")
        linea = cuerpo[i + 4:i + n].split(b"\0", 1)[0].rstrip(b"\n").decode("utf-8", "replace")
        i += n
        if linea.startswith("shallow "):
            continue
        partes = linea.split(" ")
        if len(partes) != 3:
            raise PushRechazado("orden de push no válida")
        ordenes.append((partes[0], partes[1], partes[2]))
        if len(ordenes) > 50:
            raise PushRechazado("demasiadas ramas en un push")
    if not ordenes:
        raise PushRechazado("push vacío")
    return ordenes


def validar_push(cuerpo: bytes, gzip_encoded: bool = False) -> list[str]:
    """Las refs del push si TODAS son ramas lixbon/…; si no, PushRechazado."""
    if gzip_encoded:
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(cuerpo)) as comprimido:
                cuerpo = comprimido.read(MAX_PUSH + 1)
        except (OSError, EOFError, zlib.error) as exc:
            raise PushRechazado("push comprimido no válido") from exc
        if len(cuerpo) > MAX_PUSH:
            raise PushRechazado("El push descomprimido es demasiado grande")
    refs = []
    for _viejo, _nuevo, ref in ordenes_push(cuerpo):
        if not _REF_VALIDA.match(ref) or ".." in ref or ref.endswith(("/", ".lock")):
            raise PushRechazado(
                f"Las sesiones de Coding solo pueden subir ramas lixbon/…; rechazado: {ref}. "
                "Para llevar cambios a la rama principal, abre un PR.")
        refs.append(ref)
    return refs


def ruta_github(repo: str, resto: str) -> str:
    """URL de GitHub para `resto` (info/refs, git-upload-pack, git-receive-pack)."""
    if resto not in ("info/refs", "git-upload-pack", "git-receive-pack"):
        raise ValueError(resto)
    if not re.match(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", repo):
        raise ValueError(repo)
    return f"https://github.com/{repo}.git/{resto}"
