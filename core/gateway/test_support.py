# Formulario de soporte: qué correos salen, a quién, y que el público no pueda
# martillearlo. El router se monta solo, sin la app ni la base de datos.
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from core.gateway.routers import support


@pytest.fixture
def cliente(monkeypatch):
    enviados = []

    async def caso(**kw):
        enviados.append(("caso", kw))
        return True

    async def acuse(to, **kw):
        enviados.append(("acuse", {"to": to, **kw}))
        return True

    monkeypatch.setattr(support, "send_support_ticket", caso)
    monkeypatch.setattr(support, "send_support_receipt", acuse)
    support._envios.clear()
    app = FastAPI()
    app.include_router(support.router)
    return TestClient(app), enviados


CASO = {"category": "billing", "subject": "Cobro doble", "message": "Me cobraron dos veces el plan Pro este mes."}


def test_sin_sesion_pide_correo(cliente):
    c, enviados = cliente
    assert c.post("/api/support", json=CASO).status_code == 422
    assert enviados == []


def test_envia_caso_y_acuse(cliente):
    c, enviados = cliente
    r = c.post("/api/support", json={**CASO, "email": "ana@ejemplo.com", "name": "Ana"})
    assert r.status_code == 200
    ticket = r.json()["ticket"]
    assert ticket.startswith("LX-")
    tipos = [t for t, _ in enviados]
    assert tipos == ["caso", "acuse"]
    assert enviados[0][1]["correo"] == "ana@ejemplo.com"
    assert enviados[0][1]["categoria"] == "Pagos y facturación"
    assert enviados[1][1]["to"] == "ana@ejemplo.com"
    assert enviados[1][1]["ticket"] == ticket


def test_trampa_no_envia(cliente):
    c, enviados = cliente
    r = c.post("/api/support", json={**CASO, "email": "bot@ejemplo.com", "website": "http://spam"})
    assert r.status_code == 200
    assert enviados == []


def test_limite_por_ip(cliente):
    c, _ = cliente
    cuerpo = {**CASO, "email": "ana@ejemplo.com"}
    for _ in range(support.MAX_ENVIOS):
        assert c.post("/api/support", json=cuerpo).status_code == 200
    assert c.post("/api/support", json=cuerpo).status_code == 429


def test_mensaje_corto_rechazado(cliente):
    c, _ = cliente
    assert c.post("/api/support", json={**CASO, "message": "hola", "email": "a@b.co"}).status_code == 422
