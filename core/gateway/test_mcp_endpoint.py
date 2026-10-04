"""/mcp: protocolo (initialize, notificaciones, lotes, 405, 401) y herramientas de
Visuals de punta a punta con una API key real. SQLite + TestClient."""
import os
import pathlib
import shutil
import tempfile

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_mcp_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'mcp.db').as_posix()}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.gateway import app as app_mod  # noqa: E402
from core.persistence import queries as q  # noqa: E402
from core.persistence.database import Base, get_engine, get_session  # noqa: E402
from core.persistence.models import Plan  # noqa: E402


@pytest.fixture(scope="module")
def mcp():
    Base.metadata.create_all(get_engine())
    with get_session() as s:
        for pid in ("free", "pro"):
            s.add(Plan(id=pid, name=pid, description="", price_monthly_cents=0, currency="USD",
                       messages_per_day=30, tokens_per_month=150000, max_api_keys=5, rate_limit_per_min=1000,
                       allowed_models=None, priority=0, sort_order=0, is_active=1,
                       created_at=q.now_iso(), updated_at=q.now_iso()))
    app_mod.init_db = lambda: None
    app_mod.versions.sync_versions_to_db = lambda: None
    app_mod.deps.orquestador.iniciar = lambda: None
    app_mod.deps.orquestador.detener = lambda: None
    with TestClient(app_mod.app) as c:
        c.post("/api/auth/register", json={"first_name": "M", "last_name": "Cp",
                                           "email": "mcp@lixbon.test", "password": "contraseña-larga"})
        q.set_user_plan(q.get_user_by_email("mcp@lixbon.test")["id"], "pro")
        r = c.post("/api/keys", json={"name": "agente"})
        key = r.json().get("key") or r.json().get("api_key")
        c.cookies.clear()
        c.headers["Authorization"] = f"Bearer {key}"
        yield c
    get_engine().dispose()
    shutil.rmtree(_DB_DIR, ignore_errors=True)


_ids = iter(range(1, 10_000))


def rpc(c, method, params=None):
    r = c.post("/mcp", json={"jsonrpc": "2.0", "id": next(_ids), "method": method, "params": params or {}})
    assert r.status_code == 200, r.text
    return r.json()


def tool(c, name, **args):
    res = rpc(c, "tools/call", {"name": name, "arguments": args})["result"]
    return res, res.get("structuredContent")


def test_initialize_negocia_version(mcp):
    res = rpc(mcp, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                  "clientInfo": {"name": "test", "version": "0"}})["result"]
    assert res["protocolVersion"] == "2025-06-18" and res["serverInfo"]["name"] == "lixbon"
    assert set(res["capabilities"]) == {"tools", "prompts"}
    raro = rpc(mcp, "initialize", {"protocolVersion": "1999-01-01"})["result"]
    assert raro["protocolVersion"] == "2025-06-18"


def test_notificacion_405_y_lote(mcp):
    assert mcp.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"}).status_code == 202
    assert mcp.get("/mcp").status_code == 405
    r = mcp.post("/mcp", json=[{"jsonrpc": "2.0", "id": 1, "method": "ping"},
                               {"jsonrpc": "2.0", "method": "notifications/initialized"}])
    assert r.json() == [{"jsonrpc": "2.0", "id": 1, "result": {}}]
    assert rpc(mcp, "no/existe")["error"]["code"] == -32601


def test_sin_key_401_con_www_authenticate(mcp):
    with TestClient(app_mod.app) as anonimo:
        r = anonimo.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        assert r.status_code == 401 and r.headers["www-authenticate"].startswith("Bearer")


def test_lista_herramientas_y_prompt(mcp):
    nombres = {t["name"] for t in rpc(mcp, "tools/list")["result"]["tools"]}
    assert nombres == {"visual_create", "visual_update", "visual_get", "visual_list", "visual_export",
                       "visual_render", "visual_render_status", "visual_view"}
    assert rpc(mcp, "prompts/list")["result"]["prompts"][0]["name"] == "visual"
    msg = rpc(mcp, "prompts/get", {"name": "visual", "arguments": {"peticion": "una landing"}})["result"]["messages"][0]
    assert msg["role"] == "user" and "visual_create" in msg["content"]["text"] and "una landing" in msg["content"]["text"]


def test_crear_leer_editar_y_exportar(mcp):
    res, data = tool(mcp, "visual_create", title="Landing API", kind="design",
                     files=[{"path": "index.html", "text": "<h1 class=\"t\">Hola</h1>\n<p>uno</p>"}])
    assert not res["isError"] and data["version"] == 1 and data["url"].endswith(f"/visuals/{data['id']}")
    vid = data["id"]

    _, leido = tool(mcp, "visual_get", id=f"https://lixbon.com/visuals/{vid}")
    assert leido["version"] == 1 and leido["files"][0]["text"].startswith("<h1")

    _, editado = tool(mcp, "visual_update", id=vid, base_version=1,
                      edits=[{"path": "index.html", "search": "<p>uno</p>", "replace": "<p>dos</p>"}])
    assert editado["version"] == 2 and editado["files"] == ["index.html"]

    res, _ = tool(mcp, "visual_update", id=vid, base_version=1,
                  edits=[{"path": "index.html", "search": "<p>dos</p>", "replace": "<p>tres</p>"}])
    assert res["isError"] and '"stale_base"' in res["content"][0]["text"]

    res, _ = tool(mcp, "visual_update", id=vid, base_version=2,
                  edits=[{"path": "index.html", "search": "no está", "replace": "x"}])
    assert res["isError"] and '"edit_mismatch"' in res["content"][0]["text"]

    _, corregido = tool(mcp, "visual_update", id=vid, base_version=2, amend=True,
                        edits=[{"path": "index.html", "search": "<p>dos</p>", "replace": "<p>dos bis</p>"}])
    assert corregido["version"] == 3
    versiones = mcp.get(f"/api/visuals/{vid}/versions").json()["items"]
    assert [v["version"] for v in versiones] == [3, 1]

    texto = '<h1 class="t">Hola</h1>\n<p>dos bis</p>\n'
    retoque = mcp.post(f"/api/visuals/{vid}/files", json={"files": [{"path": "index.html", "text": texto}], "base_version": 3})
    assert retoque.json()["version"] == 4
    _, sobre_retoque = tool(mcp, "visual_update", id=vid, base_version=4, amend=True,
                            edits=[{"path": "index.html", "search": "<h1", "replace": '<h1 id="x"'}])
    assert sobre_retoque["version"] == 5  # el retoque del usuario no se funde con la corrección del agente
    assert [v["version"] for v in mcp.get(f"/api/visuals/{vid}/versions").json()["items"]] == [5, 4, 3, 1]

    _, exp = tool(mcp, "visual_export", id=vid, stack="react")
    assert "React + Vite" in exp["instructions"] and exp["files"][0]["text"].startswith("<h1 id=\"x\"")

    _, lista = tool(mcp, "visual_list", query="Landing")
    assert [i["id"] for i in lista["items"]] == [vid]


def test_errores_de_parametros(mcp):
    r = rpc(mcp, "tools/call", {"name": "visual_update", "arguments": {"id": "vis_x"}})
    assert r["error"]["code"] == -32602
    r = rpc(mcp, "tools/call", {"name": "nada", "arguments": {}})
    assert r["error"]["code"] == -32602
    res, _ = tool(mcp, "visual_get", id="vis_noexiste")
    assert res["isError"] and '"not_found"' in res["content"][0]["text"]
