"""POST /api/websearch: la herramienta web_search del CLI, con el buscador
sustituido por un doble. SQLite temporal + TestClient."""
import os
import pathlib
import shutil
import tempfile

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_websearch_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'ws.db').as_posix()}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.gateway import app as app_mod  # noqa: E402
from core.gateway.routers import chat as chat_mod  # noqa: E402
from core.persistence import queries as q  # noqa: E402
from core.persistence.database import Base, get_engine, get_session  # noqa: E402
from core.persistence.models import Plan  # noqa: E402


@pytest.fixture(scope="module")
def cliente():
    Base.metadata.create_all(get_engine())
    with get_session() as s:
        if not s.get(Plan, "free"):
            s.add(Plan(id="free", name="Gratuito", description="", price_monthly_cents=0,
                       currency="USD", messages_per_day=30, tokens_per_month=150000,
                       max_api_keys=1, rate_limit_per_min=1000, allowed_models=None,
                       priority=0, sort_order=0, is_active=1,
                       created_at=q.now_iso(), updated_at=q.now_iso()))
    app_mod.init_db = lambda: None
    app_mod.versions.sync_versions_to_db = lambda: None
    app_mod.deps.orquestador.iniciar = lambda: None
    app_mod.deps.orquestador.detener = lambda: None
    with TestClient(app_mod.app) as c:
        r = c.post("/api/auth/register", json={
            "first_name": "Web", "last_name": "Search",
            "email": "websearch@lixbon.test", "password": "contraseña-larga",
        })
        assert r.status_code in (200, 201), r.text
        yield c
    get_engine().dispose()
    shutil.rmtree(_DB_DIR, ignore_errors=True)


def test_devuelve_resultados_del_buscador(cliente, monkeypatch):
    llamadas = []

    async def fake_search(query, limit=None):
        llamadas.append((query, limit))
        return [{"title": "T", "url": "https://t.test", "snippet": "s", "extra": 1}]

    monkeypatch.setattr(chat_mod.websearch, "search", fake_search)
    r = cliente.post("/api/websearch", json={"query": "fastapi lifespan", "limit": 3})
    assert r.status_code == 200, r.text
    assert r.json()["results"] == [{"title": "T", "url": "https://t.test", "snippet": "s"}]
    assert llamadas == [("fastapi lifespan", 3)]


def test_valida_la_consulta(cliente):
    assert cliente.post("/api/websearch", json={"query": ""}).status_code == 422
    assert cliente.post("/api/websearch", json={"query": "x", "limit": 50}).status_code == 422


def test_exige_sesion():
    with TestClient(app_mod.app) as anonimo:
        assert anonimo.post("/api/websearch", json={"query": "x"}).status_code in (401, 403)
