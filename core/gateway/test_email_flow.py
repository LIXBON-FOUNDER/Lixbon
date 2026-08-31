# Prueba de los correos transaccionales: no que el HTML sea bonito, sino QUÉ
# correo sale y CUÁNDO. Los tres fallos caros aquí son mandar dos correos al
# registrarse, avisar de "dispositivo nuevo" cada vez que alguien vuelve a
# entrar, y repetir el correo de suscripción en cada renovación mensual.
#
# SQLite temporal: DATABASE_URL se fija ANTES de importar core.config, que la
# lee en el import. El engine es global, así que este módulo no debe convivir en
# el mismo proceso con pruebas que necesiten la BD real.
import os
import pathlib
import re
import shutil
import tempfile

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_correo_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'correo.db').as_posix()}"
os.environ["PUBLIC_BASE_URL"] = "https://lixbon.com"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.gateway import app as app_mod  # noqa: E402
from core.gateway import email as correo  # noqa: E402
from core.persistence import queries as q  # noqa: E402
from core.persistence.database import Base, get_engine, get_session  # noqa: E402
from core.persistence.models import Plan  # noqa: E402

CHROME = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "Chrome/141.0.0.0 Safari/537.36")
FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0"
CLAVE = "contrasena-larga-de-prueba"

BUZON: list[dict] = []


@pytest.fixture(scope="module", autouse=True)
def _esquema():
    # create_all y no init_db: sus migraciones son sintaxis Postgres.
    Base.metadata.create_all(get_engine())
    with get_session() as s:
        if not s.get(Plan, "free"):
            s.add(Plan(id="free", name="Gratuito", description="", price_monthly_cents=0,
                       currency="USD", messages_per_day=30, tokens_per_month=150000,
                       max_api_keys=1, rate_limit_per_min=1000, allowed_models=None,
                       priority=0, sort_order=0, is_active=1,
                       created_at=q.now_iso(), updated_at=q.now_iso()))
    yield
    get_engine().dispose()
    shutil.rmtree(_DB_DIR, ignore_errors=True)


@pytest.fixture(scope="module", autouse=True)
def _buzon(_esquema):
    async def capturar(to, subject, html, text=""):
        BUZON.append({"to": to, "asunto": subject, "html": html, "texto": text})
        return True

    correo.send_email = capturar
    yield BUZON


@pytest.fixture(scope="module")
def cliente(_esquema):
    app_mod.init_db = lambda: None
    app_mod.versions.sync_versions_to_db = lambda: None
    app_mod.deps.orquestador.iniciar = lambda: None
    app_mod.deps.orquestador.detener = lambda: None
    # client=: sin una IP real, request.client.host sería "testclient" y el
    # recorte de la dirección no se estaría probando.
    with TestClient(app_mod.app, client=("187.190.24.91", 50000)) as c:
        yield c


@pytest.fixture(scope="module")
def registrada(cliente):
    BUZON.clear()
    r = cliente.post("/api/auth/register", json={
        "first_name": "Ana", "last_name": "Prueba",
        "email": "ana@lixbon.test", "password": CLAVE},
        headers={"user-agent": CHROME})
    assert r.status_code == 200
    return list(BUZON)


@pytest.fixture(scope="module")
def verificada(cliente, registrada):
    token = re.search(r"verify-email\?token=([A-Za-z0-9_-]+)", registrada[0]["html"]).group(1)
    BUZON.clear()
    r = cliente.get(f"/api/auth/verify-email?token={token}", follow_redirects=False)
    assert r.status_code == 303
    return list(BUZON)


def _entrar(cliente, agente: str):
    BUZON.clear()
    return cliente.post("/api/auth/login",
                        json={"email": "ana@lixbon.test", "password": CLAVE},
                        headers={"user-agent": agente})


def test_al_registrarse_sale_un_solo_correo(registrada):
    assert len(registrada) == 1
    assert "Verifica tu correo" in registrada[0]["asunto"]


def test_el_enlace_del_correo_verifica_de_verdad(verificada):
    assert len(verificada) == 1


def test_la_bienvenida_llega_al_verificar_y_no_antes(verificada):
    assert "Ya estás dentro" in verificada[0]["asunto"]
    assert "Plan Gratuito" in verificada[0]["html"]
    assert "30 mensajes al día" in verificada[0]["html"]


def test_el_equipo_del_registro_no_dispara_aviso(cliente, verificada):
    assert _entrar(cliente, CHROME).status_code == 200
    assert BUZON == []


def test_un_equipo_nuevo_avisa_una_sola_vez(cliente, verificada):
    assert _entrar(cliente, FIREFOX).status_code == 200
    assert len(BUZON) == 1
    aviso = BUZON[0]
    assert "Nuevo inicio de sesión" in aviso["asunto"]
    assert "Firefox en Linux" in aviso["html"]
    assert "187.190.24.•••" in aviso["html"]

    assert _entrar(cliente, FIREFOX).status_code == 200
    assert BUZON == []


def test_un_intento_fallido_no_avisa(cliente, verificada):
    BUZON.clear()
    r = cliente.post("/api/auth/login",
                     json={"email": "ana@lixbon.test", "password": "incorrecta"},
                     headers={"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1"})
    assert r.status_code == 401
    assert BUZON == []


def test_la_ip_no_viaja_entera(verificada):
    assert correo.recortar_ip("187.190.24.91") == "187.190.24.•••"
    assert correo.recortar_ip(None) == "desconocida"


def test_la_suscripcion_avisa_al_empezar_y_al_cambiar_pero_no_al_renovar(_esquema):
    from core.billing.stripe_gateway import _avisar_suscripcion

    usuario = q.get_user_by_email("ana@lixbon.test")
    pro = {"id": "pro", "name": "Pro", "price_monthly_cents": 990, "messages_per_day": 500,
           "tokens_per_month": 5000000, "max_api_keys": 5, "rate_limit_per_min": 60}
    advance = {**pro, "id": "advance", "name": "Advance", "price_monthly_cents": 2490}
    activa_pro = {"plan_id": "pro", "status": "active"}

    BUZON.clear()
    _avisar_suscripcion(usuario["id"], pro, "2026-09-30T12:00:00+00:00", None)
    assert len(BUZON) == 1, "el alta tiene que avisar"
    assert "Tu plan Pro está activo" in BUZON[0]["asunto"]
    assert "$9.90" in BUZON[0]["html"]
    assert "30 de septiembre de 2026" in BUZON[0]["html"]

    BUZON.clear()
    _avisar_suscripcion(usuario["id"], pro, "2026-10-30T12:00:00+00:00", activa_pro)
    assert BUZON == [], "una renovación del mismo plan no puede volver a avisar"

    BUZON.clear()
    _avisar_suscripcion(usuario["id"], advance, "2026-10-30T12:00:00+00:00", activa_pro)
    assert len(BUZON) == 1, "un cambio de plan sí avisa"
    assert "Advance" in BUZON[0]["asunto"]


def test_todos_los_correos_llevan_version_de_texto(verificada, registrada):
    for mensaje in registrada + verificada:
        assert mensaje["texto"].strip(), f"sin texto plano: {mensaje['asunto']}"
