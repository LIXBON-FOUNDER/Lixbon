"""Qué tráfico por API key se cobra con créditos y cuál con el pool del plan."""
import pytest

from core.gateway.routers.chat import _is_external_api


def _usuario(key_name, auth_via="api_key"):
    return {"id": 1, "auth_via": auth_via, "key_name": key_name}


@pytest.mark.parametrize("key_name", ["lixbon Desktop", "Lixbon IDE", "lixbon CLI"])
def test_desktop_y_cli_pro_usan_el_pool_del_plan(key_name):
    assert not _is_external_api(_usuario(key_name), {"id": "pro"})


@pytest.mark.parametrize("key_name", ["lixbon Desktop", "Lixbon IDE", "lixbon CLI"])
def test_desktop_y_cli_free_usan_creditos(key_name):
    assert _is_external_api(_usuario(key_name), {"id": "free"})


def test_key_creada_a_mano_siempre_usa_creditos():
    assert _is_external_api(_usuario("mi script"), {"id": "pro"})


def test_movil_siempre_usa_el_pool_del_plan():
    assert not _is_external_api(_usuario("Lixbon Mobile"), {"id": "free"})


def test_sesion_web_no_es_api_externa():
    assert not _is_external_api(_usuario(None, auth_via="cookie"), {"id": "free"})
