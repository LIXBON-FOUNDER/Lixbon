"""`redirect_uri` del login OAuth: solo destinos propios. urlparse y los navegadores
leen distinto algunas URLs (`\\` cuenta como `/` en un navegador), así que se rechazan."""
import pytest
from fastapi import HTTPException

from core.gateway.routers.oauth import _validate_redirect_uri


@pytest.mark.parametrize("uri", [
    "lixbon://auth",
    "lixbon://auth/callback?x=1",
    "exp://192.168.1.5:8081/--/auth",
    "http://localhost:3000/cb",
    "https://localhost/cb",
    "http://127.0.0.1:8081/x",
])
def test_acepta_destinos_propios(uri):
    assert _validate_redirect_uri(uri) == uri


@pytest.mark.parametrize("uri", [
    "https://evil.com/cb",
    "//evil.com/cb",
    "javascript:alert(1)",
    "",
    # Trampas urlparse/navegador
    "https://evil.com\\@localhost/",
    "https://evil.com\\@127.0.0.1/",
    "https://localhost\\.evil.com/",
    "lixbon://x\\@evil",
    "https://localhost@evil.com/",
    "https://evil.com@localhost/",
    "https://user:pass@localhost/cb",
    "https://localhost/cb\r\nSet-Cookie: x=1",
    "https://local host/cb",
    "https://localhost/\tcb",
    "http://evil.com#@localhost/",
])
def test_rechaza_lo_demas(uri):
    with pytest.raises(HTTPException) as exc:
        _validate_redirect_uri(uri)
    assert exc.value.status_code == 400
