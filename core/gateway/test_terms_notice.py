# El aviso de términos va a todas las cuentas: lo caro es mandarlo dos veces a
# la misma persona o a quien no confirmó su correo.
import os
import pathlib
import shutil
import tempfile
import time

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_terminos_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'terminos.db').as_posix()}"
os.environ["PUBLIC_BASE_URL"] = "https://lixbon.com"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.gateway import app as app_mod  # noqa: E402
from core.gateway import email_templates as plantillas  # noqa: E402
from core.gateway.routers import admin_panel  # noqa: E402
from core.persistence import queries as q  # noqa: E402
from core.persistence.database import Base, get_engine, get_session  # noqa: E402
from core.persistence.models import User  # noqa: E402
from core.security.auth import admin_required  # noqa: E402

BUZON: list[dict] = []
CAMBIOS = [{"seccion": "Planes y pagos", "resumen": "Los créditos sin usar caducan a los 12 meses."}]


@pytest.fixture(scope="module", autouse=True)
def _esquema():
    Base.metadata.create_all(get_engine())
    with get_session() as s:
        for i, (verificado, activo) in enumerate([(1, 1), (1, 1), (0, 1), (1, 0)]):
            s.add(User(username=f"u{i}@t.test", email=f"u{i}@t.test", email_verified=verificado,
                       is_active=activo, password_hash="x", created_at=q.now_iso()))
    yield
    get_engine().dispose()
    shutil.rmtree(_DB_DIR, ignore_errors=True)


@pytest.fixture(scope="module")
def cliente(_esquema):
    async def capturar(to, **kwargs):
        BUZON.append({"to": to, **kwargs})
        return True

    original = admin_panel.send_terms_updated_email
    admin_panel.send_terms_updated_email = capturar
    admin_panel.problema_de_configuracion = lambda: None
    app_mod.init_db = lambda: None
    app_mod.versions.sync_versions_to_db = lambda: None
    app_mod.deps.orquestador.iniciar = lambda: None
    app_mod.deps.orquestador.detener = lambda: None
    app_mod.app.dependency_overrides[admin_required] = lambda: {"id": 1, "role": "admin"}
    with TestClient(app_mod.app) as c:
        yield c
    app_mod.app.dependency_overrides.clear()
    admin_panel.send_terms_updated_email = original


def _esperar(cliente):
    for _ in range(100):
        if not cliente.get("/api/admin/terms-notice").json()["envio"]["activo"]:
            return
        time.sleep(0.05)
    raise AssertionError("el envío no terminó")


def test_prueba_solo_va_a_una_direccion(cliente):
    BUZON.clear()
    r = cliente.post("/api/admin/terms-notice",
                     json={"vigencia": "2026-11-07", "cambios": CAMBIOS, "prueba": "yo@t.test"})
    assert r.status_code == 200
    assert [m["to"] for m in BUZON] == ["yo@t.test"]
    assert q.terms_notice_count("2026-11-07") == 0


def test_envio_solo_a_verificadas_y_activas_y_no_repite(cliente):
    BUZON.clear()
    r = cliente.post("/api/admin/terms-notice", json={"vigencia": "2026-11-07", "cambios": CAMBIOS})
    assert r.json()["destinatarios"] == 2
    _esperar(cliente)
    assert sorted(m["to"] for m in BUZON) == ["u0@t.test", "u1@t.test"]
    assert BUZON[0]["cambios"] == [("Planes y pagos", "Los créditos sin usar caducan a los 12 meses.")]

    BUZON.clear()
    r = cliente.post("/api/admin/terms-notice", json={"vigencia": "2026-11-07", "cambios": CAMBIOS})
    assert r.json()["destinatarios"] == 0
    assert BUZON == []

    estado = cliente.get("/api/admin/terms-notice", params={"vigencia": "2026-11-07"}).json()
    assert estado["avisados"] == 2 and estado["pendientes"] == 0


def test_sin_cambios_se_rechaza(cliente):
    r = cliente.post("/api/admin/terms-notice", json={"vigencia": "2026-11-07", "cambios": []})
    assert r.status_code == 422


def test_plantilla_lleva_cambios_fecha_e_imagenes():
    asunto, html, texto = plantillas.terminos_actualizados(
        vigencia="7 de noviembre de 2026",
        cambios=[("Planes <y> pagos", "Caducan a los 12 meses.")],
        url_terminos="https://lixbon.com/legal/terms", url_anterior=None,
        url_cuenta="https://lixbon.com/account")
    assert "términos" in asunto
    assert "7 de noviembre de 2026" in html and "7 de noviembre de 2026" in texto
    assert "Planes &lt;y&gt; pagos" in html
    assert "/email/hero-terminos.png" in html and "/email/logo.png" in html
    assert "versión anterior" not in html
