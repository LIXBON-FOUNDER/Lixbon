"""
ide_auth.py — Iniciar sesión en Lixbon IDE con la cuenta de lixbon.com.

El IDE no puede leer la sesión del navegador, y una app libre que cualquiera
puede compilar no puede repartir el secreto de una aplicación OAuth: iría dentro
del binario, a la vista. Así que el intercambio es al revés, y es este:

  1. El IDE abre un servidor efímero en 127.0.0.1, inventa un VERIFICADOR
     aleatorio y manda el navegador del sistema a

       /ide/connect?redirect_uri=http://127.0.0.1:<puerto>/callback
                   &state=<aleatorio>&challenge=<base64url(SHA-256(verificador))>
                   &method=S256

  2. lixbon.com, que sí sabe quién eres porque la sesión del navegador ya está
     iniciada, pide permiso y redirige de vuelta con un token de un solo uso.

  3. El IDE canjea ese token enseñando el verificador:

       POST /api/auth/ide/exchange  { token, verifier }  →  { api_key, user }

El verificador NUNCA pasa por el navegador: solo viaja su hash. Por eso un token
robado de la barra de direcciones no sirve de nada — quien lo canjee tiene que
demostrar que conoce el original.

El otro extremo está en `src/lib/lixbonAuth.js` del repo del IDE, y las cuatro
reglas del canje están en la sección 1 de `docs/team-protocolo.md`. Van citadas
aquí, una por una, donde se aplican.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import html
import logging
from typing import Any
from urllib.parse import urlencode, urlparse

from fastapi import APIRouter, Cookie, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel

from core.persistence.queries import (
    get_plan_for_user,
    get_user_by_id,
    create_web_session,
    log_audit_event,
    verify_user,
)
from core.persistence.team_queries import consumir_token_ide, emitir_token_ide
from core.security.auth import check_auth_rate_limit, clear_auth_attempts, record_failed_auth

logger = logging.getLogger("lixbon.ide-auth")
router = APIRouter()

PARAMS = ("redirect_uri", "state", "challenge", "method")


def _ip(peticion: Request) -> str:
    return peticion.client.host if peticion.client else "unknown"


def _redirect_valido(url: str) -> bool:
    """REGLA 1 — la vuelta solo puede ser al bucle local.

    Sin esto, cualquiera se lleva el token de un usuario a un servidor ajeno sin
    más que pasar su propia dirección como `redirect_uri`. No es una comprobación
    de comodidad: es la única que impide convertir esta página en un repartidor
    de sesiones a terceros."""
    try:
        u = urlparse(url)
    except ValueError:
        return False
    local = u.hostname in ("127.0.0.1", "::1", "localhost")
    return u.scheme == "http" and local and u.path == "/callback"


def _consulta(peticion: Request) -> dict[str, str]:
    return {k: peticion.query_params.get(k, "") for k in PARAMS}


# ── La página ──────────────────────────────────────────────────────────────
# Servida por el gateway y no por la SPA a propósito: el IDE abre el navegador
# en esta dirección y tiene que encontrar una página completa en la PRIMERA
# respuesta, sin depender de que arranque un router de cliente. Es también la
# razón de que el formulario de entrada esté aquí y no en /auth: aquel navega
# con react-router, que no sabe volver a una ruta del servidor.

_ESTILO = """
:root{color-scheme:light dark;
  --bg:#f2f1e3;--ink:#1b1a17;--surface:#fff;--border:#e4dfce;--muted:#a79e86;
  --accent:#6c7a46;--ring:rgba(108,122,70,.15);--on-ink:#f2f1e3;--danger:#c0392b}
@media (prefers-color-scheme:dark){:root{
  --bg:#1a1913;--ink:#f3f0e2;--surface:#211f17;--border:#33301f;--muted:#8e876f;
  --accent:#a9b86e;--ring:rgba(169,184,110,.15);--on-ink:#1a1913;--danger:#e08c7d}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
  background:var(--bg);color:var(--ink);
  font:15px/1.6 'Bricolage Grotesque',system-ui,-apple-system,sans-serif}
.caja{width:min(420px,100%);padding:30px 32px;border-radius:18px;
  background:var(--surface);border:1px solid var(--border)}
.marca{font:700 15px/1 'Bruno Ace SC',system-ui,sans-serif;letter-spacing:.12em;
  text-transform:uppercase;color:var(--ink);margin:0 0 22px}
h1{margin:0 0 8px;font-size:21px;font-weight:600;letter-spacing:-.01em}
p{margin:0 0 18px;font-size:13.5px;color:var(--muted)}
label{display:block;font-size:12px;color:var(--muted);margin:14px 0 6px}
input{width:100%;height:42px;padding:0 13px;border-radius:11px;font:inherit;
  background:var(--bg);color:var(--ink);border:1px solid var(--border);outline:none}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--ring)}
button{width:100%;height:44px;margin-top:22px;border:0;border-radius:999px;
  background:var(--ink);color:var(--on-ink);font:inherit;font-weight:600;cursor:pointer}
button:hover{opacity:.9}
button.sec{background:transparent;color:var(--muted);height:36px;margin-top:10px;
  border:1px solid var(--border);font-weight:500}
.dato{display:flex;justify-content:space-between;gap:14px;font-size:12.5px;
  padding:9px 0;border-top:1px solid var(--border)}
.dato b{font-weight:500;color:var(--muted)}
.dato span{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:62%}
.pie{margin:22px 0 0;font-size:11.5px;color:var(--muted);line-height:1.5}
.mal{color:var(--danger);font-size:13px;margin:0 0 4px}
"""


def _pagina(titulo: str, dentro: str, codigo: int = 200) -> HTMLResponse:
    return HTMLResponse(
        f'<!doctype html><html lang="es"><head><meta charset="utf-8">'
        f'<meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<title>{html.escape(titulo)} · lixbon</title><style>{_ESTILO}</style>'
        f'</head><body><main class="caja"><p class="marca">lixbon</p>{dentro}</main>'
        f"</body></html>",
        status_code=codigo,
    )


def _pagina_error(texto: str, codigo: int = 400) -> HTMLResponse:
    return _pagina("No se puede continuar",
                   f"<h1>No se puede continuar</h1><p class='mal'>{html.escape(texto)}</p>",
                   codigo)


def _pagina_entrar(consulta: dict[str, str], error: str = "") -> HTMLResponse:
    q = html.escape(urlencode(consulta))
    return _pagina("Entrar", f"""
      <h1>Inicia sesión para conectar el IDE</h1>
      <p>Lixbon IDE está esperando en tu equipo. Entra con tu cuenta de lixbon.com
         y podrás autorizarlo en el paso siguiente.</p>
      {f"<p class='mal'>{html.escape(error)}</p>" if error else ""}
      <form method="POST" action="/ide/connect/login?{q}">
        <label for="email">Correo</label>
        <input id="email" name="email" type="email" required autocomplete="username"
               autofocus spellcheck="false">
        <label for="pass">Contraseña</label>
        <input id="pass" name="password" type="password" required
               autocomplete="current-password">
        <button type="submit">Iniciar sesión</button>
      </form>
      <p class="pie">¿No tienes cuenta? Créala en lixbon.com y vuelve a intentarlo
         desde el IDE.</p>""")


def _pagina_autorizar(usuario: dict[str, Any], consulta: dict[str, str]) -> HTMLResponse:
    q = html.escape(urlencode(consulta))
    nombre = usuario.get("first_name") or usuario.get("username") or "tu cuenta"
    correo = usuario.get("email") or usuario.get("username") or ""
    return _pagina("Conectar el IDE", f"""
      <h1>Conectar Lixbon IDE</h1>
      <p>Este equipo pide acceso a tu cuenta de lixbon. Si no has sido tú, cierra
         esta pestaña sin autorizar.</p>
      <div class="dato"><b>Cuenta</b><span>{html.escape(str(correo))}</span></div>
      <div class="dato"><b>Nombre</b><span>{html.escape(str(nombre))}</span></div>
      <div class="dato"><b>Vuelve a</b><span>{html.escape(consulta['redirect_uri'])}</span></div>
      <form method="POST" action="/ide/connect/authorize?{q}">
        <button type="submit">Autorizar</button>
      </form>
      <form method="GET" action="/ide/connect/salir?{q}">
        <button class="sec" type="submit">Entrar con otra cuenta</button>
      </form>
      <p class="pie">El IDE recibirá un acceso de un solo uso y tendrá que
         canjearlo demostrando que conoce un secreto que nunca pasó por este
         navegador. Podrás revocarlo cuando quieras desde Cuenta → Claves.</p>""")


# ── Las rutas del navegador ────────────────────────────────────────────────

def _sesion(cookie: str | None) -> dict[str, Any] | None:
    from core.persistence.queries import validate_web_session
    return validate_web_session(cookie) if cookie else None


def _revisar(consulta: dict[str, str]) -> HTMLResponse | None:
    if not _redirect_valido(consulta["redirect_uri"]):
        return _pagina_error("La dirección de vuelta no apunta a este equipo. Rechazada.")
    # REGLA 2 — sin `challenge` no se emite nada. Si no hubiera nada que
    # verificar después, un token robado de la barra de direcciones valdría por
    # sí solo y todo lo demás sobraría.
    if not consulta["challenge"] or consulta["method"] != "S256":
        return _pagina_error("Falta el challenge, o el método no es S256.")
    return None


@router.get("/ide/connect", response_class=HTMLResponse)
async def ide_connect(peticion: Request, lixbon_session: str | None = Cookie(default=None)):
    consulta = _consulta(peticion)
    mal = _revisar(consulta)
    if mal:
        return mal
    usuario = _sesion(lixbon_session)
    if not usuario:
        return _pagina_entrar(consulta)
    return _pagina_autorizar(usuario, consulta)


@router.post("/ide/connect/login", response_class=HTMLResponse)
async def ide_connect_login(peticion: Request, email: str = Form(...), password: str = Form(...)):
    consulta = _consulta(peticion)
    mal = _revisar(consulta)
    if mal:
        return mal

    ip = _ip(peticion)
    check_auth_rate_limit(ip)
    usuario = verify_user(email.strip(), password)
    if not usuario:
        record_failed_auth(ip)
        return _pagina_entrar(consulta, "Correo o contraseña incorrectos.")

    clear_auth_attempts(ip)
    token = create_web_session(usuario["id"], ip, peticion.headers.get("user-agent"))
    log_audit_event("user_login", user_id=usuario["id"], ip_address=ip)

    # Se vuelve a /ide/connect con los MISMOS parámetros: el paso siguiente es
    # autorizar, igual que cuando ya había sesión.
    respuesta = RedirectResponse(f"/ide/connect?{urlencode(consulta)}", status_code=303)
    from core.gateway.routers.auth import COOKIE_SECURE, SESSION_COOKIE, SESSION_MAX_AGE
    respuesta.set_cookie(key=SESSION_COOKIE, value=token, httponly=True,
                         secure=COOKIE_SECURE, samesite="lax", max_age=SESSION_MAX_AGE)
    return respuesta


@router.get("/ide/connect/salir")
async def ide_connect_salir(peticion: Request, lixbon_session: str | None = Cookie(default=None)):
    from core.gateway.routers.auth import SESSION_COOKIE
    from core.persistence.queries import delete_web_session
    if lixbon_session:
        delete_web_session(lixbon_session)
    respuesta = RedirectResponse(f"/ide/connect?{urlencode(_consulta(peticion))}", status_code=303)
    respuesta.delete_cookie(SESSION_COOKIE)
    return respuesta


@router.post("/ide/connect/authorize")
async def ide_connect_authorize(peticion: Request, lixbon_session: str | None = Cookie(default=None)):
    consulta = _consulta(peticion)
    mal = _revisar(consulta)
    if mal:
        return mal
    usuario = _sesion(lixbon_session)
    if not usuario:
        return _pagina_error("La sesión ha caducado. Vuelve a empezar desde el IDE.", 401)

    token = emitir_token_ide(usuario["id"], consulta["challenge"], consulta["redirect_uri"])
    log_audit_event("ide_connect_authorized", user_id=usuario["id"], ip_address=_ip(peticion))

    destino = consulta["redirect_uri"]
    union = "&" if "?" in destino else "?"
    return RedirectResponse(
        f"{destino}{union}{urlencode({'token': token, 'state': consulta['state']})}",
        status_code=303,
    )


# ── El canje ───────────────────────────────────────────────────────────────

class Canje(BaseModel):
    token: str
    verifier: str


def _cuadra(challenge: str, verifier: str) -> bool:
    """REGLA 4 — el verificador tiene que corresponder al challenge, comparado en
    tiempo constante. Es lo que hace inútil un token robado: quien lo canjee
    tiene que conocer un secreto que nunca salió del equipo que empezó el
    flujo."""
    digest = hashlib.sha256(verifier.encode("utf-8")).digest()
    calculado = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return hmac.compare_digest(calculado, challenge)


@router.post("/api/auth/ide/exchange")
async def ide_exchange(cuerpo: Canje, peticion: Request):
    # REGLA 3 — el token es de un solo uso y se borra ANTES de comprobar nada
    # más, para que dos canjes simultáneos del mismo token no puedan darse.
    registro = consumir_token_ide(cuerpo.token.strip())
    if not registro:
        raise HTTPException(status_code=400, detail="El acceso ya no es válido.")
    if not _cuadra(registro["challenge"], cuerpo.verifier or ""):
        logger.warning("[ide-auth] verificador incorrecto: canje rechazado")
        raise HTTPException(status_code=400, detail="El verificador no corresponde.")

    usuario = get_user_by_id(registro["user_id"])
    if not usuario:
        raise HTTPException(status_code=400, detail="La cuenta ya no existe.")

    # La misma key con nombre que emite el login clásico del IDE: así los dos
    # caminos ROTAN la misma credencial en vez de acumular una por intento.
    from core.gateway.routers.auth import DESKTOP_KEY_NAME, issue_named_api_key
    api_key = issue_named_api_key(usuario["id"], DESKTOP_KEY_NAME, _ip(peticion))
    plan = get_plan_for_user(usuario["id"])
    logger.info("[ide-auth] canje correcto para el usuario %s", usuario["id"])
    return JSONResponse({
        "api_key": api_key,
        "user": {**usuario, "plan_id": plan["id"], "plan_name": plan["name"]},
    })
