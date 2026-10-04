"""/api/visuals/*: crear solo en Pro/Advance, versiones lineales con base_version,
aislamiento, enlaces públicos, límites del plan y avisos en vivo. SQLite + TestClient."""
import base64
import os
import pathlib
import shutil
import tempfile

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_visuals_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'vis.db').as_posix()}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.gateway import app as app_mod  # noqa: E402
from core.gateway.visual_events import bus  # noqa: E402
from core.persistence import queries as q  # noqa: E402
from core.persistence import visuals as store  # noqa: E402
from core.persistence.database import Base, get_engine, get_session  # noqa: E402
from core.persistence.models import Plan  # noqa: E402

PNG = base64.b64encode(b"\x89PNG\r\n\x1a\nfake-image-bytes").decode()


def _registrar(c, correo, plan="pro"):
    r = c.post("/api/auth/register", json={
        "first_name": "Vis", "last_name": "Ual", "email": correo, "password": "contraseña-larga"})
    assert r.status_code in (200, 201), r.text
    q.set_user_plan(q.get_user_by_email(correo)["id"], plan)


@pytest.fixture(scope="module")
def cliente():
    Base.metadata.create_all(get_engine())
    with get_session() as s:
        for pid in ("free", "pro", "advance"):
            s.add(Plan(id=pid, name=pid, description="", price_monthly_cents=0, currency="USD",
                       messages_per_day=30, tokens_per_month=150000, max_api_keys=5, rate_limit_per_min=1000,
                       allowed_models=None, priority=0, sort_order=0, is_active=1,
                       created_at=q.now_iso(), updated_at=q.now_iso()))
    app_mod.init_db = lambda: None
    app_mod.versions.sync_versions_to_db = lambda: None
    app_mod.deps.orquestador.iniciar = lambda: None
    app_mod.deps.orquestador.detener = lambda: None
    with TestClient(app_mod.app) as c:
        _registrar(c, "visuals-a@lixbon.test")
        yield c
    get_engine().dispose()
    shutil.rmtree(_DB_DIR, ignore_errors=True)


@pytest.fixture(scope="module")
def otro(cliente):
    with TestClient(app_mod.app) as c:
        _registrar(c, "visuals-b@lixbon.test")
        yield c


@pytest.fixture(scope="module")
def gratuito(cliente):
    with TestClient(app_mod.app) as c:
        _registrar(c, "visuals-free@lixbon.test", plan="free")
        yield c


def _crear(c, titulo="Landing", files=None, kind="design"):
    r = c.post("/api/visuals", json={"kind": kind, "title": titulo, "files": files})
    assert r.status_code == 201, r.text
    return r.json()


def _subir(c, vid, files, **extra):
    return c.post(f"/api/visuals/{vid}/files", json={"files": files, **extra})


def test_crear_con_archivos_y_leer(cliente):
    vis = _crear(cliente, files=[
        {"path": "index.html", "text": "<h1>Hola</h1>"},
        {"path": "post-1.png", "base64": PNG},
    ])
    assert vis["id"].startswith("vis_") and vis["version"] == 1 and vis["url"].endswith(f"/visuals/{vis['id']}")
    m = cliente.get(f"/api/visuals/{vis['id']}").json()
    assert {f["path"]: f["role"] for f in m["files"]} == {"index.html": "source", "post-1.png": "output"}
    html = cliente.get(f"/api/visuals/{vis['id']}/files/index.html")
    assert html.text == "<h1>Hola</h1>" and html.headers["content-security-policy"] == "sandbox allow-scripts"
    assert cliente.get(f"/api/visuals/{vis['id']}/files/post-1.png").content.startswith(b"\x89PNG")


def test_gratuito_no_crea_pero_ve_compartidos(cliente, gratuito):
    r = gratuito.post("/api/visuals", json={"kind": "design", "title": "x"})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "visuals_requires_plan"
    vis = _crear(cliente, files=[{"path": "index.html", "text": "público"}])
    token = cliente.post(f"/api/visuals/{vis['id']}/share").json()["token"]
    assert gratuito.get(f"/api/shared-visuals/{token}/files/index.html").text == "público"


def test_versiones_lineales_y_base_version(cliente):
    vis = _crear(cliente, files=[{"path": "a.html", "text": "uno"}, {"path": "a.png", "base64": PNG}])
    ruta = f"/api/visuals/{vis['id']}"
    assert _subir(cliente, vis["id"], [{"path": "a.html", "text": "dos"}], base_version=1).json()["version"] == 2
    r = _subir(cliente, vis["id"], [{"path": "a.html", "text": "pisado"}], base_version=1)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "stale_base" and r.json()["detail"]["latest_version"] == 2
    assert cliente.get(f"{ruta}/files/a.html").text == "dos"
    assert cliente.get(f"{ruta}/files/a.html?v=1").text == "uno"
    assert {f["path"] for f in cliente.get(ruta).json()["files"]} == {"a.html", "a.png"}


def test_rehacer_la_ultima_version(cliente):
    vis = _crear(cliente, files=[{"path": "a.html", "text": "uno"}, {"path": "b.html", "text": "b"}])
    ruta = f"/api/visuals/{vis['id']}"
    assert _subir(cliente, vis["id"], [{"path": "a.html", "text": "dos"}], base_version=1).json()["version"] == 2
    r = _subir(cliente, vis["id"], [{"path": "a.html", "text": "dos bis"}], base_version=2, amend=True)
    assert r.json()["version"] == 3
    assert [h["version"] for h in cliente.get(f"{ruta}/versions").json()["items"]] == [3, 1]
    assert cliente.get(f"{ruta}/files/a.html").text == "dos bis" and cliente.get(f"{ruta}/files/b.html").text == "b"
    assert cliente.get(f"{ruta}/files/a.html?v=1").text == "uno"
    r = _subir(cliente, vis["id"], [{"path": "b.html", "text": "b2"}], base_version=2, amend=True)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "stale_base"
    assert _subir(cliente, vis["id"], [{"path": "b.html", "text": "b2"}], base_version=3, amend=True).json()["version"] == 4
    assert cliente.get(f"{ruta}/files/a.html").text == "dos bis" and cliente.get(f"{ruta}/files/b.html").text == "b2"
    assert [h["version"] for h in cliente.get(f"{ruta}/versions").json()["items"]] == [4, 1]


def test_versiones_con_nombre(cliente):
    r = cliente.post("/api/visuals", json={"kind": "design", "title": "N", "label": "Landing inicial",
                                           "files": [{"path": "a.html", "text": "uno"}]})
    vid = r.json()["id"]
    ruta = f"/api/visuals/{vid}"
    _subir(cliente, vid, [{"path": "a.html", "text": "dos"}], base_version=1, label="  Titular   más grande ")
    _subir(cliente, vid, [{"path": "a.html", "text": "dos bis"}], base_version=2, amend=True)
    items = cliente.get(f"{ruta}/versions").json()["items"]
    assert [(i["version"], i["label"]) for i in items] == [(3, "Titular más grande"), (1, "Landing inicial")]
    assert cliente.get(ruta).json()["viewing_label"] == "Titular más grande"
    assert cliente.patch(f"{ruta}/versions/1", json={"label": "Primera idea"}).json()["label"] == "Primera idea"
    assert cliente.patch(f"{ruta}/versions/2", json={"label": "x"}).status_code == 404
    assert cliente.patch(f"{ruta}/versions/1", json={"label": "   "}).status_code == 400
    assert cliente.get(f"{ruta}?version=1").json()["viewing_label"] == "Primera idea"


@pytest.mark.parametrize("ruta", ["../x.html", "/abs.html", "a\\b.html", "x/../../y.html", "malware.exe", "sin_extension"])
def test_rutas_invalidas(cliente, ruta):
    vis = _crear(cliente)
    r = _subir(cliente, vis["id"], [{"path": ruta, "text": "x"}])
    assert r.status_code == 400 and r.json()["detail"]["code"] in ("invalid_path", "invalid_extension")


def test_aislamiento(cliente, otro):
    vis = _crear(cliente, files=[{"path": "a.html", "text": "privado"}])
    ruta = f"/api/visuals/{vis['id']}"
    assert otro.get(ruta).status_code == 404
    assert otro.get(f"{ruta}/files/a.html").status_code == 404
    assert _subir(otro, vis["id"], [{"path": "b.html", "text": "x"}]).status_code == 404
    assert otro.delete(ruta).status_code == 404
    assert otro.get(f"{ruta}/events").status_code == 404


def test_compartir_y_revocar(cliente):
    vis = _crear(cliente, files=[{"path": "a.html", "text": "<b>hola</b>"}])
    token = cliente.post(f"/api/visuals/{vis['id']}/share").json()["token"]
    assert cliente.get(f"/api/visuals/{vis['id']}").json()["share_token"] == token
    with TestClient(app_mod.app) as anonimo:
        m = anonimo.get(f"/api/shared-visuals/{token}").json()
        assert "id" not in m and "share_token" not in m
        assert anonimo.get(f"/api/visuals/{vis['id']}").status_code in (401, 403)
        cliente.delete(f"/api/visuals/{vis['id']}/share")
        assert anonimo.get(f"/api/shared-visuals/{token}").status_code == 404


def test_limites_del_plan(cliente, monkeypatch):
    uid = q.get_user_by_email("visuals-a@lixbon.test")["id"]
    with get_session() as s:
        s.get(Plan, "pro").visuals_max = 1
    try:
        r = cliente.post("/api/visuals", json={"kind": "design", "title": "uno más"})
        assert r.status_code == 403 and r.json()["detail"]["code"] == "visual_limit"
    finally:
        with get_session() as s:
            s.get(Plan, "pro").visuals_max = None
    vis = _crear(cliente)
    usado = store.user_storage_bytes(uid)
    with get_session() as s:
        s.get(Plan, "pro").visuals_max_mb = 1
    try:
        monkeypatch.setattr(store, "MB", max(1, usado + 10))
        r = _subir(cliente, vis["id"], [{"path": "grande.html", "text": "x" * 50}])
        assert r.status_code == 413 and r.json()["detail"]["code"] == "storage_limit"
    finally:
        with get_session() as s:
            s.get(Plan, "pro").visuals_max_mb = None


def test_aviso_en_vivo_al_escribir(cliente):
    vis = _crear(cliente)
    cola = bus.subscribe(vis["id"])
    try:
        _subir(cliente, vis["id"], [{"path": "a.html", "text": "nuevo"}], base_version=0)
        ev = cola.get_nowait()
        assert ev["type"] == "version" and ev["version"] == 1 and ev["files"] == ["a.html"]
    finally:
        bus.unsubscribe(vis["id"], cola)


def test_borrar(cliente):
    vis = _crear(cliente, files=[{"path": "a.html", "text": "x"}])
    assert cliente.delete(f"/api/visuals/{vis['id']}").json() == {"deleted": True}
    assert cliente.get(f"/api/visuals/{vis['id']}").status_code == 404


def test_renombrar_y_metadatos_sin_version(cliente, otro):
    vis = _crear(cliente, titulo="Antes", files=[{"path": "index.html", "text": "<h1>a</h1>"}])
    r = cliente.patch(f"/api/visuals/{vis['id']}", json={"title": "  Después ", "meta": {"conversation_id": "conv-123"}})
    assert r.status_code == 200, r.text
    assert r.json()["title"] == "Después" and r.json()["meta"]["conversation_id"] == "conv-123"
    assert cliente.get(f"/api/visuals/{vis['id']}").json()["version"] == vis["version"]
    assert cliente.patch(f"/api/visuals/{vis['id']}", json={"meta": {"otra": 1}}).json()["detail"]["code"] == "invalid_meta"
    assert cliente.patch(f"/api/visuals/{vis['id']}", json={"title": "  "}).json()["detail"]["code"] == "invalid_title"
    assert otro.patch(f"/api/visuals/{vis['id']}", json={"title": "x"}).status_code == 404


def test_buscar_por_conversacion_portada_e_historial(cliente, otro):
    vis = _crear(cliente, titulo="Chat", files=[{"path": "contacto.html", "text": "<p>c</p>"},
                                                {"path": "index.html", "text": "<p>i</p>"}])
    cliente.patch(f"/api/visuals/{vis['id']}", json={"meta": {"conversation_id": "conv-abc"}})
    _subir(cliente, vis["id"], [{"path": "index.html", "text": "<p>2</p>"}], base_version=vis["version"])
    items = cliente.get("/api/visuals", params={"conversation_id": "conv-abc"}).json()["items"]
    assert [i["id"] for i in items] == [vis["id"]]
    assert items[0]["cover"] == "index.html" and items[0]["pages"] == 2
    assert cliente.get("/api/visuals", params={"conversation_id": "conv-ab"}).json()["items"] == []
    assert otro.get("/api/visuals", params={"conversation_id": "conv-abc"}).json()["items"] == []
    hist = cliente.get(f"/api/visuals/{vis['id']}/versions").json()["items"]
    assert [h["version"] for h in hist] == [2, 1]
    assert hist[0]["sources"] == ["index.html"] and sorted(hist[1]["sources"]) == ["contacto.html", "index.html"]
    assert otro.get(f"/api/visuals/{vis['id']}/versions").status_code == 404
