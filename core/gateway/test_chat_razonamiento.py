"""Cuánto razona el chat cuando el cliente no lo pide, y si un saludo
dispara el planificador de búsquedas. El modelo es un doble que anota con qué
`think` se le llamó."""
import os
import pathlib
import shutil
import tempfile

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_razona_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'razona.db').as_posix()}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.gateway import app as app_mod  # noqa: E402
from core.gateway.routers import chat as chat_mod  # noqa: E402
from core.persistence import queries as q  # noqa: E402
from core.persistence.database import Base, get_engine, get_session  # noqa: E402
from core.persistence.models import Plan  # noqa: E402

CATALOGO = [
    {"id": "deepseek-r1:8b", "capabilities": ["completion", "thinking"]},
    {"id": "gpt-oss:20b", "capabilities": ["completion", "thinking", "tools"]},
    {"id": "llama3:8b", "capabilities": ["completion"]},
]


@pytest.fixture(scope="module", autouse=True)
def _esquema():
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


@pytest.fixture(scope="module")
def cliente(_esquema):
    app_mod.init_db = lambda: None
    app_mod.versions.sync_versions_to_db = lambda: None
    app_mod.deps.orquestador.iniciar = lambda: None
    app_mod.deps.orquestador.detener = lambda: None
    with TestClient(app_mod.app) as c:
        yield c


@pytest.fixture(scope="module")
def sesion(cliente):
    # Sesión web (cookie): el tráfico por API key exige tarifas de créditos.
    r = cliente.post("/api/auth/register", json={
        "first_name": "Ra", "last_name": "Zona",
        "email": "razona@lixbon.test", "password": "contraseña-larga",
    })
    assert r.status_code in (200, 201), r.text
    return True


@pytest.fixture
def llamadas(monkeypatch):
    registro = {"think": [], "planificador": 0}

    async def fake_stream(base, model, messages, collector=None, think=None, **kw):
        registro["think"].append(think)
        if collector is not None:
            collector.update(parts=["ok"], content="ok", prompt_tokens=1, completion_tokens=1)
        yield "data: [DONE]\n\n"

    async def fake_chat(*a, **kw):
        registro["planificador"] += 1
        return {"message": {"content": '{"queries": []}'}}

    async def fake_models():
        return CATALOGO

    from core.gateway import model_router
    monkeypatch.setattr(chat_mod, "stream_chat_openai", fake_stream)
    monkeypatch.setattr(chat_mod, "ollama_chat", fake_chat)
    monkeypatch.setattr(chat_mod, "fetch_models", fake_models)
    monkeypatch.setattr(model_router, "fetch_models", fake_models)
    monkeypatch.setattr(chat_mod, "target_or_503", lambda model, strict=True: ("http://fake", {}, "fake"))
    monkeypatch.setattr(chat_mod, "CHAT_THINK", None)
    return registro


def _enviar(cliente, texto, model="deepseek-r1:8b", **extra):
    with cliente.stream("POST", "/v1/chat/completions", json={
        "model": model, "stream": True, "web_search": "auto",
        "messages": [{"role": "user", "content": texto}], **extra,
    }) as r:
        assert r.status_code == 200, r.read()
        r.read()


def test_un_saludo_no_razona_ni_planifica_busqueda(cliente, sesion, llamadas):
    _enviar(cliente, "hola")
    assert llamadas["think"] == [False]
    assert llamadas["planificador"] == 0


def test_una_pregunta_de_analisis_razona(cliente, sesion, llamadas):
    _enviar(cliente, "explica por qué el cielo es azul")
    assert llamadas["think"] == [True]
    assert llamadas["planificador"] == 1


@pytest.mark.parametrize("model,esperado", [("deepseek-r1:8b", False), ("gpt-oss:20b", "low")])
def test_lo_intermedio_solo_razona_poco_en_gpt_oss(cliente, sesion, llamadas, model, esperado):
    _enviar(cliente, "dame ideas de nombres para una cafetería en la playa", model=model)
    assert llamadas["think"] == [esperado]


def test_lo_que_pide_el_cliente_manda(cliente, sesion, llamadas):
    _enviar(cliente, "hola", think=True)
    assert llamadas["think"] == [True]


def test_un_modelo_sin_razonamiento_no_recibe_think_true(cliente, sesion, llamadas):
    _enviar(cliente, "explica por qué el cielo es azul", model="llama3:8b")
    assert llamadas["think"] == [None]
