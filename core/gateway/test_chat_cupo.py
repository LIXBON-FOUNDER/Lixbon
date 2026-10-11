"""El stream se corta al agotarse el cupo de sesión/semana y avisa al cliente
cuando queda poco. El modelo es un doble que anota si lo cerraron."""
import json
import os
import pathlib
import shutil
import tempfile

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_cupo_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'cupo.db').as_posix()}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.billing import quota  # noqa: E402
from core.gateway import app as app_mod  # noqa: E402
from core.gateway.routers import chat as chat_mod  # noqa: E402
from core.persistence import queries as q  # noqa: E402
from core.persistence.database import Base, get_engine, get_session  # noqa: E402
from core.persistence.models import Plan  # noqa: E402

TROZO = "x" * 40
AGOTADO = {"state": "exhausted", "scope": "session", "percent": 100.0, "reset_at": None, "message": "Agotaste el cupo."}
CERCA = {"state": "near", "scope": "week", "percent": 85.0, "reset_at": None, "message": "Llevas el 85 %."}


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
        r = c.post("/api/auth/register", json={
            "first_name": "Cu", "last_name": "Po", "email": "cupo@lixbon.test", "password": "contraseña-larga",
        })
        assert r.status_code in (200, 201), r.text
        yield c


@pytest.fixture
def modelo(monkeypatch):
    estado = {"cerrado": False, "cobros": []}

    async def fake_stream(base, model, messages, collector=None, **kw):
        parts = []
        if collector is not None:
            collector["parts"] = parts
        try:
            for _ in range(50):
                parts.append(TROZO)
                yield f'data: {{"choices":[{{"index":0,"delta":{{"content":"{TROZO}"}},"finish_reason":null}}]}}\n\n'
            yield "data: [DONE]\n\n"
        finally:
            estado["cerrado"] = True
            if collector is not None:
                collector["content"] = "".join(parts)

    async def fake_models():
        return [{"id": "fake:1b", "capabilities": ["completion"]}]

    def cobrar(conv_id, model, text, prompt_tokens, completion_tokens, *a, **kw):
        estado["cobros"].append(completion_tokens)

    from core.gateway import model_router
    monkeypatch.setattr(chat_mod, "stream_chat_openai", fake_stream)
    monkeypatch.setattr(chat_mod, "fetch_models", fake_models)
    monkeypatch.setattr(model_router, "fetch_models", fake_models)
    monkeypatch.setattr(chat_mod, "target_or_503", lambda model, strict=True: ("http://fake", {}, "fake"))
    monkeypatch.setattr(chat_mod, "resolve_model_weight",
                        lambda m: {"input_credits_per_mtok": 0, "output_credits_per_mtok": 1_000_000})
    monkeypatch.setattr(chat_mod, "_persist_assistant", cobrar)
    return estado


def _eventos(cliente):
    with cliente.stream("POST", "/v1/chat/completions", json={
        "model": "fake:1b", "stream": True, "messages": [{"role": "user", "content": "hola"}],
    }) as r:
        assert r.status_code == 200
        cuerpo = "".join(r.iter_text())
    return [e[6:] for e in cuerpo.split("\n\n") if e.startswith("data: ")]


def test_se_corta_al_agotar_el_cupo(cliente, modelo, monkeypatch):
    monkeypatch.setattr(chat_mod, "credits_remaining", lambda uid, plan: 25)
    monkeypatch.setattr(chat_mod, "quota_notice", lambda uid, plan: AGOTADO)
    eventos = _eventos(cliente)
    assert eventos[-1] == "[DONE]"
    final = json.loads(eventos[-2])
    assert final["lixbon_quota"]["state"] == "exhausted"
    assert final["choices"][0]["finish_reason"] == "length"
    contenido = [e for e in eventos[:-2] if TROZO in e]
    assert len(contenido) == 3  # 10 tokens por trozo: el tercero llega a 30 ≥ 25
    assert modelo["cerrado"]
    assert modelo["cobros"] == [30]


def test_sin_limite_no_corta_y_avisa_si_queda_poco(cliente, modelo, monkeypatch):
    monkeypatch.setattr(chat_mod, "credits_remaining", lambda uid, plan: None)
    monkeypatch.setattr(chat_mod, "quota_notice", lambda uid, plan: CERCA)
    eventos = _eventos(cliente)
    assert eventos[-1] == "[DONE]"
    aviso = json.loads(eventos[-2])
    assert aviso == {"choices": [], "lixbon_quota": CERCA}
    assert sum(TROZO in e for e in eventos) == 50


def test_sin_aviso_no_hay_chunk_extra(cliente, modelo, monkeypatch):
    monkeypatch.setattr(chat_mod, "credits_remaining", lambda uid, plan: None)
    monkeypatch.setattr(chat_mod, "quota_notice", lambda uid, plan: None)
    eventos = _eventos(cliente)
    assert eventos.count("[DONE]") == 1
    assert not any("lixbon_quota" in e for e in eventos)


def _snapshot(session_pct, week_pct, unlimited=False):
    def bucket(pct):
        return {"used": int(pct), "limit": 100, "unlimited": unlimited, "percent": pct,
                "reset_at": "2099-01-01T00:00:00+00:00", "messages": 1}
    return lambda uid, plan: {"session": bucket(session_pct), "week": bucket(week_pct)}


@pytest.mark.parametrize("sesion,semana,estado,scope", [
    (50.0, 10.0, None, None),
    (85.0, 10.0, "near", "session"),
    (40.0, 100.0, "exhausted", "week"),
])
def test_aviso_de_cupo(monkeypatch, sesion, semana, estado, scope):
    monkeypatch.setattr(quota, "credit_buckets_snapshot", _snapshot(sesion, semana))
    aviso = quota.quota_notice(1, {"name": "Gratuito"})
    if estado is None:
        assert aviso is None
    else:
        assert aviso["state"] == estado and aviso["scope"] == scope
        assert "Gratuito" in aviso["message"] and "Se reinicia" in aviso["message"]


def test_sin_limites_no_hay_aviso(monkeypatch):
    monkeypatch.setattr(quota, "credit_buckets_snapshot", _snapshot(100.0, 100.0, unlimited=True))
    assert quota.quota_notice(1, {"name": "Pro"}) is None
