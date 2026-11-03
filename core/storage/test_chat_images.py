"""Imágenes del chat: qué se guarda con el mensaje y qué URL ve el cliente."""
import base64
import json

from core.storage import chat_images

JPEG = base64.b64encode(b"\xff\xd8\xff\xe0" + b"0" * 64).decode()
PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 64).decode()


def test_sin_r2_se_guardan_en_linea(monkeypatch):
    monkeypatch.setattr(chat_images, "r2_configured", lambda: False)
    guardado = chat_images.guardar(1, "conv-1234", [JPEG, PNG, "no-es-base64!!", base64.b64encode(b"texto").decode()])
    lista = json.loads(guardado)
    assert [x.split(";")[0] for x in lista] == ["data:image/jpeg", "data:image/png"]
    assert chat_images.urls("conv-1234", guardado) == lista


def test_con_r2_sube_y_devuelve_la_url_del_endpoint(monkeypatch):
    subidas = {}
    monkeypatch.setattr(chat_images, "r2_configured", lambda: True)
    monkeypatch.setattr(chat_images.r2, "upload_bytes", lambda k, d, t: subidas.setdefault(k, (d, t)))
    guardado = chat_images.guardar(7, "conv-1234", [JPEG])
    (token,) = json.loads(guardado)
    assert list(subidas) == [f"chat-images/7/conv-1234/{token}"]
    assert chat_images.urls("conv-1234", guardado) == [f"/api/chat-images/conv-1234/{token}"]


def test_un_fallo_de_r2_no_rompe_el_mensaje(monkeypatch):
    monkeypatch.setattr(chat_images, "r2_configured", lambda: True)

    def falla(*_):
        raise RuntimeError("R2 caído")

    monkeypatch.setattr(chat_images.r2, "upload_bytes", falla)
    assert chat_images.guardar(7, "conv-1234", [JPEG]) is None


def test_leer_valida_token_y_conversacion(monkeypatch):
    pedidas = []
    monkeypatch.setattr(chat_images.r2, "get_object_bytes", lambda k: pedidas.append(k) or b"x")
    assert chat_images.leer(1, "conv-1234", "../../otro.jpg") is None
    assert chat_images.leer(1, "../x", "a" * 32 + ".jpg") is None
    assert chat_images.leer(1, "conv-1234", "a" * 32 + ".jpg") == (b"x", "image/jpeg")
    assert pedidas == ["chat-images/1/conv-1234/" + "a" * 32 + ".jpg"]
