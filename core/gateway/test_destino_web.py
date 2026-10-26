"""Redirecciones de la web pública: portada al chat, páginas de empresa a
founder.lixbon.com y URLs antiguas bajo /en a su ruta sin prefijo."""
import pytest

from core.gateway.app import FOUNDER_URL, destino_web


@pytest.mark.parametrize("ruta, esperado", [
    ("", ("/chat", 302)),
    ("es", ("/es/chat", 302)),
    ("team", (f"{FOUNDER_URL}/team", 301)),
    ("es/legal/terms", (f"{FOUNDER_URL}/es/legal/terms", 301)),
    ("plans", None),
    ("es/docs/billing", None),
    ("environments", None),
])
def test_destino_web(ruta, esperado):
    assert destino_web(ruta) == esperado


@pytest.mark.parametrize("ruta, esperado", [
    ("en/plans", ("/plans", 301)),
    ("en/docs/plans", ("/docs/plans", 301)),
    ("en/guides/qwen-3-5-python/", ("/guides/qwen-3-5-python", 301)),
    # Sin encadenar: lo que era de empresa va directo a founder.
    ("en/legal/refunds", (f"{FOUNDER_URL}/legal/refunds", 301)),
    ("en", ("/chat", 302)),
    ("en/", ("/chat", 302)),
])
def test_prefijo_en_antiguo(ruta, esperado):
    assert destino_web(ruta) == esperado
