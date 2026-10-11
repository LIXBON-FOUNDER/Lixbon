"""Qué tráfico por API key se cobra con créditos y cuál con el pool del plan."""
import pytest

from core.gateway.routers.chat import _is_external_api


def _usuario(key_name, auth_via="api_key"):
    return {"id": 1, "auth_via": auth_via, "key_name": key_name}


@pytest.mark.parametrize("key_name", ["lixbon Desktop", "lixbon CLI", "Lixbon Mobile", "mi script"])
@pytest.mark.parametrize("plan", ["free", "pro"])
def test_una_api_key_siempre_usa_creditos(key_name, plan):
    assert _is_external_api(_usuario(key_name), {"id": plan})


def test_sesion_web_no_es_api_externa():
    assert not _is_external_api(_usuario(None, auth_via="cookie"), {"id": "free"})


def _sesion(client):
    return {"id": 1, "auth_via": "session", "client": client}


@pytest.mark.parametrize("client", ["desktop", "cli"])
def test_sesion_desktop_y_cli_free_usan_creditos(client):
    assert _is_external_api(_sesion(client), {"id": "free"})


@pytest.mark.parametrize("client", ["desktop", "cli"])
def test_sesion_desktop_y_cli_pro_usan_el_pool(client):
    assert not _is_external_api(_sesion(client), {"id": "pro"})


@pytest.mark.parametrize("client", ["web", "mobile"])
def test_sesion_web_y_movil_usan_el_pool(client):
    assert not _is_external_api(_sesion(client), {"id": "free"})
