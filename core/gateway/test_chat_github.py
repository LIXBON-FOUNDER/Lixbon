"""El chat con un repo de GitHub adjunto, de punta a punta: SQLite real, el
modelo y la API de GitHub son dobles. Cubre que sin repo adjunto no hay
herramientas, la pausa del modo manual y que al aceptar se escribe en GitHub."""
import json
import os
import pathlib
import shutil
import tempfile

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_github_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'gh.db').as_posix()}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.connectors import github as gh  # noqa: E402
from core.gateway import app as app_mod  # noqa: E402
from core.gateway.routers import chat as chat_mod  # noqa: E402
from core.persistence import connectors as store  # noqa: E402
from core.persistence import queries as q  # noqa: E402
from core.persistence.database import Base, get_engine, get_session  # noqa: E402
from core.persistence.models import Plan  # noqa: E402
from core.security import cifrado  # noqa: E402

EMAIL = "gh@lixbon.test"


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
            "first_name": "Gi", "last_name": "Hub", "email": EMAIL, "password": "contraseña-larga",
        })
        assert r.status_code in (200, 201), r.text
        yield c


@pytest.fixture
def entorno(monkeypatch, cliente):
    monkeypatch.setenv("CONNECTORS_SECRET_KEY", "s" * 40)
    monkeypatch.setattr(gh, "CLIENT_ID", "cid")
    monkeypatch.setattr(gh, "CLIENT_SECRET", "sec")
    monkeypatch.setattr(gh, "APP_SLUG", "lixbon")
    uid = q.get_user_by_email(EMAIL)["id"]
    store.upsert_connector(uid, "github", access_token_enc=cifrado.cifrar("ghu_ada"), account_login="ada")

    llamadas_gh = []

    async def fake_github(metodo, ruta, token, **kw):
        assert token == "ghu_ada"  # siempre el token de ESTE usuario
        llamadas_gh.append((metodo, ruta))
        if ruta == "/user/installations":
            return {"installations": [{"id": 9, "account": {"login": "ada"},
                                       "html_url": "https://github.com/settings/installations/9"}]}
        if ruta == "/repos/ada/motor":
            return {"full_name": "ada/motor", "default_branch": "main", "permissions": {"push": True}}
        if "/contents/" in ruta:
            import base64
            return {"encoding": "base64", "content": base64.b64encode(b"print('hola')\n").decode(), "sha": "abc"}
        if ruta.endswith("/git/ref/heads/lixbon/fix"):
            raise gh.GitHubError("Not Found", status=404)
        if "/git/ref/heads/" in ruta:
            return {"object": {"sha": "c0ffee00"}}
        if ruta.endswith("/git/refs") or ruta.endswith("/git/trees") or ruta.endswith("/git/commits"):
            return {"sha": "beef1234"}
        if "/git/commits/" in ruta:
            return {"tree": {"sha": "tree0"}}
        if metodo == "PATCH":
            return {}
        raise AssertionError(f"GitHub inesperado: {metodo} {ruta}")

    monkeypatch.setattr(gh, "_peticion", fake_github)

    guion = []
    vistos = []

    async def fake_stream(base, model, messages, collector=None, tools=None, **kw):
        vistos.append({"tools": tools, "messages": messages})
        texto, calls = guion.pop(0)
        collector["content"] = texto
        collector["prompt_tokens"], collector["completion_tokens"] = 10, 5
        collector["cached_tokens"] = 4 if len(vistos) > 1 else 0
        collector["breakdown"] = {"system": 3, "tools": 2, "messages": 5}
        if calls:
            collector["tool_calls"] = [{"id": f"c{i}", "type": "function",
                                        "function": {"name": n, "arguments": json.dumps(a)}}
                                       for i, (n, a) in enumerate(calls)]
        yield f'data: {json.dumps({"choices": [{"index": 0, "delta": {"content": texto}, "finish_reason": None}]})}\n\n'

    async def fake_models():
        return [{"id": "fake:1b", "capabilities": ["completion", "tools"]}]

    from core.gateway import model_router
    monkeypatch.setattr(chat_mod, "stream_chat_openai", fake_stream)
    monkeypatch.setattr(chat_mod, "fetch_models", fake_models)
    monkeypatch.setattr(model_router, "fetch_models", fake_models)
    monkeypatch.setattr(chat_mod, "target_or_503", lambda model, strict=True, afinidad=None: ("http://fake", {}, "fake"))
    yield {"uid": uid, "guion": guion, "vistos": vistos, "gh": llamadas_gh}
    store.delete_connector(uid, "github")


def _sse(resp):
    out = []
    for linea in resp.text.split("\n\n"):
        linea = linea.strip()
        if linea.startswith("data: {"):
            out.append(json.loads(linea[6:]))
    return out


def _pedir(cliente, **extra):
    return cliente.post("/v1/chat/completions", json={
        "stream": True, "conversation_id": "conv-gh-1",
        "messages": [{"role": "user", "content": "arregla main.py"}], **extra,
    })


def test_sin_repo_adjunto_no_hay_herramientas(cliente, entorno):
    entorno["guion"].append(("Hola.", []))
    r = _pedir(cliente)
    assert r.status_code == 200
    assert entorno["vistos"][-1]["tools"] is None
    assert entorno["gh"] == []


def test_manual_pausa_y_al_aceptar_escribe(cliente, entorno):
    escribir = ("github_write_files", {"branch": "lixbon/fix", "message": "Arregla main",
                                       "files": [{"path": "main.py", "content": "print('adiós')\n"}]})
    entorno["guion"].append(("Lo leo y lo arreglo.", [("github_read_file", {"path": "main.py"}), escribir]))
    r = _pedir(cliente, github={"repo": "ada/motor", "mode": "manual"})
    assert r.status_code == 200, r.text
    eventos = _sse(r)
    confirm = [e["lixbon_github_confirm"] for e in eventos if "lixbon_github_confirm" in e]
    assert len(confirm) == 1 and confirm[0]["files"][0]["path"] == "main.py"
    assert not any(m == "PATCH" for m, _ in entorno["gh"])  # nada escrito todavía
    nombres = {t["function"]["name"] for t in entorno["vistos"][-1]["tools"]}
    assert "github_write_files" in nombres

    entorno["guion"].append(("Hecho: commit en lixbon/fix.", []))
    r2 = cliente.post("/v1/chat/completions", json={
        "stream": True, "conversation_id": "conv-gh-1", "messages": [],
        "github": {"repo": "ada/motor", "mode": "manual", "resolve": {"id": confirm[0]["id"], "approve": True}},
    })
    assert r2.status_code == 200, r2.text
    assert ("PATCH", "/repos/ada/motor/git/refs/heads/lixbon/fix") in entorno["gh"]
    texto = "".join((e.get("choices") or [{}])[0].get("delta", {}).get("content", "") for e in _sse(r2) if e.get("choices"))
    assert "Hecho" in texto

    # La confirmación es de un solo uso.
    r3 = cliente.post("/v1/chat/completions", json={
        "stream": True, "conversation_id": "conv-gh-1", "messages": [],
        "github": {"repo": "ada/motor", "mode": "manual", "resolve": {"id": confirm[0]["id"], "approve": True}},
    })
    assert r3.status_code == 410


def test_plan_no_ofrece_escritura(cliente, entorno):
    entorno["guion"].append(("Plan: 1. …", []))
    r = _pedir(cliente, github={"repo": "ada/motor", "mode": "plan"})
    assert r.status_code == 200
    nombres = {t["function"]["name"] for t in entorno["vistos"][-1]["tools"]}
    assert not any(n in nombres for n in ("github_write_files", "github_merge_pull_request"))


def test_sin_conexion_responde_409(cliente, entorno):
    store.delete_connector(entorno["uid"], "github")
    r = _pedir(cliente, github={"repo": "ada/motor", "mode": "ask"})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "github_not_connected"


def test_estado_y_desconexion(cliente, entorno, monkeypatch):
    r = cliente.get("/api/connectors/github")
    assert r.json()["connected"] is True and r.json()["login"] == "ada"
    # «Administrar» abre la instalación del usuario, no la página de instalar.
    assert r.json()["manage_url"] == "https://github.com/settings/installations/9"

    class _Http:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *e): return False
        async def request(self, *a, **k): return None

    monkeypatch.setattr(gh.httpx, "AsyncClient", _Http)
    assert cliente.delete("/api/connectors/github").json() == {"disconnected": True}
    assert cliente.get("/api/connectors/github").json()["connected"] is False


def test_la_web_no_recibe_el_razonamiento():
    con = 'data: {"choices": [{"index": 0, "delta": {"content": "", "reasoning_content": "pienso"}, "finish_reason": null}]}\n\n'
    assert chat_mod._sin_razonamiento(con) is None
    mixto = 'data: {"choices": [{"index": 0, "delta": {"content": "Hola", "reasoning_content": "x"}, "finish_reason": null}]}\n\n'
    assert json.loads(chat_mod._sin_razonamiento(mixto)[6:])["choices"][0]["delta"] == {"content": "Hola"}
    fin = 'data: {"choices": [{"index": 0, "delta": {"reasoning_content": "x"}, "finish_reason": "stop"}]}\n\n'
    assert chat_mod._sin_razonamiento(fin) is not None
    assert chat_mod._sin_razonamiento(": keep-alive\n\n") == ": keep-alive\n\n"


def test_el_turno_informa_uso_con_cache_y_contexto_del_ultimo_paso(cliente, entorno, monkeypatch):
    cobros = []
    monkeypatch.setattr(chat_mod, "record_session_week_tokens",
                        lambda uid, model, tin, tout, cached=0: cobros.append((tin, tout, cached)))
    entorno["guion"].append(("Miro el archivo.", [("github_read_file", {"path": "main.py"})]))
    entorno["guion"].append(("Ya está.", []))
    r = _pedir(cliente, github={"repo": "ada/motor", "mode": "auto"})
    assert r.status_code == 200, r.text
    uso = [e for e in _sse(r) if e.get("usage")]
    assert len(uso) == 1
    u, ctx = uso[0]["usage"], uso[0]["lixbon_context"]
    # Se cobra la suma de los pasos; el contexto es el del último paso.
    assert (u["prompt_tokens"], u["completion_tokens"], u["prompt_tokens_details"]["cached_tokens"]) == (20, 10, 4)
    assert ctx["used"] == 15 and ctx["breakdown"]["tools"] == 2 and ctx["steps"] == 2
    assert ctx["num_ctx"] >= chat_mod.GITHUB_MIN_CTX
    assert cobros == [(20, 10, 4)]
