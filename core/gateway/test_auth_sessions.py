"""El login ya no crea API keys: las apps reciben una sesión de dispositivo.

Clientes nuevos (`client`) obtienen access + refresh; los anteriores
(`issue_api_key` o el canje del IDE sin `client`) reciben en `api_key` un access
legacy de 90 días. Ninguno de los dos caminos escribe en `api_keys`.

SQLite temporal: DATABASE_URL se fija ANTES de importar core.config, que la lee
en el import. El engine es global, así que este módulo no debe convivir en el
mismo proceso con pruebas que necesiten la BD real.
"""
import base64
import hashlib
import os
import pathlib
import shutil
import tempfile
import time

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_login_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'login.db').as_posix()}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import func, select  # noqa: E402

from core.gateway import app as app_mod  # noqa: E402
from core.gateway import email as correo  # noqa: E402
from core.gateway.routers import oauth  # noqa: E402
from core.persistence import models, queries as q  # noqa: E402
from core.persistence.database import Base, get_engine, get_session  # noqa: E402
from core.persistence.models import Plan  # noqa: E402

CLAVE = "contrasena-larga-de-prueba"
CORREO = "sesiones@lixbon.test"


@pytest.fixture(scope="module", autouse=True)
def _esquema():
    # create_all y no init_db: sus migraciones son sintaxis Postgres.
    Base.metadata.create_all(get_engine())
    with get_session() as s:
        if not s.get(Plan, "free"):
            s.add(Plan(id="free", name="Gratuito", description="", price_monthly_cents=0,
                       currency="USD", messages_per_day=30, tokens_per_month=150000,
                       max_api_keys=5, rate_limit_per_min=1000, allowed_models=None,
                       priority=0, sort_order=0, is_active=1,
                       created_at=q.now_iso(), updated_at=q.now_iso()))
    envio = correo.send_email

    async def nada(*_a, **_k):
        return True

    correo.send_email = nada
    yield
    correo.send_email = envio
    get_engine().dispose()
    shutil.rmtree(_DB_DIR, ignore_errors=True)


@pytest.fixture(scope="module")
def cliente(_esquema):
    app_mod.init_db = lambda: None
    app_mod.versions.sync_versions_to_db = lambda: None
    app_mod.deps.orquestador.iniciar = lambda: None
    app_mod.deps.orquestador.detener = lambda: None
    with TestClient(app_mod.app) as c:
        yield c


@pytest.fixture(scope="module")
def uid(_esquema):
    u = q.create_user(CORREO, CLAVE, "Ses", "Iones")
    q.set_user_plan(u["id"], "free")
    return u["id"]


@pytest.fixture(autouse=True)
def _sin_cookies(cliente):
    cliente.cookies.clear()
    yield
    cliente.cookies.clear()


def _keys(uid) -> int:
    with get_session() as s:
        return s.scalar(select(func.count(models.ApiKey.id)).where(models.ApiKey.user_id == uid))


def _login(cliente, **extra):
    return cliente.post("/api/auth/login", json={"email": CORREO, "password": CLAVE, **extra})


def _bearer(token):
    return {"Authorization": f"Bearer {token}"}


def test_login_web_da_cookie_y_ninguna_key(cliente, uid):
    antes = _keys(uid)
    r = _login(cliente)
    assert r.status_code == 200
    assert "api_key" not in r.json()
    assert r.cookies.get("lixbon_session")
    assert _keys(uid) == antes


def test_login_de_app_nueva_da_access_y_refresh(cliente, uid):
    antes = _keys(uid)
    r = _login(cliente, client="desktop", device_name="PC de casa")
    assert r.status_code == 200
    body = r.json()
    assert body["access_token"].startswith("lixbon_at_")
    assert body["refresh_token"].startswith("lixbon_rt_")
    assert body["token_type"] == "Bearer" and body["expires_in"] == q.ACCESS_TOKEN_MINUTES * 60
    assert "api_key" not in body and "lixbon_session" not in r.cookies
    assert _keys(uid) == antes
    assert cliente.get("/api/keys", headers=_bearer(body["access_token"])).status_code == 200


def test_cliente_desconocido_se_rechaza(cliente, uid):
    assert _login(cliente, client="tostadora").status_code == 422


@pytest.mark.parametrize("key_name", [None, "lixbon CLI", "Lixbon Mobile"])
def test_cliente_anterior_recibe_api_key_que_es_una_sesion(cliente, uid, key_name):
    antes = _keys(uid)
    extra = {"issue_api_key": True, **({"key_name": key_name} if key_name else {})}
    r = _login(cliente, **extra)
    assert r.status_code == 200
    llave = r.json()["api_key"]
    assert llave.startswith("lixbon_at_") and "refresh_token" not in r.json()
    assert _keys(uid) == antes
    for ruta in ("/api/auth/me", "/api/key/info", "/api/keys", "/api/team/bootstrap"):
        assert cliente.get(ruta, headers=_bearer(llave)).status_code == 200, ruta
    with cliente.websocket_connect(f"/ws/team?token={llave}") as ws:
        assert ws.receive_json() is not None


def test_login_anterior_retira_la_key_que_tenia_esa_app(cliente, uid):
    vieja, _ = q.create_api_key("lixbon CLI", uid, origin="login")
    manual, _ = q.create_api_key("lixbon CLI", uid)  # manual con el mismo nombre: no se toca
    assert _login(cliente, issue_api_key=True, key_name="lixbon CLI").status_code == 200
    assert cliente.get("/api/auth/me", headers=_bearer(vieja)).status_code == 401
    assert cliente.get("/api/auth/me", headers=_bearer(manual)).status_code == 200


def test_refresh_rota_el_par(cliente, uid):
    t1 = _login(cliente, client="cli").json()
    r = cliente.post("/api/auth/refresh", json={"refresh_token": t1["refresh_token"]})
    assert r.status_code == 200
    t2 = r.json()
    assert t2["user"]["id"] == uid and t2["session_id"] == t1["session_id"]
    assert cliente.get("/api/auth/me", headers=_bearer(t1["access_token"])).status_code == 401
    assert cliente.get("/api/auth/me", headers=_bearer(t2["access_token"])).status_code == 200

    otra_vez = cliente.post("/api/auth/refresh", json={"refresh_token": t1["refresh_token"]})
    assert otra_vez.status_code == 409 and otra_vez.json()["detail"]["error"] == "refresh_race"


def test_refresh_invalido_da_401(cliente):
    r = cliente.post("/api/auth/refresh", json={"refresh_token": "lixbon_rt_inventado"})
    assert r.status_code == 401 and r.json()["detail"]["error"] == "invalid_refresh"


def test_logout_con_access_cierra_solo_esa_sesion(cliente, uid):
    a = _login(cliente, client="desktop").json()
    b = _login(cliente, client="desktop").json()
    assert cliente.post("/api/auth/logout", headers=_bearer(a["access_token"])).status_code == 200
    assert cliente.get("/api/auth/me", headers=_bearer(a["access_token"])).status_code == 401
    assert cliente.post("/api/auth/refresh", json={"refresh_token": a["refresh_token"]}).status_code == 401
    assert cliente.get("/api/auth/me", headers=_bearer(b["access_token"])).status_code == 200


def test_logout_con_refresh_en_el_cuerpo(cliente, uid):
    t = _login(cliente, client="mobile").json()
    assert cliente.post("/api/auth/logout", json={"refresh_token": t["refresh_token"]}).status_code == 200
    assert cliente.get("/api/auth/me", headers=_bearer(t["access_token"])).status_code == 401


def test_logout_no_revoca_api_keys(cliente, uid):
    manual, _ = q.create_api_key("integración", uid)
    assert cliente.post("/api/auth/logout", headers=_bearer(manual)).status_code == 200
    assert cliente.get("/api/key/info", headers=_bearer(manual)).status_code == 200


def test_listar_y_revocar_sesiones(cliente, uid):
    yo = _login(cliente, client="desktop", device_name="este").json()
    otra = _login(cliente, client="cli", device_name="otra").json()
    lista = cliente.get("/api/auth/sessions", headers=_bearer(yo["access_token"])).json()["sessions"]
    por_id = {s["id"]: s for s in lista}
    assert por_id[yo["session_id"]]["current"] is True
    assert por_id[otra["session_id"]]["device_name"] == "otra"

    r = cliente.delete(f"/api/auth/sessions/{otra['session_id']}", headers=_bearer(yo["access_token"]))
    assert r.status_code == 200
    assert cliente.get("/api/auth/me", headers=_bearer(otra["access_token"])).status_code == 401
    assert cliente.delete(f"/api/auth/sessions/{otra['session_id']}",
                          headers=_bearer(yo["access_token"])).status_code == 404


def test_cerrar_las_demas_conserva_la_actual(cliente, uid):
    otra = _login(cliente, client="mobile").json()
    yo = _login(cliente, client="desktop").json()
    r = cliente.delete("/api/auth/sessions", headers=_bearer(yo["access_token"]))
    assert r.status_code == 200 and r.json()["revoked"] >= 1
    assert cliente.get("/api/auth/me", headers=_bearer(yo["access_token"])).status_code == 200
    assert cliente.get("/api/auth/me", headers=_bearer(otra["access_token"])).status_code == 401


def test_una_key_manual_no_ve_las_sesiones(cliente, uid):
    manual, _ = q.create_api_key("script", uid)
    r = cliente.get("/api/auth/sessions", headers=_bearer(manual))
    assert r.status_code == 403


def test_regenerar_rota_solo_la_credencial_que_llama(cliente, uid):
    manual, _ = q.create_api_key("no se toca", uid)
    escritorio = _login(cliente, client="desktop").json()
    movil = _login(cliente, issue_api_key=True, key_name="Lixbon Mobile").json()["api_key"]

    r = cliente.post("/api/auth/api-key/regenerate", headers=_bearer(movil))
    assert r.status_code == 200
    nueva = r.json()["newApiKey"]
    assert nueva.startswith("lixbon_at_")
    assert cliente.get("/api/auth/me", headers=_bearer(movil)).status_code == 401
    assert cliente.get("/api/auth/me", headers=_bearer(nueva)).status_code == 200
    assert cliente.get("/api/key/info", headers=_bearer(manual)).status_code == 200
    assert cliente.get("/api/auth/me", headers=_bearer(escritorio["access_token"])).status_code == 200


def test_regenerar_desde_la_web_no_aplica(cliente, uid):
    _login(cliente)
    assert cliente.post("/api/auth/api-key/regenerate").status_code == 400


def _reto(verificador: str) -> str:
    digest = hashlib.sha256(verificador.encode()).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def _token_ide(cliente, verificador: str) -> str:
    params = {"redirect_uri": "http://127.0.0.1:53127/callback", "state": "xyz",
              "challenge": _reto(verificador), "method": "S256", "client": "cli"}
    cliente.post("/ide/connect/login", params=params,
                 data={"email": CORREO, "password": CLAVE}, follow_redirects=False)
    r = cliente.post("/ide/connect/authorize", params=params, follow_redirects=False)
    cliente.cookies.clear()
    return r.headers["location"].split("token=")[1].split("&")[0]


def test_canje_del_ide_con_client_da_access_y_refresh(cliente, uid):
    antes = _keys(uid)
    token = _token_ide(cliente, "verificador-del-cli")
    r = cliente.post("/api/auth/ide/exchange",
                     json={"token": token, "verifier": "verificador-del-cli", "client": "cli",
                           "device_name": "portátil"})
    assert r.status_code == 200
    body = r.json()
    assert body["refresh_token"].startswith("lixbon_rt_") and body["user"]["id"] == uid
    assert _keys(uid) == antes
    sesion = q.validate_access_token(body["access_token"])
    assert sesion["client"] == "cli"


def test_canje_oauth_de_app(cliente, uid):
    antes = _keys(uid)
    verificador = "verificador-oauth-de-la-app"
    codigo = "codigo-de-prueba-oauth-123456"
    oauth._login_codes[codigo] = (uid, _reto(verificador), time.time() + 60)
    r = cliente.post("/api/auth/oauth/exchange",
                     json={"code": codigo, "code_verifier": verificador, "client": "mobile"})
    assert r.status_code == 200
    assert r.json()["access_token"].startswith("lixbon_at_")
    assert "lixbon_session" not in r.cookies
    assert _keys(uid) == antes
