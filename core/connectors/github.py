"""
Conector de GitHub: una GitHub App que cada usuario instala y autoriza con SU
cuenta. El gateway guarda el token de usuario (user-to-server) cifrado y lo usa
solo en nombre de ese usuario.

Por qué una GitHub App y no la OAuth App del login:
  - El usuario elige a qué repos da acceso al instalarla y lo cambia cuando
    quiera desde GitHub (Settings › Applications).
  - Los permisos son finos (Contents, Pull requests, Issues), no el `repo`
    completo de una OAuth App.
  - El token de usuario caduca a las 8 h y se renueva con el refresh token.
  - Lo que el token puede tocar es la intersección de lo que la App tiene
    instalado y lo que el usuario puede hacer: GitHub lo garantiza.

Config por entorno (sin ella, el conector responde 503 y la web lo muestra
como «Pronto»):
  GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET / GITHUB_APP_SLUG
  CONNECTORS_SECRET_KEY (cifrado de los tokens)
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

import httpx
from starlette.concurrency import run_in_threadpool

from core.persistence import connectors as store
from core.security import cifrado

logger = logging.getLogger("lixbon.connectors.github")

PROVIDER = "github"
API = "https://api.github.com"
CLIENT_ID = os.getenv("GITHUB_APP_CLIENT_ID", "")
CLIENT_SECRET = os.getenv("GITHUB_APP_CLIENT_SECRET", "")
APP_SLUG = os.getenv("GITHUB_APP_SLUG", "")
# Margen para renovar antes de que caduque: una llamada larga no debe quedarse
# con un token que muere a mitad.
_RENOVAR_ANTES = timedelta(minutes=5)
_TIMEOUT = httpx.Timeout(30.0, connect=10.0)

# Un refresh token de GitHub sirve UNA vez: dos renovaciones en paralelo del
# mismo usuario dejarían a una de ellas con un token ya gastado y la conexión
# rota. El gateway corre en una instancia, así que basta un lock por usuario.
_locks: dict[int, asyncio.Lock] = {}


class GitHubError(Exception):
    """Error de GitHub con un mensaje que se le puede enseñar al modelo o al usuario."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


class NoConectado(GitHubError):
    def __init__(self, message: str = "Conecta tu cuenta de GitHub en Integraciones"):
        super().__init__(message, status=409)


def configurado() -> bool:
    return bool(CLIENT_ID and CLIENT_SECRET and APP_SLUG) and cifrado.disponible()


def url_instalar(state: str | None = None) -> str:
    url = f"https://github.com/apps/{APP_SLUG}/installations/new"
    return f"{url}?state={quote(state)}" if state else url


def url_administrar(instalaciones: list[dict[str, Any]] | None = None) -> str:
    """Donde el usuario cambia los repos o desinstala la App. Con una sola
    instalación, su página de ajustes directamente; con varias (su cuenta y
    organizaciones), la lista de instalaciones de su cuenta."""
    if instalaciones and len(instalaciones) == 1 and instalaciones[0].get("html_url"):
        return instalaciones[0]["html_url"]
    return "https://github.com/settings/installations"


def _iso_en(segundos: Any) -> str | None:
    try:
        s = int(segundos)
    except (TypeError, ValueError):
        return None
    return (datetime.now(timezone.utc) + timedelta(seconds=s)).isoformat()


def _caduca_pronto(iso: str | None) -> bool:
    if not iso:
        return False  # tokens sin caducidad (si la App la tiene desactivada)
    try:
        return datetime.fromisoformat(iso) - datetime.now(timezone.utc) < _RENOVAR_ANTES
    except ValueError:
        return True


# ── OAuth ─────────────────────────────────────────────────────────────────────

async def _token_endpoint(data: dict[str, str]) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.post(
            "https://github.com/login/oauth/access_token",
            data={"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET, **data},
            headers={"Accept": "application/json"},
        )
    body = resp.json() if resp.status_code == 200 else {}
    if not body.get("access_token"):
        raise GitHubError(f"GitHub rechazó el código ({body.get('error') or resp.status_code})")
    return body


def _campos_token(body: dict[str, Any]) -> dict[str, Any]:
    return {
        "access_token_enc": cifrado.cifrar(body["access_token"]),
        "refresh_token_enc": cifrado.cifrar(body["refresh_token"]) if body.get("refresh_token") else None,
        "access_expires_at": _iso_en(body.get("expires_in")),
        "refresh_expires_at": _iso_en(body.get("refresh_token_expires_in")),
    }


async def conectar(user_id: int, code: str, redirect_uri: str) -> dict[str, Any]:
    """Canjea el código del callback y guarda la conexión del usuario."""
    body = await _token_endpoint({"code": code, "redirect_uri": redirect_uri})
    perfil = await _peticion("GET", "/user", body["access_token"])
    fila = await run_in_threadpool(
        store.upsert_connector, user_id, PROVIDER,
        account_id=str(perfil.get("id") or ""),
        account_login=perfil.get("login"),
        account_avatar=perfil.get("avatar_url"),
        **_campos_token(body),
    )
    return fila


async def _renovar(fila: dict[str, Any]) -> str:
    refresh = cifrado.descifrar(fila.get("refresh_token_enc") or "")
    if not refresh:
        raise NoConectado("Tu conexión con GitHub caducó: vuelve a conectarla en Integraciones")
    try:
        body = await _token_endpoint({"grant_type": "refresh_token", "refresh_token": refresh})
    except GitHubError:
        # Refresh gastado, revocado o caducado (6 meses): no hay arreglo sin el usuario.
        await run_in_threadpool(store.delete_connector, fila["user_id"], PROVIDER)
        raise NoConectado("Tu conexión con GitHub caducó: vuelve a conectarla en Integraciones")
    await run_in_threadpool(store.update_tokens, fila["id"], **_campos_token(body))
    return body["access_token"]


async def token_de(user_id: int) -> str:
    """El token vigente del usuario, renovándolo si está por caducar."""
    if not configurado():
        raise GitHubError("El conector de GitHub no está configurado en este servidor", status=503)
    lock = _locks.setdefault(user_id, asyncio.Lock())
    async with lock:
        fila = await run_in_threadpool(store.get_connector, user_id, PROVIDER)
        if not fila:
            raise NoConectado()
        if _caduca_pronto(fila.get("access_expires_at")):
            return await _renovar(fila)
        token = cifrado.descifrar(fila["access_token_enc"])
        if not token:
            raise NoConectado("No se pudo leer tu conexión con GitHub: vuelve a conectarla")
        return token


async def desconectar(user_id: int) -> bool:
    """Revoca el token en GitHub (si se puede) y borra la conexión. La App
    sigue instalada en la cuenta del usuario hasta que la desinstale él."""
    fila = await run_in_threadpool(store.get_connector, user_id, PROVIDER)
    if not fila:
        return False
    token = cifrado.descifrar(fila["access_token_enc"])
    if token and CLIENT_ID and CLIENT_SECRET:
        basic = base64.b64encode(f"{CLIENT_ID}:{CLIENT_SECRET}".encode()).decode()
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                await client.request(
                    "DELETE", f"{API}/applications/{CLIENT_ID}/grant",
                    json={"access_token": token},
                    headers={"Authorization": f"Basic {basic}", "Accept": "application/vnd.github+json"},
                )
        except httpx.HTTPError as exc:
            logger.warning(f"[github] no se pudo revocar el token de user={user_id}: {exc}")
    return await run_in_threadpool(store.delete_connector, user_id, PROVIDER)


# ── API ───────────────────────────────────────────────────────────────────────

def _mensaje_error(resp: httpx.Response) -> str:
    try:
        body = resp.json()
        msg = body.get("message") or ""
        errores = body.get("errors") or []
        if errores and isinstance(errores, list):
            extra = "; ".join(str(e.get("message") or e.get("code") or e) if isinstance(e, dict) else str(e)
                              for e in errores[:3])
            msg = f"{msg} ({extra})" if msg else extra
    except Exception:
        msg = resp.text[:200]
    return f"GitHub {resp.status_code}: {msg or 'error'}"


async def _peticion(metodo: str, ruta: str, token: str, *, params: dict | None = None,
                    json: Any = None, accept: str = "application/vnd.github+json") -> Any:
    url = ruta if ruta.startswith("https://") else f"{API}{ruta}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": accept,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "lixbon-gateway",
    }
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.request(metodo, url, params=params, json=json, headers=headers)
    except httpx.HTTPError as exc:
        raise GitHubError(f"No se pudo contactar con GitHub: {exc}")
    if resp.status_code == 401:
        raise NoConectado("GitHub rechazó tu conexión: vuelve a conectarla en Integraciones")
    if resp.status_code == 403 and "not accessible by integration" in resp.text:
        # Falta un permiso en la App (o el usuario no aceptó el permiso nuevo
        # en su instalación). Reintentar no sirve: sin este aviso el modelo
        # repetía la misma llamada varias veces.
        raise GitHubError(
            "Permiso insuficiente: la App de Lixbon en GitHub no tiene permiso para esta acción. "
            "NO lo reintentes. Dile al usuario que el administrador debe activar el permiso necesario "
            "en la App (p. ej. «Pull requests: Read and write») y que él debe aceptarlo en su instalación.",
            status=403,
        )
    if resp.status_code >= 400:
        raise GitHubError(_mensaje_error(resp), status=resp.status_code)
    if resp.status_code == 204 or not resp.content:
        return None
    if accept.endswith(("diff", "raw")):
        return resp.text
    return resp.json()


class Cliente:
    """Llamadas a la API en nombre de un usuario. Pide el token en cada
    llamada (barato: va a BD solo si hay que renovar) para que un bucle largo
    del agente no se quede con uno caducado."""

    def __init__(self, user_id: int):
        self.user_id = user_id

    async def __call__(self, metodo: str, ruta: str, **kw: Any) -> Any:
        return await _peticion(metodo, ruta, await token_de(self.user_id), **kw)

    async def tarball(self, repo: str, ref: str, maximo: int = 60 * 1024 * 1024) -> bytes:
        """El repo entero comprimido (.tar.gz) en `ref`. GitHub redirige a
        codeload con un token propio en la URL; httpx quita la cabecera
        Authorization al cambiar de host. Corta si pasa de `maximo` bytes."""
        token = await token_de(self.user_id)
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                   "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "lixbon-gateway"}
        url = f"{API}/repos/{repo}/tarball/{quote(ref, safe='/')}"
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0), follow_redirects=True) as client:
                async with client.stream("GET", url, headers=headers) as resp:
                    if resp.status_code == 401:
                        raise NoConectado("GitHub rechazó tu conexión: vuelve a conectarla en Integraciones")
                    if resp.status_code >= 400:
                        await resp.aread()
                        raise GitHubError(_mensaje_error(resp), status=resp.status_code)
                    trozos, total = [], 0
                    async for trozo in resp.aiter_bytes():
                        total += len(trozo)
                        if total > maximo:
                            raise GitHubError(f"El repo pesa más de {maximo // (1024 * 1024)} MB comprimido", status=413)
                        trozos.append(trozo)
                    return b"".join(trozos)
        except httpx.HTTPError as exc:
            raise GitHubError(f"No se pudo descargar el repo de GitHub: {exc}")

    async def perfil(self) -> dict[str, Any]:
        return await self("GET", "/user")

    async def instalaciones(self) -> list[dict[str, Any]]:
        inst = await self("GET", "/user/installations", params={"per_page": 100})
        return [{"id": i["id"], "account": (i.get("account") or {}).get("login"), "html_url": i.get("html_url")}
                for i in (inst or {}).get("installations", [])]

    async def repos(self, limite: int = 300, instalaciones: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
        """Repos a los que la App tiene acceso Y el usuario también."""
        if instalaciones is None:
            instalaciones = await self.instalaciones()
        out: list[dict[str, Any]] = []
        vistos: set[str] = set()
        for i in instalaciones:
            pagina = 1
            while len(out) < limite:
                data = await self("GET", f"/user/installations/{i['id']}/repositories",
                                  params={"per_page": 100, "page": pagina})
                lote = (data or {}).get("repositories", [])
                for r in lote:
                    if r["full_name"] in vistos:
                        continue
                    vistos.add(r["full_name"])
                    out.append({
                        "full_name": r["full_name"],
                        "private": bool(r.get("private")),
                        "default_branch": r.get("default_branch") or "main",
                        "owner_avatar": (r.get("owner") or {}).get("avatar_url"),
                        "pushed_at": r.get("pushed_at"),
                    })
                if len(lote) < 100:
                    break
                pagina += 1
        out.sort(key=lambda r: r.get("pushed_at") or "", reverse=True)
        return out[:limite]

    async def tiene_instalacion(self) -> bool:
        inst = await self("GET", "/user/installations", params={"per_page": 1})
        return bool((inst or {}).get("total_count"))
