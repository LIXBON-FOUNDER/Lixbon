"""Login con GitHub: qué correo se acepta y cómo se arma la redirección.

No toca la red ni la BD: el cliente HTTP de GitHub se sustituye por uno falso.
"""
import asyncio
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi import HTTPException

from core.gateway.routers import oauth


class _Resp:
    def __init__(self, data, status=200):
        self._data = data
        self.status_code = status

    def json(self):
        return self._data


class _FakeClient:
    def __init__(self, emails, profile=None, token="gho_x"):
        self.emails = emails
        self.profile = profile or {"login": "ada", "name": "Ada Lovelace"}
        self.token = token

    def __call__(self, *a, **kw):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, **kw):
        return _Resp({"access_token": self.token} if self.token else {"error": "bad_verification_code"})

    async def get(self, url, **kw):
        return _Resp(self.emails if url.endswith("/emails") else self.profile)


def _claims(monkeypatch, client):
    monkeypatch.setattr(oauth.httpx, "AsyncClient", client)
    return asyncio.run(oauth._github_claims("code", "https://x/cb"))


def test_prefiere_el_correo_principal_verificado(monkeypatch):
    c = _claims(monkeypatch, _FakeClient([
        {"email": "otro@x.dev", "verified": True, "primary": False},
        {"email": "ada@x.dev", "verified": True, "primary": True},
    ]))
    assert c == {"email": "ada@x.dev", "email_verified": True, "given_name": "Ada", "family_name": "Lovelace"}


def test_nunca_usa_un_correo_sin_verificar(monkeypatch):
    c = _claims(monkeypatch, _FakeClient([
        {"email": "victima@x.dev", "verified": False, "primary": True},
        {"email": "ada@x.dev", "verified": True, "primary": False},
    ]))
    assert c["email"] == "ada@x.dev"
    with pytest.raises(HTTPException) as e:
        _claims(monkeypatch, _FakeClient([{"email": "victima@x.dev", "verified": False, "primary": True}]))
    assert e.value.status_code == 400


def test_codigo_rechazado_por_github(monkeypatch):
    with pytest.raises(HTTPException) as e:
        _claims(monkeypatch, _FakeClient([], token=None))
    assert e.value.status_code == 502


def test_proveedores_y_redireccion(monkeypatch):
    monkeypatch.setattr(oauth, "GITHUB_CLIENT_ID", "cid")
    monkeypatch.setattr(oauth, "GITHUB_CLIENT_SECRET", "sec")
    monkeypatch.setattr(oauth, "GOOGLE_CLIENT_ID", "")
    assert asyncio.run(oauth.oauth_providers()) == {"providers": ["github"]}
    assert not oauth._provider_configured("apple")

    class Req:
        base_url = "https://lixbon.com/"
        client = None

    monkeypatch.setattr(oauth, "check_auth_rate_limit", lambda ip: None)
    resp = asyncio.run(oauth.oauth_start("github", Req(), "http://127.0.0.1:5555/callback", "c" * 43))
    loc = urlparse(resp.headers["location"])
    q = parse_qs(loc.query)
    assert loc.netloc == "github.com"
    assert q["client_id"] == ["cid"]
    assert q["scope"] == ["read:user user:email"]
    assert oauth._verify_state(q["state"][0])["r"] == "http://127.0.0.1:5555/callback"
