"""Qué credencial llega a qué endpoint.

Una API key manual sirve para inferencia y lectura; gestionar la cuenta, las
keys, Team y los pagos exige una sesión (cookie web, access token de
dispositivo o, durante la transición, una key que emitió el login).

SQLite temporal: DATABASE_URL se fija ANTES de importar core.config, que la lee
en el import. El engine es global, así que este módulo no debe convivir en el
mismo proceso con pruebas que necesiten la BD real.
"""
import os
import pathlib
import shutil
import tempfile

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_alcances_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'alcances.db').as_posix()}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402
from sqlalchemy import update  # noqa: E402

from core.gateway import app as app_mod  # noqa: E402
from core.persistence import models, queries as q  # noqa: E402
from core.persistence.database import Base, get_engine, get_session  # noqa: E402
from core.persistence.models import Plan  # noqa: E402

CLAVE = "contrasena-larga-de-prueba"


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
    yield
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
def cred(_esquema):
    u = q.create_user("alcances@lixbon.test", CLAVE, "Alcances", "Prueba")
    q.set_user_plan(u["id"], "free")
    manual, _ = q.create_api_key("mi script", u["id"])
    app_key, _ = q.create_api_key("lixbon Desktop", u["id"], origin="login")
    sesion = q.create_device_session(u["id"], "cli")
    return {
        "id": u["id"],
        "manual": {"Authorization": f"Bearer {manual}"},
        "app_key": {"Authorization": f"Bearer {app_key}"},
        "access": {"Authorization": f"Bearer {sesion['access_token']}"},
        "sesion": sesion,
        "web": q.create_web_session(u["id"]),
    }


SOLO_SESION = [
    ("get", "/api/keys"),
    ("post", "/api/keys"),
    ("delete", "/api/account"),
    ("patch", "/api/account/profile"),
    ("get", "/api/account/settings"),
    ("get", "/api/team/bootstrap"),
    ("post", "/api/auth/api-key/regenerate"),
]

SESION_O_KEY = [
    ("get", "/api/auth/me"),
    ("get", "/api/key/info"),
    ("get", "/api/account/usage"),
    ("get", "/api/conversations"),
]


@pytest.mark.parametrize("metodo,ruta", SOLO_SESION)
def test_key_manual_no_gestiona_la_cuenta(cliente, cred, metodo, ruta):
    r = getattr(cliente, metodo)(ruta, headers=cred["manual"])
    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "session_required"


@pytest.mark.parametrize("metodo,ruta", SESION_O_KEY)
@pytest.mark.parametrize("quien", ["manual", "app_key", "access"])
def test_lectura_acepta_cualquier_credencial(cliente, cred, quien, metodo, ruta):
    r = getattr(cliente, metodo)(ruta, headers=cred[quien])
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("quien", ["app_key", "access"])
def test_sesiones_y_keys_de_login_gestionan_la_cuenta(cliente, cred, quien):
    assert cliente.get("/api/keys", headers=cred[quien]).status_code == 200
    assert cliente.get("/api/account/settings", headers=cred[quien]).status_code == 200


def test_cookie_web_gestiona_la_cuenta(cliente, cred):
    r = cliente.get("/api/keys", cookies={"lixbon_session": cred["web"]})
    assert r.status_code == 200


def test_access_caducado_da_401(cliente, cred):
    otra = q.create_device_session(cred["id"], "desktop")
    with get_session() as s:
        s.execute(update(models.Session).where(models.Session.id == otra["session_id"])
                  .values(expires_at=q._iso_in(seconds=-1)))
    r = cliente.get("/api/auth/me", headers={"Authorization": f"Bearer {otra['access_token']}"})
    assert r.status_code == 401


def test_access_no_vale_como_cookie(cliente, cred):
    r = cliente.get("/api/auth/me", cookies={"lixbon_session": cred["sesion"]["access_token"]})
    assert r.status_code == 401


def test_ws_team_acepta_access_token(cliente, cred):
    with cliente.websocket_connect(f"/ws/team?token={cred['sesion']['access_token']}") as ws:
        assert ws.receive_json() is not None


def test_ws_team_rechaza_key_manual(cliente, cred):
    llave = cred["manual"]["Authorization"].split(" ", 1)[1]
    with pytest.raises(WebSocketDisconnect) as e:
        with cliente.websocket_connect(f"/ws/team?token={llave}") as ws:
            ws.receive_json()
    assert e.value.code == 4401
