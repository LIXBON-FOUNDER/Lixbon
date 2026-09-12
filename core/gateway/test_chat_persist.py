"""
La respuesta del asistente se guarda por tramos mientras se genera: si el
gateway se reinicia a mitad (deploy), lo generado hasta ahí queda en el
historial. SQLite temporal + TestClient; el modelo es un doble que emite
chunks despacio.
"""
import os
import pathlib
import shutil
import tempfile
import time

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_persist_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'persist.db').as_posix()}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.gateway import app as app_mod  # noqa: E402
from core.gateway.routers import chat as chat_mod  # noqa: E402
from core.persistence import queries as q  # noqa: E402
from core.persistence.database import Base, get_engine, get_session  # noqa: E402
from core.persistence.models import Message, Plan  # noqa: E402

CHUNKS = ["Hola", ", ", "esto ", "es ", "una ", "respuesta ", "larga."]


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
def cabeceras(cliente):
    # Sesión web (cookie): el tráfico por API key exige tarifas de créditos.
    r = cliente.post("/api/auth/register", json={
        "first_name": "Per", "last_name": "Sist",
        "email": "persist@lixbon.test", "password": "contraseña-larga",
    })
    assert r.status_code in (200, 201), r.text
    return {}


@pytest.fixture
def modelo_falso(monkeypatch):
    """Sustituye la inferencia por un generador lento que rellena el collector
    como lo hace el real (parts en vivo, content al cerrar)."""
    async def fake_stream(base, model, messages, headers=None, collector=None, **kw):
        parts: list[str] = []
        if collector is not None:
            collector["parts"] = parts
        try:
            for i, c in enumerate(CHUNKS):
                parts.append(c)
                yield f'data: {{"choices":[{{"index":0,"delta":{{"content":"{c}"}},"finish_reason":null}}]}}\n\n'
                time.sleep(0.05)
            yield "data: [DONE]\n\n"
        finally:
            if collector is not None:
                collector["content"] = "".join(parts)
                collector["prompt_tokens"] = 10
                collector["completion_tokens"] = len(parts)

    async def fake_models():
        return [{"id": "fake:1b", "capabilities": ["completion"]}]

    from core.gateway import model_router
    monkeypatch.setattr(chat_mod, "stream_chat_openai", fake_stream)
    monkeypatch.setattr(chat_mod, "fetch_models", fake_models)
    monkeypatch.setattr(model_router, "fetch_models", fake_models)
    monkeypatch.setattr(chat_mod, "target_or_503", lambda model, strict=True: ("http://fake", {}, "fake"))
    monkeypatch.setattr(chat_mod, "CHECKPOINT_SECONDS", 0.0)


def _mensajes(conv_id):
    with get_session() as s:
        rows = s.query(Message).filter(Message.conversation_id == conv_id).order_by(Message.id).all()
        return [(m.role, m.content, m.completion_tokens) for m in rows]


def test_respuesta_completa_queda_una_sola_vez(cliente, cabeceras, modelo_falso):
    conv = "conv-persist-completa"
    with cliente.stream("POST", "/v1/chat/completions", headers=cabeceras, json={
        "model": "fake:1b", "stream": True, "conversation_id": conv,
        "messages": [{"role": "user", "content": "hola"}],
    }) as r:
        assert r.status_code == 200
        cuerpo = "".join(r.iter_text())
    assert "[DONE]" in cuerpo
    filas = _mensajes(conv)
    assert filas == [("user", "hola", 0), ("assistant", "".join(CHUNKS), len(CHUNKS))]


def test_si_el_cliente_se_corta_a_mitad_queda_lo_parcial(cliente, cabeceras, modelo_falso):
    conv = "conv-persist-parcial"
    recibidos = 0
    with cliente.stream("POST", "/v1/chat/completions", headers=cabeceras, json={
        "model": "fake:1b", "stream": True, "conversation_id": conv,
        "messages": [{"role": "user", "content": "hola"}],
    }) as r:
        for linea in r.iter_lines():
            if linea.startswith("data: "):
                recibidos += 1
                if recibidos == 3:
                    break
    filas = _mensajes(conv)
    assert filas[0] == ("user", "hola", 0)
    assert len(filas) == 2, "el parcial debe existir una sola vez"
    rol, contenido, _ = filas[1]
    assert rol == "assistant"
    assert contenido.startswith("Hola, ") and len(contenido) <= len("".join(CHUNKS))
