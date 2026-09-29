"""Tests del envío push por FCM con una cuenta de servicio de prueba."""
import asyncio
import json

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from core.gateway import deps, push


class _Resp:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body
        self.text = json.dumps(body)

    def json(self):
        return self._body


class _Client:
    def __init__(self, fcm_status=200):
        self.calls = []
        self.fcm_status = fcm_status

    async def post(self, url, **kw):
        self.calls.append((url, kw))
        if "oauth2" in url:
            return _Resp(200, {"access_token": "tok", "expires_in": 3600})
        if "fcm.googleapis.com" in url:
            if self.fcm_status == 404:
                return _Resp(404, {"error": {"status": "NOT_FOUND", "details": [{"errorCode": "UNREGISTERED"}]}})
            return _Resp(200, {"name": "projects/p/messages/1"})
        return _Resp(200, {"data": [{"status": "ok"}]})


@pytest.fixture()
def account(monkeypatch):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    monkeypatch.setenv("FCM_SERVICE_ACCOUNT", json.dumps({
        "project_id": "lixbon-test", "client_email": "push@lixbon-test.iam.gserviceaccount.com",
        "private_key": pem, "token_uri": "https://oauth2.googleapis.com/token",
    }))
    monkeypatch.setattr(push, "_account", None)
    monkeypatch.setattr(push, "_access", None)


def _run(monkeypatch, client, tokens, deleted):
    monkeypatch.setattr(deps, "http_client_fast", client)
    monkeypatch.setattr(push, "list_device_tokens", lambda uid: tokens)
    monkeypatch.setattr(push, "delete_device_token", deleted.append)
    asyncio.run(push.send_push(1, "Claude Code en remoto", "Arreglar login · api", {"kind": "remote_session", "session_id": "abc"}))


def test_fcm_manda_un_mensaje_de_datos_que_entiende_expo_notifications(monkeypatch, account):
    client, deleted = _Client(), []
    _run(monkeypatch, client, ["fcm-token-1"], deleted)
    url, kw = next(c for c in client.calls if "fcm.googleapis.com" in c[0])
    assert url.endswith("/projects/lixbon-test/messages:send")
    assert kw["headers"]["Authorization"] == "Bearer tok"
    msg = kw["json"]["message"]
    assert msg["token"] == "fcm-token-1"
    assert msg["android"]["priority"] == "high"
    assert msg["data"]["title"] == "Claude Code en remoto"
    assert msg["data"]["channelId"] == push.ANDROID_CHANNEL
    assert json.loads(msg["data"]["body"]) == {"kind": "remote_session", "session_id": "abc"}
    assert all(isinstance(v, str) for v in msg["data"].values())
    assert deleted == []


def test_token_dado_de_baja_se_borra(monkeypatch, account):
    client, deleted = _Client(fcm_status=404), []
    _run(monkeypatch, client, ["fcm-viejo"], deleted)
    assert deleted == ["fcm-viejo"]


def test_tokens_de_expo_siguen_yendo_por_expo(monkeypatch, account):
    client, deleted = _Client(), []
    _run(monkeypatch, client, ["ExponentPushToken[x]"], deleted)
    assert [c[0] for c in client.calls] == [push.EXPO_PUSH_URL]


def test_sin_cuenta_de_servicio_no_llama_a_fcm(monkeypatch):
    monkeypatch.delenv("FCM_SERVICE_ACCOUNT", raising=False)
    monkeypatch.setattr(push, "_account", None)
    client, deleted = _Client(), []
    _run(monkeypatch, client, ["fcm-token-1"], deleted)
    assert client.calls == []
