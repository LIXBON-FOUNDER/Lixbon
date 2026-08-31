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
# El envío de verdad, antes de que el buzón lo sustituya: alguna prueba necesita
# comprobar qué hace él, no el doble.
ENVIO_REAL = correo.send_email


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
    correo.send_email = ENVIO_REAL


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


# ── El correo que no sale, y la cuenta que no lo ha verificado ─────────────

def test_un_correo_perdido_no_se_cuenta_como_enviado(cliente, monkeypatch):
    # Decir siempre "verification_email_sent: true" dejaba al recién registrado
    # esperando indefinidamente un correo que nadie llegó a enviar.
    async def fallar(*_a, **_k):
        return False

    monkeypatch.setattr(correo, "send_email", fallar)
    r = cliente.post("/api/auth/register", json={
        "first_name": "Sin", "last_name": "Correo",
        "email": "perdido@lixbon.test", "password": CLAVE},
        headers={"user-agent": CHROME})
    assert r.status_code == 200
    assert r.json()["verification_email_sent"] is False


def test_en_produccion_sin_clave_el_correo_no_se_da_por_enviado(monkeypatch):
    # PUBLIC_BASE_URL es https en este módulo: el gateway real. Ahí, la falta de
    # clave no es un "modo desarrollo", es un correo perdido.
    monkeypatch.setattr(correo, "BREVO_API_KEY", "")
    assert correo.en_produccion() is True
    assert correo.problema_de_configuracion() is not None

    import asyncio
    assert asyncio.run(ENVIO_REAL("a@b.test", "Asunto", "<p>hola</p>")) is False


def test_sin_verificar_no_se_puede_usar_el_servicio(monkeypatch):
    from fastapi import HTTPException

    from core.security.auth import exigir_correo_verificado

    sin_verificar = {"id": 1, "email": "ana@lixbon.test", "email_verified": False}
    verificado = {**sin_verificar, "email_verified": True}
    heredado = {"id": 2, "email": None, "email_verified": False}

    # Apagado (el valor por defecto): nadie se queda fuera.
    monkeypatch.setattr("core.config.REQUIRE_EMAIL_VERIFICATION", False)
    assert exigir_correo_verificado(sin_verificar) is sin_verificar

    monkeypatch.setattr("core.config.REQUIRE_EMAIL_VERIFICATION", True)
    assert exigir_correo_verificado(verificado) is verificado
    # Sin correo no hay nada que verificar: exigirlo sería un bloqueo sin salida.
    assert exigir_correo_verificado(heredado) is heredado

    with pytest.raises(HTTPException) as caida:
        exigir_correo_verificado(sin_verificar)
    assert caida.value.status_code == 403
    assert caida.value.detail["error"] == "email_not_verified"


# ── Los tres avisos que faltaban ──────────────────────────────────────────

@pytest.fixture(scope="module")
def plan_pro(_esquema):
    with get_session() as s:
        if not s.get(Plan, "pro"):
            s.add(Plan(id="pro", name="Pro", description="", price_monthly_cents=990,
                       currency="USD", messages_per_day=500, tokens_per_month=5000000,
                       max_api_keys=5, rate_limit_per_min=60, allowed_models=None,
                       priority=1, sort_order=1, is_active=1,
                       created_at=q.now_iso(), updated_at=q.now_iso()))
    return q.get_plan("pro")


def test_cambiar_la_contrasena_avisa_a_su_dueno(cliente, verificada):
    # El aviso es para el caso en que la cambie otro: por eso sale del cambio
    # que salió bien, no de un error.
    usuario = q.get_user_by_email("ana@lixbon.test")
    token = q.create_email_token(usuario["id"], "reset_password", hours=2)
    BUZON.clear()
    r = cliente.post("/api/auth/reset-password",
                     json={"token": token, "new_password": "otra-clave-bien-larga"},
                     headers={"user-agent": FIREFOX})
    assert r.status_code == 200
    assert len(BUZON) == 1
    aviso = BUZON[0]
    assert "Tu contraseña cambió" in aviso["asunto"]
    assert "Firefox en Linux" in aviso["html"]
    assert "187.190.24.•••" in aviso["html"]
    assert "reset-password" in aviso["html"]  # la salida, si no fue el dueño


def test_la_cancelacion_avisa_una_vez_y_no_si_ya_estaba_en_gratuito(plan_pro):
    from core.billing.stripe_gateway import _avisar_cancelacion

    usuario = q.get_user_by_email("ana@lixbon.test")
    # Sin precio en la BD: cae al respaldo por metadata, como en producción
    # cuando la suscripción es más vieja que el precio actual.
    suscripcion = {"metadata": {"plan_id": "pro"},
                   "items": {"data": [{"price": {"id": "price_desconocido"}}]}}

    BUZON.clear()
    _avisar_cancelacion(usuario["id"], suscripcion, {"plan_id": "pro", "status": "active"})
    assert len(BUZON) == 1
    assert "Tu plan Pro terminó" in BUZON[0]["asunto"]
    assert "Plan Gratuito" in BUZON[0]["html"]
    assert "30 mensajes al día" in BUZON[0]["html"]

    # Stripe reenvía los webhooks que no confirma: el segundo no puede avisar.
    BUZON.clear()
    _avisar_cancelacion(usuario["id"], suscripcion, {"plan_id": "free", "status": "canceled"})
    assert BUZON == []

    BUZON.clear()
    _avisar_cancelacion(usuario["id"], suscripcion, None)
    assert BUZON == []


def test_el_pago_fallido_avisa_solo_si_hay_suscripcion_en_juego(plan_pro):
    from core.billing.stripe_gateway import _avisar_pago_fallido

    usuario = q.get_user_by_email("ana@lixbon.test")
    q.set_user_plan(usuario["id"], "pro")
    factura = {"subscription": "sub_123", "amount_due": 990, "currency": "usd",
               "next_payment_attempt": 1788700000,
               "hosted_invoice_url": "https://invoice.stripe.com/i/abc"}

    BUZON.clear()
    _avisar_pago_fallido(usuario, factura)
    assert len(BUZON) == 1
    aviso = BUZON[0]
    assert "No pudimos cobrar tu suscripción" in aviso["asunto"]
    assert "$9.90 USD" in aviso["html"]
    assert "invoice.stripe.com" in aviso["html"]  # pagar sin tener que entrar

    # Un pack de créditos que falla no pone en riesgo ningún plan.
    BUZON.clear()
    _avisar_pago_fallido(usuario, {**factura, "subscription": None})
    assert BUZON == []
    q.set_user_plan(usuario["id"], "free")
