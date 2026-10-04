"""Renders de Visuals: cola con cuota y sin duplicados, worker (éxito, fallo, reintento,
arrendamiento vencido), render automático tras editar, avisos del worker con token y
la barrera de red del renderizador. SQLite + TestClient; el render real se simula."""
import os
import pathlib
import shutil
import socket
import tempfile
from datetime import datetime, timedelta, timezone

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_renders_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'rj.db').as_posix()}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.gateway import app as app_mod  # noqa: E402
from core.gateway.visual_events import bus  # noqa: E402
from core.persistence import queries as q  # noqa: E402
from core.persistence import visual_renders as renders  # noqa: E402
from core.persistence.database import Base, get_engine, get_session  # noqa: E402
from core.persistence.models import Plan, VisualRenderJob  # noqa: E402
from core.render import renderer, worker  # noqa: E402

PIEZA = '<!doctype html><html><head><meta name="render" content="image 1080x1350"></head><body>{}</body></html>'
REEL = '<!doctype html><html><head><meta name="render" content="video 1080x1920 4"></head><body>reel</body></html>'


def fake_render(html, kind, w, h, seconds, **_):
    return (b"\x89PNG" if kind == "image" else b"MP4") + html.encode()[-20:]


@pytest.fixture(scope="module")
def cliente():
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
        c.post("/api/auth/register", json={"first_name": "R", "last_name": "J",
                                           "email": "render@lixbon.test", "password": "contraseña-larga"})
        q.set_user_plan(q.get_user_by_email("render@lixbon.test")["id"], "pro")
        yield c
    get_engine().dispose()
    shutil.rmtree(_DB_DIR, ignore_errors=True)


@pytest.fixture(autouse=True)
def cola_limpia():
    with get_session() as s:
        s.query(VisualRenderJob).delete()
    yield


def _visual(c, files):
    r = c.post("/api/visuals", json={"kind": "marketing", "title": "Campaña", "files": files})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _procesar(notify=lambda ev: None, render_fn=fake_render):
    eventos = []
    hecho = worker.process_one("test-worker", render_fn=render_fn, notify=lambda ev: (eventos.append(ev), notify(ev)))
    return hecho, eventos


def test_encola_sin_duplicar_y_valida_fuentes(cliente):
    vid = _visual(cliente, [{"path": "post-1.html", "text": PIEZA.format("uno")},
                            {"path": "notas.md", "text": "# notas"}])
    r = cliente.post(f"/api/visuals/{vid}/render", json={})
    assert r.status_code == 202
    jobs = r.json()["jobs"]
    assert [(j["path"], j["kind"], j["status"]) for j in jobs] == [("post-1.html", "image", "queued")]
    again = cliente.post(f"/api/visuals/{vid}/render", json={"paths": ["post-1.html"]}).json()["jobs"]
    assert again[0]["id"] == jobs[0]["id"]
    r = cliente.post(f"/api/visuals/{vid}/render", json={"paths": ["notas.md"]})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "not_renderable"


def test_worker_guarda_la_salida_con_el_sha_de_su_fuente(cliente):
    vid = _visual(cliente, [{"path": "post-1.html", "text": PIEZA.format("uno")}])
    cliente.post(f"/api/visuals/{vid}/render", json={})
    hecho, eventos = _procesar()
    assert hecho and eventos[0]["status"] == "done" and eventos[0]["output_path"] == "post-1.png"
    m = cliente.get(f"/api/visuals/{vid}").json()
    files = {f["path"]: f for f in m["files"]}
    assert files["post-1.png"]["role"] == "output" and m["version"] == 2
    assert files["post-1.png"]["meta"]["source_sha256"] == files["post-1.html"]["sha256"]
    assert cliente.get(f"/api/visuals/{vid}/files/post-1.png").content.startswith(b"\x89PNG")
    assert renders.stale_outputs(vid, q.get_user_by_email("render@lixbon.test")["id"]) == []
    assert cliente.get(f"/api/visuals/{vid}/renders").json()["jobs"][0]["status"] == "done"
    assert _procesar() == (False, [])


def test_editar_una_pieza_renderizada_la_vuelve_a_renderizar(cliente):
    vid = _visual(cliente, [{"path": "post-1.html", "text": PIEZA.format("uno")},
                            {"path": "post-2.html", "text": PIEZA.format("dos")}])
    cliente.post(f"/api/visuals/{vid}/render", json={"paths": ["post-1.html"]})
    _procesar()
    r = cliente.post(f"/api/visuals/{vid}/files", json={
        "files": [{"path": "post-1.html", "text": PIEZA.format("uno editado")}, {"path": "post-2.html", "text": PIEZA.format("dos b")}],
        "base_version": 2})
    auto = r.json()["renders"]
    assert [(j["path"], j["status"]) for j in auto] == [("post-1.html", "queued")]  # post-2 nunca se renderizó
    _procesar()
    files = {f["path"]: f for f in cliente.get(f"/api/visuals/{vid}").json()["files"]}
    assert files["post-1.png"]["meta"]["source_sha256"] == files["post-1.html"]["sha256"]
    with get_session() as s:
        assert s.query(VisualRenderJob).filter_by(visual_id=vid, origin="auto").count() == 1


def test_cuota_diaria_y_plan_gratuito(cliente):
    vid = _visual(cliente, [{"path": "a.html", "text": PIEZA.format("a")}, {"path": "b.html", "text": PIEZA.format("b")},
                            {"path": "reel.html", "text": REEL}])
    with get_session() as s:
        s.get(Plan, "pro").visual_renders_per_day = 1
        s.get(Plan, "pro").visual_video_renders_per_day = 0
    try:
        assert cliente.post(f"/api/visuals/{vid}/render", json={"paths": ["a.html"]}).status_code == 202
        r = cliente.post(f"/api/visuals/{vid}/render", json={"paths": ["b.html"]})
        assert r.status_code == 429 and r.json()["detail"]["code"] == "render_limit"
        r = cliente.post(f"/api/visuals/{vid}/render", json={"paths": ["reel.html"]})
        assert r.status_code == 429 and "vídeo" in r.json()["detail"]["message"]
    finally:
        with get_session() as s:
            s.get(Plan, "pro").visual_renders_per_day = None
            s.get(Plan, "pro").visual_video_renders_per_day = None
    uid = q.get_user_by_email("render@lixbon.test")["id"]
    q.set_user_plan(uid, "free")
    try:
        r = cliente.post(f"/api/visuals/{vid}/render", json={"paths": ["b.html"]})
        assert r.status_code == 403 and r.json()["detail"]["code"] == "visuals_requires_plan"
    finally:
        q.set_user_plan(uid, "pro")


def test_fallos_reintentos_y_arrendamiento(cliente):
    vid = _visual(cliente, [{"path": "a.html", "text": PIEZA.format("a")}, {"path": "b.html", "text": PIEZA.format("b")}])
    cliente.post(f"/api/visuals/{vid}/render", json={"paths": ["a.html"]})

    def malo(*a, **k):
        raise renderer.RenderError("Tamaño fuera de rango")
    _, ev = _procesar(render_fn=malo)
    assert ev[0]["status"] == "failed"  # error del contenido: sin reintento

    cliente.post(f"/api/visuals/{vid}/render", json={"paths": ["b.html"]})

    def caido(*a, **k):
        raise OSError("el navegador se cerró")
    for intento in range(renders.MAX_ATTEMPTS):
        _, ev = _procesar(render_fn=caido)
        assert ev[0]["status"] == ("failed" if intento == renders.MAX_ATTEMPTS - 1 else "queued")

    cliente.post(f"/api/visuals/{vid}/render", json={"paths": ["a.html"]})
    job = renders.claim("muerto")
    assert renders.claim("otro") is None
    with get_session() as s:
        s.get(VisualRenderJob, job["id"]).lease_until = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    assert renders.claim("otro")["id"] == job["id"]


def test_aviso_interno_del_worker(cliente, monkeypatch):
    evento = {"type": "render", "visual_id": "vis_x", "status": "done", "path": "a.html", "version": 3}
    assert cliente.post("/api/internal/render-events", json=evento).status_code == 403
    monkeypatch.setenv("RENDER_WORKER_TOKEN", "secreto")
    assert cliente.post("/api/internal/render-events", json=evento, headers={"X-Render-Token": "otro"}).status_code == 403
    cola = bus.subscribe("vis_x")
    try:
        r = cliente.post("/api/internal/render-events", json=evento, headers={"X-Render-Token": "secreto"})
        assert r.status_code == 204 and cola.get_nowait()["version"] == 3
    finally:
        bus.unsubscribe("vis_x", cola)


def test_mcp_visual_render(cliente):
    r = cliente.post("/api/keys", json={"name": "mcp"})
    key = r.json().get("key") or r.json().get("api_key")
    vid = _visual(cliente, [{"path": "post-1.html", "text": PIEZA.format("mcp")}])
    with TestClient(app_mod.app) as agente:
        agente.headers["Authorization"] = f"Bearer {key}"

        def call(name, **args):
            return agente.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                             "params": {"name": name, "arguments": args}}).json()["result"]["structuredContent"]
        assert call("visual_render", id=vid)["jobs"][0]["status"] == "queued"
        _procesar()
        assert call("visual_render_status", id=vid)["jobs"][0]["output_path"] == "post-1.png"


@pytest.mark.parametrize("url,ok", [
    ("http://127.0.0.1:8000/admin", False), ("http://localhost/", False), ("http://10.0.0.5/", False),
    ("http://169.254.169.254/latest/meta-data/", False), ("http://[::1]/", False),
    ("https://cdn.tailwindcss.com/", True), ("data:image/png;base64,AAA", True), ("ftp://x/", False),
])
def test_barrera_de_red(monkeypatch, url, ok):
    publicas = {"cdn.tailwindcss.com": "104.18.1.1"}

    def resolver(host, *a, **k):
        ip = publicas.get(host) or ("127.0.0.1" if host == "localhost" else host.strip("[]"))
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))]
    monkeypatch.setattr(renderer.socket, "getaddrinfo", resolver)
    assert renderer.allow_url(url, pathlib.Path(tempfile.gettempdir()) / "site", {}) is ok


def test_fuentes_de_marca_siempre_inyectadas():
    sin_declarar = "<html><head><style>h1{font-family:'Geist'}</style></head><body><h1>x</h1></body></html>"
    out = renderer.prepare_html(sin_declarar)
    assert out.index("data-lixbon-fonts") < out.index("h1{font-family")
    assert "@font-face{font-family:'Geist';src:url('file:" in out and "geist-latin.woff2" in out
    assert renderer.prepare_html("<h1>sin head</h1>").startswith("<style data-lixbon-fonts>")


def test_barrera_de_archivos(tmp_path):
    site = tmp_path / "site"
    assert renderer.allow_url((site / "piezas" / "post.html").as_uri(), site, {})
    assert renderer.allow_url((site / "capturas" / "ide.png").as_uri(), site, {})
    assert renderer.allow_url((renderer.ASSETS_DIR / "fonts" / "geist-latin.woff2").as_uri(), site, {})
    assert not renderer.allow_url((tmp_path / "otro.txt").as_uri(), site, {})
    assert not renderer.allow_url(pathlib.Path(os.path.expanduser("~")).joinpath(".lixbon", "config.json").as_uri(), site, {})


def test_el_worker_recibe_los_archivos_del_visual(cliente):
    vid = _visual(cliente, [{"path": "piezas/post-1.html", "text": PIEZA.format('<img src="../capturas/ide.png">')},
                            {"path": "capturas/ide.png", "base64": "iVBORw0KGgo="}])
    cliente.post(f"/api/visuals/{vid}/render", json={})
    visto = {}

    def espia(html, kind, w, h, seconds, path, assets):
        visto.update(path=path, assets=sorted(assets))
        return b"\x89PNG"
    _procesar(render_fn=espia)
    assert visto == {"path": "piezas/post-1.html", "assets": ["capturas/ide.png"]}


def test_mcp_ver_pieza_y_esperar_renders(cliente):
    import base64 as b64
    import threading
    r = cliente.post("/api/keys", json={"name": "mcp-view"})
    key = r.json().get("key") or r.json().get("api_key")
    vid = _visual(cliente, [{"path": "post-1.html", "text": PIEZA.format("ver")}, {"path": "reel.html", "text": REEL}])
    with TestClient(app_mod.app) as agente:
        agente.headers["Authorization"] = f"Bearer {key}"

        def call(name, **args):
            return agente.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                             "params": {"name": name, "arguments": args}}).json()["result"]

        sin = call("visual_view", id=vid, path="post-1.html")
        assert sin["isError"] and '"not_rendered"' in sin["content"][0]["text"]

        call("visual_render", id=vid)
        hilo = threading.Timer(1.0, lambda: (_procesar(), _procesar()))
        hilo.start()
        estado = call("visual_render_status", id=vid, wait_seconds=15)["structuredContent"]
        hilo.join()
        assert {j["path"]: j["status"] for j in estado["jobs"]} == {"post-1.html": "done", "reel.html": "done"}

        for ruta in ("post-1.html", "post-1.png"):
            vista = call("visual_view", id=vid, path=ruta)
            imagen, nota = vista["content"]
            assert imagen["type"] == "image" and imagen["mimeType"] == "image/png"
            assert b64.b64decode(imagen["data"]).startswith(b"\x89PNG") and "post-1.png" in nota["text"]
        video = call("visual_view", id=vid, path="reel.html")
        assert video["isError"] and '"not_viewable"' in video["content"][0]["text"]

        cliente.post(f"/api/visuals/{vid}/files", json={"files": [{"path": "post-1.html", "text": PIEZA.format("cambiada")}]})
        with get_session() as s:
            s.query(VisualRenderJob).filter_by(visual_id=vid, status="queued").delete()
        assert "DESACTUALIZADA" in call("visual_view", id=vid, path="post-1.html")["content"][1]["text"]
