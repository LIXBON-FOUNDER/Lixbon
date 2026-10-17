# Las donaciones sustituyen a las suscripciones solo mientras el admin las
# tenga activas; la web lee el interruptor sin sesión.
import os
import pathlib
import shutil
import tempfile

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_donaciones_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'donaciones.db').as_posix()}"

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


def test_sin_fila_las_donaciones_estan_apagadas(cliente):
    r = cliente.get("/api/donations")
    assert r.status_code == 200
    assert r.json()["donations"] == {
        "enabled": False, "total_cents": 0, "goal_cents": 0, "updated_at": None, "paypal_business": "",
    }


def test_el_admin_las_activa_y_fija_el_total(cliente):
    r = cliente.patch("/api/admin/donations", json={"enabled": True, "total_cents": 481250})
    assert r.status_code == 200
    publico = cliente.get("/api/donations").json()["donations"]
    assert publico["enabled"] is True
    assert publico["total_cents"] == 481250


def test_cambiar_una_cosa_no_toca_la_otra(cliente):
    cliente.patch("/api/admin/donations", json={"enabled": False})
    d = cliente.get("/api/donations").json()["donations"]
    assert d["enabled"] is False
    assert d["total_cents"] == 481250


def test_la_meta_se_guarda_aparte_del_total(cliente):
    cliente.patch("/api/admin/donations", json={"goal_cents": 100000})
    d = cliente.get("/api/donations").json()["donations"]
    assert d["goal_cents"] == 100000
    assert d["total_cents"] == 481250
    assert cliente.patch("/api/admin/donations", json={"goal_cents": -1}).status_code == 422


def test_el_total_no_puede_ser_negativo(cliente):
    assert cliente.patch("/api/admin/donations", json={"total_cents": -5}).status_code == 422


def test_con_donaciones_activas_no_se_dan_de_alta_suscripciones(cliente, monkeypatch):
    from core.gateway.routers import payments
    from core.security.auth import session_required

    monkeypatch.setattr(payments.sg, "enabled", lambda: True)
    llamadas = []
    monkeypatch.setattr(payments.sg, "subscribe", lambda *a: llamadas.append(a) or {"status": "active"})
    app_mod.app.dependency_overrides[session_required] = lambda: {"id": 7, "email": "u@t.test"}
    try:
        cliente.patch("/api/admin/donations", json={"enabled": True})
        r = cliente.post("/api/billing/subscribe", json={"plan_id": "pro", "payment_method_id": "pm_1"})
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "subscriptions_paused"
        assert llamadas == []

        cliente.patch("/api/admin/donations", json={"enabled": False})
        r = cliente.post("/api/billing/subscribe", json={"plan_id": "pro", "payment_method_id": "pm_1"})
        assert r.status_code == 200
        assert len(llamadas) == 1
    finally:
        app_mod.app.dependency_overrides.pop(session_required, None)
