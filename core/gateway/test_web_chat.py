# El chat de lixbon.com se abre o se pone en pausa desde el admin; la web lee
# el interruptor sin sesión y, sin fila, lo da por en pausa.
import os
import pathlib
import shutil
import tempfile

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_chat_web_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'chat_web.db').as_posix()}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.gateway import app as app_mod  # noqa: E402
from core.persistence.database import Base, get_engine  # noqa: E402
from core.security.auth import admin_required  # noqa: E402


@pytest.fixture(scope="module")
def cliente():
    Base.metadata.create_all(get_engine())
    app_mod.init_db = lambda: None
    app_mod.versions.sync_versions_to_db = lambda: None
    app_mod.deps.orquestador.iniciar = lambda: None
    app_mod.deps.orquestador.detener = lambda: None
    app_mod.app.dependency_overrides[admin_required] = lambda: {"id": 1, "role": "admin"}
    with TestClient(app_mod.app) as c:
        yield c
    app_mod.app.dependency_overrides.clear()
    get_engine().dispose()
    shutil.rmtree(_DB_DIR, ignore_errors=True)


def test_sin_fila_el_chat_esta_en_pausa(cliente):
    r = cliente.get("/api/web-chat")
    assert r.status_code == 200
    assert r.json()["web_chat"] == {"enabled": False, "updated_at": None}


def test_el_admin_abre_y_cierra_el_chat(cliente):
    r = cliente.patch("/api/admin/web-chat", json={"enabled": True})
    assert r.status_code == 200
    assert r.json()["web_chat"]["enabled"] is True
    assert cliente.get("/api/web-chat").json()["web_chat"]["enabled"] is True

    r = cliente.patch("/api/admin/web-chat", json={"enabled": False})
    assert r.json()["web_chat"]["enabled"] is False
    assert cliente.get("/api/web-chat").json()["web_chat"]["enabled"] is False


def test_sin_valor_se_rechaza(cliente):
    assert cliente.patch("/api/admin/web-chat", json={}).status_code == 422
