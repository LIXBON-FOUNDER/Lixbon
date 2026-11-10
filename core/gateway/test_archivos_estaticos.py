import os

import pytest

from core.gateway.app import archivo_dentro


@pytest.fixture
def dist(tmp_path):
    base = tmp_path / "dist"
    (base / "assets").mkdir(parents=True)
    (base / "index.html").write_text("index")
    (base / "assets" / "app.js").write_text("js")
    # Hermano cuyo nombre empieza igual que `dist`: no debe contar como "dentro".
    (tmp_path / "dist-evil").mkdir()
    (tmp_path / "dist-evil" / "secreto.txt").write_text("no")
    (tmp_path / "secreto.txt").write_text("no")
    return base


@pytest.mark.parametrize("relativa", ["index.html", "assets/app.js", "assets/../index.html"])
def test_sirve_archivos_dentro(dist, relativa):
    assert archivo_dentro(dist, relativa) is not None


@pytest.mark.parametrize("relativa", [
    "../secreto.txt",
    "../../secreto.txt",
    "assets/../../secreto.txt",
    "../dist-evil/secreto.txt",
    "",
    "assets",
    "no-existe.js",
    "a\x00b",
])
def test_rechaza_lo_que_se_sale_o_no_es_archivo(dist, relativa):
    assert archivo_dentro(dist, relativa) is None


def test_rechaza_ruta_absoluta(dist, tmp_path):
    assert archivo_dentro(dist, str(tmp_path / "secreto.txt")) is None


def test_rechaza_enlace_simbolico_hacia_fuera(dist, tmp_path):
    try:
        os.symlink(tmp_path / "secreto.txt", dist / "enlace.txt")
    except (OSError, NotImplementedError):
        pytest.skip("sin permiso para crear enlaces simbólicos")
    assert archivo_dentro(dist, "enlace.txt") is None
