"""Imágenes del chat remoto: el host sube con el id que ya mandó en el evento
y el dueño de la sesión las lee a través del gateway."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from core.gateway.routers import remote

SESS = {"id": "s1", "user_id": 7, "status": "online", "title": "t", "agent": "lixbon"}
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32


@pytest.fixture
def store(monkeypatch):
    objetos = {}
    monkeypatch.setattr(remote, "_owner_required", lambda *a, **k: dict(SESS))
    monkeypatch.setattr(remote.r2, "upload_bytes", lambda key, data, mime=None: objetos.__setitem__(key, (data, mime)))

    def leer(key):
        if key not in objetos:
            raise KeyError(key)
        return objetos[key][0]

    monkeypatch.setattr(remote.r2, "get_object_bytes", leer)
    app = FastAPI()
    app.include_router(remote.router)
    with TestClient(app) as c:
        yield c, objetos


def test_subir_y_leer_una_imagen(store):
    client, objetos = store
    r = client.put("/api/remote/sessions/s1/images/abcdef0123.png", content=PNG, headers={"Content-Type": "image/png"})
    assert r.status_code == 200 and r.json() == {"id": "abcdef0123.png"}
    assert objetos["remote/s1/abcdef0123.png"] == (PNG, "image/png")
    r = client.get("/api/remote/sessions/s1/images/abcdef0123.png")
    assert r.status_code == 200 and r.content == PNG
    assert r.headers["content-type"] == "image/png"


def test_lo_que_no_es_imagen_o_no_encaja_se_rechaza(store):
    client, objetos = store
    assert client.put("/api/remote/sessions/s1/images/abcdef0123.png", content=b"x", headers={"Content-Type": "text/plain"}).status_code == 415
    assert client.put("/api/remote/sessions/s1/images/abcdef0123.jpg", content=PNG, headers={"Content-Type": "image/png"}).status_code == 415
    assert client.put("/api/remote/sessions/s1/images/..%2Fotra.png", content=PNG, headers={"Content-Type": "image/png"}).status_code == 404
    grande = b"0" * (remote.REMOTE_IMAGE_MAX_BYTES + 1)
    assert client.put("/api/remote/sessions/s1/images/abcdef0123.png", content=grande, headers={"Content-Type": "image/png"}).status_code == 413
    assert objetos == {}


def test_una_imagen_que_aun_no_llega_es_404(store):
    client, _ = store
    assert client.get("/api/remote/sessions/s1/images/abcdef0123.webp").status_code == 404
