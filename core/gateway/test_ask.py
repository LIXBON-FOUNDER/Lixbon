# Pregunta a lixbon (FAQ de la portada): solo responde sobre lixbon, nunca código,
# y el público no puede martillearlo. El router se monta solo, sin la app ni la BD.
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from core.gateway.routers import ask


@pytest.fixture
def cliente(monkeypatch):
    llamadas = []
    respuesta = {"texto": "El plan Pro cuesta $9.90 al mes."}

    async def modelos():
        return [{"id": "pequeno"}]

    async def chat(modelo, mensajes, **kw):
        llamadas.append((modelo, mensajes, kw))
        return {"message": {"content": respuesta["texto"]}}, "local"

    monkeypatch.setattr(ask, "fetch_models", modelos)
    monkeypatch.setattr(ask, "pick_classifier_model", lambda catalogo: "pequeno")
    monkeypatch.setattr(ask, "_routed_chat", chat)
    ask._envios.clear()
    app = FastAPI()
    app.include_router(ask.router)
    return TestClient(app), llamadas, respuesta


def _pregunta(texto, locale="es"):
    return {"messages": [{"role": "user", "content": texto}], "locale": locale}


def test_responde_sobre_lixbon(cliente):
    c, llamadas, _ = cliente
    r = c.post("/api/ask", json=_pregunta("¿Cuánto cuesta Pro?"))
    assert r.status_code == 200
    assert r.json() == {"answer": "El plan Pro cuesta $9.90 al mes.", "on_topic": True}
    modelo, mensajes, kw = llamadas[0]
    assert modelo == "pequeno" and kw["think"] is False
    assert mensajes[0]["role"] == "system" and "$24.90" in mensajes[0]["content"]


def test_fuera_de_tema_se_sustituye_por_la_negativa(cliente):
    c, _, respuesta = cliente
    respuesta["texto"] = "FUERA"
    r = c.post("/api/ask", json=_pregunta("¿Quién ganó el mundial?"))
    assert r.json() == {"answer": ask.NEGATIVA["es"], "on_topic": False}
    r = c.post("/api/ask", json=_pregunta("who won?", "en"))
    assert r.json()["answer"] == ask.NEGATIVA["en"]


def test_nunca_devuelve_codigo(cliente):
    c, llamadas, respuesta = cliente
    respuesta["texto"] = "Claro:\n```python\nprint(1)\n```"
    assert c.post("/api/ask", json=_pregunta("dame código")).json()["on_topic"] is False
    llamadas.clear()
    assert c.post("/api/ask", json=_pregunta("```print(1)```")).json()["on_topic"] is False
    assert llamadas == []


def test_quita_el_razonamiento(cliente):
    c, _, respuesta = cliente
    respuesta["texto"] = "<think>hmm</think>Sí, desde Ajustes → Facturación."
    assert c.post("/api/ask", json=_pregunta("¿Puedo cancelar?")).json()["answer"] == "Sí, desde Ajustes → Facturación."


def test_valida_la_entrada(cliente):
    c, _, _ = cliente
    assert c.post("/api/ask", json=_pregunta("x" * 301)).status_code == 422
    assert c.post("/api/ask", json={"messages": []}).status_code == 422
    assert c.post("/api/ask", json={"messages": [{"role": "assistant", "content": "hola"}]}).status_code == 422


def test_limite_por_ip(cliente):
    c, _, _ = cliente
    for _ in range(ask.MAX_POR_IP):
        assert c.post("/api/ask", json=_pregunta("¿Qué es lixbon?")).status_code == 200
    assert c.post("/api/ask", json=_pregunta("¿Qué es lixbon?")).status_code == 429
    otra = c.post("/api/ask", json=_pregunta("¿Qué es lixbon?"), headers={"x-forwarded-for": "9.9.9.9"})
    assert otra.status_code == 200
