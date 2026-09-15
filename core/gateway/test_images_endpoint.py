"""/api/images/*: elige un nodo con modelo de difusión y le pide la imagen por
el enlace; sin nodos, 503 claro. SQLite temporal + TestClient + enlace falso."""
import json
import os
import pathlib
import shutil
import tempfile

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_images_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'img.db').as_posix()}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.gateway import app as app_mod  # noqa: E402
from core.gateway.routers import images as images_mod  # noqa: E402
from core.orchestration.node_link import NodeLink, registro  # noqa: E402
from core.persistence import queries as q  # noqa: E402
from core.persistence.database import Base, get_engine, get_session  # noqa: E402
from core.persistence.models import Plan  # noqa: E402


class _WS:
    def __init__(self, link_ref, respuesta):
        self.link_ref = link_ref
        self.respuesta = respuesta
        self.peticiones = []

    async def send_text(self, texto):
        msg = json.loads(texto)
        if msg["type"] != "request":
            return
        self.peticiones.append(msg)
        link = self.link_ref[0]
        rid = msg["id"]
        link.entregar({"type": "response", "id": rid, "status": 200, "headers": {"content-type": "application/json"}})
        link.entregar({"type": "chunk", "id": rid, "data": json.dumps(self.respuesta)})
        link.entregar({"type": "end", "id": rid})


@pytest.fixture(scope="module")
def cliente():
    Base.metadata.create_all(get_engine())
    with get_session() as s:
        for pid, nombre in (("free", "Gratuito"), ("pro", "Pro")):
            if not s.get(Plan, pid):
                s.add(Plan(id=pid, name=nombre, description="", price_monthly_cents=0,
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
            "first_name": "Img", "last_name": "Gen",
            "email": "images@lixbon.test", "password": "contraseña-larga",
        })
        assert r.status_code in (200, 201), r.text
        yield c
    get_engine().dispose()
    shutil.rmtree(_DB_DIR, ignore_errors=True)


def _nodos(monkeypatch, lista):
    monkeypatch.setattr(app_mod.deps.orquestador, "estado_nodos", lambda: lista)


def _plan(email, plan_id):
    q.set_user_plan(q.get_user_by_email(email)["id"], plan_id)


def test_visuals_solo_pro_y_advance(cliente, monkeypatch):
    _nodos(monkeypatch, [{"id": "gpu-a", "online": True, "score": 90, "metricas": {"image_model": "flux"}}])
    _plan("images@lixbon.test", "free")
    r = cliente.post("/api/images/generate", json={"prompt": "un café"})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "visuals_requires_plan"
    _plan("images@lixbon.test", "pro")


def test_sin_nodos_de_imagen_503(cliente, monkeypatch):
    _nodos(monkeypatch, [{"id": "gpu-a", "online": True, "score": 90, "metricas": {}}])
    assert cliente.get("/api/images/status").json() == {"available": False, "model": None, "nodes": []}
    r = cliente.post("/api/images/generate", json={"prompt": "un café"})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "no_image_node"


def test_genera_en_el_mejor_nodo_y_guarda_en_la_conversacion(cliente, monkeypatch):
    _nodos(monkeypatch, [
        {"id": "gpu-lento", "name": "L", "online": True, "score": 40, "metricas": {"image_model": "sdxl-turbo"}},
        {"id": "gpu-img", "name": "I", "online": True, "score": 95, "metricas": {"image_model": "flux-schnell"}},
        {"id": "gpu-off", "name": "O", "online": False, "score": 99, "metricas": {"image_model": "flux-schnell"}},
    ])
    ref = []
    ws = _WS(ref, {"image_base64": "QUJD", "mime": "image/jpeg", "seed": 7, "width": 512, "height": 512,
                   "model": "flux-schnell", "ms": 1200})
    link = NodeLink("gpu-img", ws)
    ref.append(link)
    registro.registrar(link)
    try:
        estado = cliente.get("/api/images/status").json()
        assert estado["available"] and estado["model"] == "flux-schnell"
        r = cliente.post("/api/images/generate", json={
            "prompt": "un café de especialidad", "width": 500, "height": 512, "conversation_id": "conv-img-1",
        })
        assert r.status_code == 200, r.text
        cuerpo = r.json()
        assert cuerpo["image_base64"] == "QUJD" and cuerpo["node"] == "gpu-img" and cuerpo["seed"] == 7
        pedido = ws.peticiones[0]
        assert pedido["path"] == "/images/generate" and pedido["body"]["prompt"] == "un café de especialidad"
        mensajes = cliente.get("/api/conversations/conv-img-1/messages").json()["messages"]
        assert [m["role"] for m in mensajes] == ["user", "assistant"]
        assert mensajes[1]["content"].startswith("![un café de especialidad](data:image/jpeg;base64,QUJD)")
    finally:
        registro.quitar(link)


def test_exige_sesion():
    with TestClient(app_mod.app) as anonimo:
        assert anonimo.post("/api/images/generate", json={"prompt": "x"}).status_code in (401, 403)
