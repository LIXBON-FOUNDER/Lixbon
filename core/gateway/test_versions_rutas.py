import pytest
from fastapi import HTTPException

from core.gateway.routers import versions


@pytest.mark.parametrize("nombre, esperado", [
    ("Lixbon-Setup.exe", ".exe"),
    ("Lixbon.dmg", ".dmg"),
    ("lixbon.AppImage", ".AppImage"),
    ("lixbon-linux.tar.gz", ".tar.gz"),
    ("sin_extension", ".bin"),
    ("", ".bin"),
    ("raro.ex e", ".bin"),
    ("raro.ex\x00e", ".bin"),
    ("raro.demasiado_largo_para_ser_extension", ".bin"),
    ("raro.", ".bin"),
])
def test_sufijo_release(nombre, esperado):
    assert versions._sufijo_release(nombre) == esperado


@pytest.fixture
def releases(tmp_path, monkeypatch):
    base = tmp_path / "releases"
    base.mkdir()
    monkeypatch.setattr(versions, "_LOCAL_RELEASES_DIR", base)
    return base


def test_ruta_local_dentro_de_releases(releases):
    ruta = versions._ruta_release_local("app-lixbon-1.0.0-stable.exe")
    assert ruta.parent == releases.resolve()


@pytest.mark.parametrize("filename", [
    "../fuera.exe",
    "../releases-x/fuera.exe",
    "sub/../../fuera.exe",
    "",
    ".",
])
def test_ruta_local_rechaza_lo_que_se_sale(releases, filename):
    with pytest.raises(HTTPException) as exc:
        versions._ruta_release_local(filename)
    assert exc.value.status_code == 400


def test_ruta_local_rechaza_absoluta(releases, tmp_path):
    with pytest.raises(HTTPException):
        versions._ruta_release_local(str(tmp_path / "fuera.exe"))
