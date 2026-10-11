"""
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
from typing import Any, Literal
from urllib.parse import urlencode, urlparse

from fastapi import APIRouter, Cookie, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel

# Al nivel del módulo y no dentro de la función: con `from __future__ import
# annotations`, Pydantic resuelve el Literal de Canje contra estos globales.
from core.gateway.routers.auth import CLI_KEY_NAME, DESKTOP_KEY_NAME
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

# Quién pide el acceso. El CLI usa el mismo flujo que el escritorio con
# `client=cli`; cambia solo cómo se habla en las páginas.
CLIENTES = {
    "ide": {"nombre": "Lixbon IDE", "corto": "el IDE", "volver": "desde el IDE"},
    "cli": {"nombre": "Lixbon CLI", "corto": "el CLI", "volver": "desde la terminal"},
}


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
    consulta = {k: peticion.query_params.get(k, "") for k in PARAMS}
    # `client` solo viaja si no es el de siempre: así las direcciones del
    # escritorio, que no lo mandan, quedan exactamente como estaban.
    if peticion.query_params.get("client") == "cli":
        consulta["client"] = "cli"
    return consulta


def _cliente(consulta: dict[str, str]) -> dict[str, str]:
    return CLIENTES[consulta.get("client", "ide")]


# Servida por el gateway y no por la SPA a propósito: el IDE abre el navegador
# en esta dirección y tiene que encontrar una página completa en la PRIMERA
# respuesta, sin depender de que arranque un router de cliente. Es también la
# razón de que el formulario de entrada esté aquí y no en /auth: aquel navega
# con react-router, que no sabe volver a una ruta del servidor.
#
# El aspecto copia el de /auth (apps/web/src/styles/auth.css y base.css): mismos
# tokens, tarjeta con pestaña, isotipo y fondo de clúster. Las fuentes son las
# self-hosted de la web en /fonts, del mismo origen.

_FUENTES = "".join(
    f"@font-face{{font-family:'{familia}';font-weight:{peso};font-display:swap;"
    f"src:url('/fonts/{archivo}-latin.woff2') format('woff2')}}"
    for familia, peso, archivo in (
        ("Geist", "300 700", "geist"),
        ("Geist Mono", "400 500", "geist-mono"),
        ("Bruno Ace SC", "400", "bruno-ace-sc"),
        ("Lancelot", "400", "lancelot"),
    )
)

_ESTILO = _FUENTES + """
:root{color-scheme:dark;
  --bg:#0E0E0E;--card:#161616;--field:#1C1C1C;--field-focus:#242424;--field-error:#241715;
  --s3:#1C1C1C;--s4:#232323;--ink:#F2F2F0;--soft:#B0B0AD;--muted:#7C7C79;--label:#6E6E6C;
  --accent:#B4C64E;--primary:#F2F2F0;--on-primary:#0E0E0E;--danger:#D4785F;
  --line:#232320;--nodo:#6E7A45;--gpu:#8CA038;--sombra:0 32px 80px rgba(0,0,0,.55)}
@media (prefers-color-scheme:light){:root{color-scheme:light;
  --bg:#F5F4EE;--card:#FBFAF6;--field:#ECEAE1;--field-focus:#E3E1D7;--field-error:#F6E3DF;
  --s3:#ECEAE1;--s4:#E3E1D7;--ink:#191917;--soft:#5B5B55;--muted:#8A8A82;--label:#8A8A82;
  --accent:#7E9430;--primary:#191917;--on-primary:#F5F4EE;--danger:#A33D28;
  --line:#CFCBBB;--nodo:#A3B068;--gpu:#7E9430;--sombra:0 30px 70px -20px rgba(60,52,30,.22)}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;position:relative;min-height:100dvh;display:flex;align-items:center;
  justify-content:center;padding:40px 16px;overflow-x:hidden;background:var(--bg);color:var(--ink);
  font:14px/1.5 'Geist','Segoe UI',system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
.cluster{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}
.cluster line{stroke:var(--line)}
.cluster circle{fill:var(--nodo);animation:latido 7s ease-in-out infinite}
.cluster circle.gpu{fill:var(--gpu)}
@keyframes latido{0%,100%{opacity:.38}50%{opacity:.72}}
.panel{position:relative;width:432px;max-width:100%;animation:entra .36s cubic-bezier(.32,.72,0,1)}
@keyframes entra{from{opacity:0;transform:translateY(14px)}}
.tab{display:block;width:104px;height:12px;margin-left:34px;border-radius:6px 6px 0 0;background:var(--card)}
.card{display:flex;flex-direction:column;gap:22px;padding:30px 32px 28px;border-radius:6px;
  background:var(--card);box-shadow:var(--sombra)}
.head{display:flex;flex-direction:column;align-items:center;gap:16px;text-align:center}
.logo{display:inline-flex;align-items:center;gap:9px;text-decoration:none}
.brand{font:20px/1 'Bruno Ace SC','Geist',sans-serif;letter-spacing:.02em;position:relative;top:.05em;color:var(--ink)}
h1{margin:0;font:400 34px/1.1 'Lancelot','Iowan Old Style',Georgia,serif;color:var(--ink)}
.sub{margin:-6px 0 0;font-size:13.5px;color:var(--muted);text-wrap:pretty}
form{margin:0;display:flex;flex-direction:column;gap:11px}
label{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--muted)}
input{height:46px;width:100%;padding:0 16px;border:0;border-radius:6px;background:var(--field);
  color:var(--ink);font:inherit;font-size:14px;outline:none;transition:background .18s ease}
input:focus{background:var(--field-focus)}
button,.boton{display:flex;align-items:center;justify-content:center;width:100%;height:46px;border:0;
  border-radius:6px;background:var(--primary);color:var(--on-primary);font:inherit;font-size:14px;
  font-weight:600;cursor:pointer;text-decoration:none;transition:opacity .15s ease}
button:hover{opacity:.88}
button.sec{background:var(--s3);color:var(--ink);font-weight:500}
button.sec:hover{opacity:1;background:var(--s4)}
button.texto{height:auto;background:none;color:var(--muted);font-size:12.5px;font-weight:400;padding:2px}
button.texto:hover{color:var(--accent)}
.acciones{display:flex;flex-direction:column;gap:10px}
.fila{display:flex;justify-content:center;gap:18px}
.divisor{display:flex;align-items:center;gap:12px;color:var(--label);font-size:11.5px}
.divisor::before,.divisor::after{content:'';flex:1;height:1px;background:var(--s4)}
.datos{display:flex;flex-direction:column;border-radius:6px;background:var(--s3);padding:4px 14px}
.dato{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:9px 0;font-size:12.5px}
.dato+.dato{border-top:1px solid var(--s4)}
.dato b{font-weight:400;color:var(--muted)}
.dato span{font-family:'Geist Mono',ui-monospace,SFMono-Regular,monospace;color:var(--ink);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:68%}
.error{padding:10px 14px;border-radius:6px;background:var(--field-error);color:var(--danger);font-size:13px}
.pie{margin:0;font-size:11.5px;color:var(--label);line-height:1.55;text-align:center;text-wrap:pretty}
@media (max-width:640px){body{align-items:flex-start;padding:24px 12px}
  .card{gap:18px;padding:26px 20px 24px}input{font-size:16px}}
@media (prefers-reduced-motion:reduce){.panel,.cluster circle{animation:none}}
"""

_ISOTIPO = """<svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true">
<rect width="32" height="32" rx="9" fill="#1B1A17"/>
<g stroke="#1B1A17" stroke-width=".9" stroke-linejoin="round">
<polygon points="16,3.2 3.2,16 16,16" fill="#DCD6BC"/><polygon points="16,3.2 28.8,16 16,16" fill="#C7BE9F"/>
<polygon points="3.2,16 16,28.8 16,16" fill="#4B5327"/><polygon points="28.8,16 16,28.8 16,16" fill="#333A1C"/></g>
<path d="M19.8 16C20.956 18.244 20.956 18.244 23.2 19.4C20.956 20.556 20.956 20.556 19.8 22.8C18.644 20.556 18.644 20.556 16.4 19.4C18.644 18.244 18.644 18.244 19.8 16Z" fill="#FCFAEF"/>
<circle cx="23.4" cy="22.6" r="1.1" fill="#FCFAEF"/></svg>"""

# El mismo clúster que ClusterFondo.jsx, sin las peticiones en vuelo.
_ARISTAS = ((130, 180, 300, 300), (300, 300, 170, 520), (170, 520, 340, 660), (340, 660, 120, 790),
            (130, 180, 170, 520), (300, 300, 340, 660), (700, 90, 300, 300), (700, 90, 1120, 160),
            (1120, 160, 1300, 290), (1300, 290, 1150, 500), (1150, 500, 1290, 690), (1290, 690, 1110, 810),
            (1120, 160, 1150, 500), (1150, 500, 1110, 810), (740, 830, 340, 660), (740, 830, 1290, 690))
_NODOS = ((130, 180, 0), (300, 300, 1), (170, 520, 0), (340, 660, 0), (120, 790, 0), (1120, 160, 0),
          (1300, 290, 0), (1150, 500, 1), (1290, 690, 0), (1110, 810, 0), (700, 90, 0), (740, 830, 0))
_CLUSTER = (
    '<svg class="cluster" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">'
    + "".join(f'<line x1="{a}" y1="{b}" x2="{c}" y2="{d}"/>' for a, b, c, d in _ARISTAS)
    + "".join(
        f'<circle{" class=" + chr(34) + "gpu" + chr(34) if gpu else ""} cx="{x}" cy="{y}" '
        f'r="{6 if gpu else 3.5}" style="animation-delay:{-0.9 * i:.1f}s"/>'
        for i, (x, y, gpu) in enumerate(_NODOS))
    + "</svg>"
)


def _pagina(titulo: str, cabecera: str, dentro: str, codigo: int = 200) -> HTMLResponse:
    return HTMLResponse(
        f'<!doctype html><html lang="es"><head><meta charset="utf-8">'
        f'<meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<title>{html.escape(titulo)} · lixbon</title><style>{_ESTILO}</style></head>'
        f'<body>{_CLUSTER}<div class="panel"><span class="tab" aria-hidden="true"></span>'
        f'<main class="card"><header class="head"><a class="logo" href="/" aria-label="lixbon.com">'
        f'{_ISOTIPO}<span class="brand">LIXBON</span></a>{cabecera}</header>{dentro}</main></div>'
        f"</body></html>",
        status_code=codigo,
    )


def _pagina_error(texto: str, codigo: int = 400) -> HTMLResponse:
    return _pagina("No se puede continuar", "<h1>No se puede continuar</h1>",
                   f"<p class='error'>{html.escape(texto)}</p>", codigo)


def _pagina_entrar(consulta: dict[str, str], error: str = "") -> HTMLResponse:
    q = html.escape(urlencode(consulta))
    c = _cliente(consulta)
    # Las cuentas de Google o GitHub no tienen contraseña: entran en la web y
    # vuelven aquí con la sesión ya iniciada. /auth hace una navegación completa
    # cuando `next` es una ruta /ide/.
    web = ""
    if consulta.get("client") == "cli":
        web = f"""
      <div class="divisor">o</div>
      <form method="GET" action="/auth">
        <input type="hidden" name="next" value="{html.escape('/ide/connect?' + urlencode(consulta))}">
        <button class="sec" type="submit">Entrar en lixbon.com · Google o GitHub</button>
      </form>"""
    return _pagina("Entrar", f"""
      <h1>Inicia sesión</h1>
      <p class="sub">{c['nombre']} está esperando en tu equipo. Entra con tu cuenta de
         lixbon.com y lo autorizas en el paso siguiente.</p>""", f"""
      {f"<p class='error'>{html.escape(error)}</p>" if error else ""}
      <form method="POST" action="/ide/connect/login?{q}">
        <label>Correo
          <input name="email" type="email" required autocomplete="username" autofocus
                 spellcheck="false" placeholder="tu@correo.com"></label>
        <label>Contraseña
          <input name="password" type="password" required autocomplete="current-password"></label>
        <div class="acciones" style="margin-top:11px"><button type="submit">Iniciar sesión</button></div>
      </form>{web}
      <p class="pie">¿Aún no tienes cuenta? Créala en lixbon.com y vuelve a intentarlo
         {c['volver']}.</p>""")


def _pagina_autorizar(usuario: dict[str, Any], consulta: dict[str, str]) -> HTMLResponse:
    q = html.escape(urlencode(consulta))
    c = _cliente(consulta)
    nombre = usuario.get("first_name") or usuario.get("username") or "tu cuenta"
    correo = usuario.get("email") or usuario.get("username") or ""
    # Cancelar solo existe para el CLI: el bucle local del escritorio no
    # entiende el parámetro `error` y se quedaría esperando.
    cancelar = f"""
          <form method="GET" action="/ide/connect/cancelar?{q}">
            <button class="texto" type="submit">Cancelar</button>
          </form>""" if consulta.get("client") == "cli" else ""
    return _pagina(f"Conectar {c['corto']}", f"""
      <h1>Conectar {c['nombre']}</h1>
      <p class="sub">Este equipo pide acceso a tu cuenta. Si no has sido tú, cierra esta
         pestaña sin autorizar.</p>""", f"""
      <div class="datos">
        <div class="dato"><b>Cuenta</b><span>{html.escape(str(correo))}</span></div>
        <div class="dato"><b>Nombre</b><span>{html.escape(str(nombre))}</span></div>
        <div class="dato"><b>Vuelve a</b><span>{html.escape(consulta['redirect_uri'])}</span></div>
      </div>
      <div class="acciones">
        <form method="POST" action="/ide/connect/authorize?{q}">
          <button type="submit">Autorizar</button>
        </form>
        <div class="fila">
          <form method="GET" action="/ide/connect/salir?{q}">
            <button class="texto" type="submit">Entrar con otra cuenta</button>
          </form>{cancelar}
        </div>
      </div>
      <p class="pie">{c['corto'][0].upper() + c['corto'][1:]} recibirá un acceso de un solo uso y tendrá que
         canjearlo con un secreto que nunca pasó por este navegador. Puedes revocarlo
         cuando quieras en Cuenta → Claves.</p>""")


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
    agente = peticion.headers.get("user-agent")
    token = create_web_session(usuario["id"], ip, agente)
    log_audit_event("user_login", user_id=usuario["id"], ip_address=ip)
    from core.gateway.routers.auth import avisar_si_acceso_inusual
    avisar_si_acceso_inusual(usuario, agente, ip)

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
        return _pagina_error(f"La sesión ha caducado. Vuelve a empezar {_cliente(consulta)['volver']}.", 401)

    token = emitir_token_ide(usuario["id"], consulta["challenge"], consulta["redirect_uri"])
    log_audit_event("ide_connect_authorized", user_id=usuario["id"], ip_address=_ip(peticion))

    destino = consulta["redirect_uri"]
    union = "&" if "?" in destino else "?"
    return RedirectResponse(
        f"{destino}{union}{urlencode({'token': token, 'state': consulta['state']})}",
        status_code=303,
    )


@router.get("/ide/connect/cancelar")
async def ide_connect_cancelar(peticion: Request):
    """Devuelve al CLI un «no» explícito para que deje de esperar."""
    consulta = _consulta(peticion)
    mal = _revisar(consulta)
    if mal:
        return mal
    destino = consulta["redirect_uri"]
    union = "&" if "?" in destino else "?"
    return RedirectResponse(
        f"{destino}{union}{urlencode({'error': 'access_denied', 'state': consulta['state']})}",
        status_code=303,
    )


class Canje(BaseModel):
    token: str
    verifier: str
    # Cada cliente rota su propia clave: con «lixbon CLI» el canje no desactiva
    # la del escritorio. Solo se aceptan estos dos nombres.
    key_name: Literal[DESKTOP_KEY_NAME, CLI_KEY_NAME] = DESKTOP_KEY_NAME


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

    # La misma key con nombre que emite el login clásico: así los dos caminos
    # ROTAN la misma credencial en vez de acumular una por intento.
    from core.gateway.routers.auth import issue_named_api_key
    api_key = issue_named_api_key(usuario["id"], cuerpo.key_name, _ip(peticion))
    plan = get_plan_for_user(usuario["id"])
    logger.info("[ide-auth] canje correcto para el usuario %s", usuario["id"])
    return JSONResponse({
        "api_key": api_key,
        "user": {**usuario, "plan_id": plan["id"], "plan_name": plan["name"]},
    })
