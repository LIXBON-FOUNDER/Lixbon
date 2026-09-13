"""Alias públicos: el cliente habla en `lixbon-1`, Ollama recibe el real."""
import asyncio

from core.inference import aliases
from core.inference.aliases import public_catalog, to_public, to_real

ROWS = [
    {"alias": "lixbon-1", "name": "Lixbon 1", "model": "qwen3.5:27b", "sort_order": 0, "description": "el grande"},
    {"alias": "lixbon-mini", "name": "Lixbon Mini", "model": "qwen3.5:4b", "sort_order": 1},
]
CATALOGO = [
    {"id": "qwen3.5:27b", "capabilities": ["tools", "vision"], "num_ctx": 32768},
    {"id": "qwen3.5:4b", "capabilities": ["tools"]},
    {"id": "nomic-embed-text:latest", "capabilities": ["embedding"]},
]


def test_traduce_en_ambos_sentidos():
    assert to_real("lixbon-1", ROWS) == "qwen3.5:27b"
    assert to_real("qwen3.5:27b", ROWS) == "qwen3.5:27b"
    assert to_real("", ROWS) == "" and to_real(None, ROWS) is None
    assert to_public("qwen3.5:4b", ROWS) == "lixbon-mini"
    assert to_public("desconocido", ROWS) == "desconocido"


def test_catalogo_publico_oculta_lo_que_no_tiene_alias():
    pub = public_catalog(CATALOGO, include_raw=False, rows=ROWS)
    assert [e["id"] for e in pub] == ["lixbon-1", "lixbon-mini"]
    assert pub[0]["name"] == "Lixbon 1" and pub[0]["capabilities"] == ["tools", "vision"]
    assert pub[0]["num_ctx"] == 32768 and pub[0]["model"] == "qwen3.5:27b" and pub[0]["alias"] is True


def test_admin_ve_tambien_los_modelos_sin_alias():
    pub = public_catalog(CATALOGO, include_raw=True, rows=ROWS)
    assert [e["id"] for e in pub] == ["lixbon-1", "lixbon-mini", "nomic-embed-text:latest"]


def test_sin_alias_el_catalogo_queda_igual():
    pub = public_catalog(CATALOGO, include_raw=False, rows=[])
    assert [e["id"] for e in pub] == [e["id"] for e in CATALOGO]
    assert pub[0]["name"] == "qwen3.5:27b"


def test_alias_cuyo_modelo_no_esta_online_no_aparece():
    filas = ROWS + [{"alias": "lixbon-x", "name": "X", "model": "no-instalado", "sort_order": 2}]
    assert "lixbon-x" not in [e["id"] for e in public_catalog(CATALOGO, rows=filas)]


def test_model_for_request_pide_el_real_a_ollama(monkeypatch):
    from core.gateway import model_router

    monkeypatch.setattr(aliases, "alias_rows", lambda: ROWS)

    async def catalogo():
        return CATALOGO

    monkeypatch.setattr(model_router, "fetch_models", catalogo)
    model, _ = asyncio.run(model_router.model_for_request("lixbon-1", "chat", {}))
    assert model == "qwen3.5:27b"
    model, _ = asyncio.run(model_router.model_for_request("", "chat", {"key_model": "lixbon-mini"}))
    assert model == "qwen3.5:4b"
