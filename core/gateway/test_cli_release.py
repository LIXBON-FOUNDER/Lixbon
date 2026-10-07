"""Releases del CLI Go: registro desde CI, manifest por plataforma e instaladores
con el digest embebido. SQLite temporal."""
import os
import pathlib
import tempfile

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_cli_release_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'cli.db').as_posix()}"
os.environ["ADMIN_TOKEN"] = "token-de-prueba"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.config import CLI_RELEASES_URL_PREFIX  # noqa: E402
from core.gateway import app as app_mod  # noqa: E402
from core.gateway.routers import versions  # noqa: E402
from core.persistence.database import Base, get_engine  # noqa: E402

ADMIN = {"X-Admin-Token": "token-de-prueba"}
VERSION = "2.3.0-go.0"
TAG_URL = f"{CLI_RELEASES_URL_PREFIX}cli-v{VERSION}"


def _sha(n: int) -> str:
    return f"{n:x}".rjust(64, "0")


def _asset(platform: str) -> str:
    ext = "zip" if platform.startswith("windows") else "tar.gz"
    return f"lixbon-{VERSION}-{platform}.{ext}"


def _registro(platform: str, n: int, **cambios) -> dict:
    datos = {
        "product": f"cli-{platform}", "version": VERSION, "channel": "beta",
        "title": "Lixbon CLI 2.3.0-go.0", "changelog": ["primera beta"],
        "download_url": f"{TAG_URL}/{_asset(platform)}", "checksum_sha256": _sha(n),
    }
    return {**datos, **cambios}


@pytest.fixture(scope="module")
def cliente():
    Base.metadata.create_all(get_engine())
    app_mod.init_db = lambda: None
    app_mod.versions.sync_versions_to_db = lambda: None
    app_mod.deps.orquestador.iniciar = lambda: None
    app_mod.deps.orquestador.detener = lambda: None
    app_mod.status.start_sampler = lambda: None
    with TestClient(app_mod.app) as c:
        yield c


@pytest.fixture(autouse=True)
def sin_upsert_postgres(monkeypatch):
    """add_app_version usa el INSERT … ON CONFLICT de Postgres; SQLite no lo
    compila, así que la prueba lo sustituye por un upsert equivalente."""
    from core.persistence import queries as q
    from core.persistence.database import get_session
    from core.persistence.models import AppVersion
    from sqlalchemy import select

    def add(version, channel, release_date, title, changelog, download_url,
            checksum=None, product="desktop"):
        import json
        with get_session() as s:
            fila = s.scalar(select(AppVersion).where(
                AppVersion.product == product, AppVersion.version == version))
            if fila is None:
                fila = AppVersion(product=product, version=version, created_at=q.now_iso())
                s.add(fila)
            fila.channel, fila.release_date, fila.title = channel, release_date, title
            fila.changelog_json = json.dumps(changelog)
            fila.download_url, fila.checksum_sha256 = download_url, checksum

    monkeypatch.setattr(q, "add_app_version", add)


def test_manifest_sin_releases_es_404(cliente):
    assert cliente.get("/api/updates/cli/beta").status_code == 404


def test_registro_exige_administrador(cliente):
    assert cliente.post("/api/versions/register", json=_registro("linux-amd64", 1)).status_code == 403


@pytest.mark.parametrize("cambios", [
    {"product": "desktop"},
    {"product": "cli-freebsd-amd64"},
    {"channel": "nightly"},
    {"version": "2.3.0 go"},
    {"checksum_sha256": "no-es-un-digest"},
    {"checksum_sha256": _sha(10).upper()},
    {"download_url": "https://ejemplo.com/lixbon.tar.gz"},
    {"download_url": "http://github.com/LIXBON-FOUNDER/Lixbon/releases/download/x/y.tar.gz"},
])
def test_registro_rechaza_datos_invalidos(cliente, cambios):
    r = cliente.post("/api/versions/register", json=_registro("linux-amd64", 1, **cambios), headers=ADMIN)
    assert r.status_code == 400


def test_registro_y_manifest_por_plataforma(cliente):
    for n, platform in enumerate(versions.CLI_PLATFORMS, start=1):
        r = cliente.post("/api/versions/register", json=_registro(platform, n), headers=ADMIN)
        assert r.status_code == 200, r.text
    m = cliente.get("/api/updates/cli/beta").json()
    assert m["version"] == VERSION and m["channel"] == "beta"
    assert set(m["assets"]) == set(versions.CLI_PLATFORMS)
    assert m["assets"]["windows-arm64"] == {
        "url": f"{TAG_URL}/{_asset('windows-arm64')}", "sha256": _sha(6)}
    assert cliente.get("/api/updates/cli/stable").status_code == 404
    assert cliente.get("/api/updates/cli/otro").status_code == 400


def test_manifest_solo_ofrece_binarios_de_la_version_mas_reciente(cliente):
    nueva = "2.3.1-go.0"
    r = cliente.post("/api/versions/register", headers=ADMIN, json=_registro(
        "linux-amd64", 99, version=nueva,
        download_url=f"{CLI_RELEASES_URL_PREFIX}cli-v{nueva}/lixbon-{nueva}-linux-amd64.tar.gz"))
    assert r.status_code == 200
    m = cliente.get("/api/updates/cli/beta").json()
    assert m["version"] == nueva
    assert list(m["assets"]) == ["linux-amd64"]


def test_instalador_sh_embebe_digests_y_verifica(cliente):
    cliente.delete(f"/api/versions/2.3.1-go.0?channel=beta&product=cli-linux-amd64", headers=ADMIN)
    r = cliente.get("/install.sh")
    assert r.status_code == 200
    script = r.text
    assert script.startswith("#!/usr/bin/env bash")
    assert f"URL='{TAG_URL}/{_asset('linux-arm64')}'; SHA='{_sha(2)}'" in script
    assert f"URL='{TAG_URL}/{_asset('darwin-arm64')}'; SHA='{_sha(4)}'" in script
    assert "windows" not in script.split("case \"${os}-${arch}\" in")[1].split("esac")[0]
    assert "SHA256SUMS" in script and "python" not in script.lower()
    assert "__" not in script


def test_instalador_ps1_embebe_digests_y_verifica(cliente):
    r = cliente.get("/install.ps1")
    assert r.status_code == 200
    script = r.text
    assert f'"windows-amd64" = @{{ Url = "{TAG_URL}/{_asset("windows-amd64")}"; Sha = "{_sha(5)}" }}' in script
    assert "Get-FileHash" in script and "SHA256SUMS" in script
    assert "python" not in script.lower() and "__" not in script


def test_instalador_ignora_filas_con_datos_raros(cliente):
    from core.gateway.routers import installer_go
    release = {"version": VERSION, "assets": {
        "linux-amd64": {"url": "https://github.com/x/y'; rm -rf ~; '", "sha256": _sha(1)},
        "linux-arm64": {"url": f"{TAG_URL}/ok.tar.gz", "sha256": "no-hex"},
        "darwin-amd64": {"url": f"{TAG_URL}/ok.tar.gz", "sha256": _sha(3)},
    }}
    script = installer_go.install_sh("https://lixbon.com", release)
    assert "rm -rf ~" not in script and "no-hex" not in script
    assert "darwin-amd64)" in script
