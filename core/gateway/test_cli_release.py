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


def _borrar(cliente, version, channel):
    for platform in versions.CLI_PLATFORMS:
        r = cliente.delete(f"/api/versions/{version}?channel={channel}&product=cli-{platform}", headers=ADMIN)
        assert r.status_code == 200, r.text


def _registrar(cliente, version, platform, n, channel):
    r = cliente.post("/api/versions/register", headers=ADMIN, json=_registro(
        platform, n, version=version, channel=channel, title=f"Lixbon CLI {version}",
        changelog=[f"notas de {version}"],
        download_url=f"{CLI_RELEASES_URL_PREFIX}cli-v{version}/lixbon-{version}-{platform}."
                     f"{'zip' if platform.startswith('windows') else 'tar.gz'}"))
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("menor,mayor", [
    ("2.3.0-go.9", "2.3.0-go.10"),
    ("2.3.0-go.1", "2.3.0"),
    ("2.3.0", "2.3.1-beta.1"),
    ("2.3.0-beta.1", "2.3.0-go.1"),
    ("2.9.0", "2.10.0"),
])
def test_orden_semver_de_versiones_del_cli(menor, mayor):
    assert versions._semver_key(menor) < versions._semver_key(mayor)


def test_etapas_estable_y_beta(cliente):
    _borrar(cliente, VERSION, "beta")
    for n, platform in enumerate(versions.CLI_PLATFORMS, start=1):
        _registrar(cliente, "2.4.0", platform, 20 + n, "stable")
    assert cliente.get("/api/updates/cli/stable").json()["version"] == "2.4.0"
    assert cliente.get("/api/updates/cli/stable").json()["channel"] == "stable"
    assert cliente.get("/api/updates/cli/beta").json()["version"] == "2.4.0"

    for n, platform in enumerate(versions.CLI_PLATFORMS, start=1):
        _registrar(cliente, "2.5.0-beta.1", platform, 40 + n, "beta")
    beta = cliente.get("/api/updates/cli/beta").json()
    assert beta["version"] == "2.5.0-beta.1" and beta["channel"] == "beta"
    assert beta["changelog"] == ["notas de 2.5.0-beta.1"]
    assert cliente.get("/api/updates/cli/stable").json()["version"] == "2.4.0"


def test_instaladores_sirven_la_ultima_estable_aunque_haya_una_beta_mas_nueva(cliente):
    sh = cliente.get("/install.sh").text
    assert "lixbon-2.4.0-linux-amd64.tar.gz" in sh and "2.5.0-beta.1" not in sh
    ps1 = cliente.get("/install.ps1").text
    assert "lixbon-2.4.0-windows-amd64.zip" in ps1 and "2.5.0-beta.1" not in ps1


def test_historial_publico_trae_etapa_y_notas(cliente):
    filas = [v for v in cliente.get("/api/versions").json() if v["product"] == "cli-linux-amd64"]
    por_version = {v["version"]: v for v in filas}
    assert por_version["2.4.0"]["channel"] == "stable"
    assert por_version["2.5.0-beta.1"]["channel"] == "beta"
    assert por_version["2.5.0-beta.1"]["changelog"] == ["notas de 2.5.0-beta.1"]


def test_sin_estable_los_instaladores_sirven_la_ultima_beta(cliente):
    _borrar(cliente, "2.4.0", "stable")
    assert cliente.get("/api/updates/cli/stable").status_code == 404
    assert "lixbon-2.5.0-beta.1-linux-amd64.tar.gz" in cliente.get("/install.sh").text


def test_instaladores_responden_503_sin_release_registrada(cliente, monkeypatch):
    from core.gateway.routers import installer
    monkeypatch.setattr(installer, "latest_cli_release_for_install", lambda: None)
    assert cliente.get("/install.sh").status_code == 503
    assert cliente.get("/install.ps1").status_code == 503


def test_los_archivos_de_la_release_se_suben_y_se_sirven_desde_r2(cliente, monkeypatch):
    from core.storage import r2
    subidos = {}
    monkeypatch.setattr(r2, "upload_release", lambda key, f, content_type=None: subidos.setdefault(key, f.read()))
    monkeypatch.setattr(r2, "presigned_get_url", lambda key, ttl_min=None: f"https://r2.example/{key}?firma=x")
    for nombre in ("lixbon-2.4.0-linux-amd64.tar.gz", "SHA256SUMS"):
        r = cliente.post("/api/versions/cli-asset", headers=ADMIN, data={"tag": "cli-v2.4.0"},
                         files={"file": (nombre, b"bytes")})
        assert r.status_code == 200
    assert set(subidos) == {"cli-releases/cli-v2.4.0/lixbon-2.4.0-linux-amd64.tar.gz",
                            "cli-releases/cli-v2.4.0/SHA256SUMS"}
    r = cliente.get("/cli/releases/cli-v2.4.0/SHA256SUMS", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"].startswith("https://r2.example/cli-releases/cli-v2.4.0/SHA256SUMS")


def test_subir_archivos_de_release_exige_admin_y_nombres_validos(cliente, monkeypatch):
    from core.storage import r2
    monkeypatch.setattr(r2, "upload_release", lambda *a, **k: None)
    archivo = {"file": ("lixbon-2.4.0-linux-amd64.tar.gz", b"x")}
    assert cliente.post("/api/versions/cli-asset", data={"tag": "cli-v2.4.0"}, files=archivo).status_code in (401, 403)
    assert cliente.post("/api/versions/cli-asset", headers=ADMIN, data={"tag": "../x"}, files=archivo).status_code == 404
    otro = {"file": ("../../secreto", b"x")}
    assert cliente.post("/api/versions/cli-asset", headers=ADMIN, data={"tag": "cli-v2.4.0"}, files=otro).status_code == 404
    assert cliente.get("/cli/releases/cli-v2.4.0/otra-cosa.txt", follow_redirects=False).status_code == 404
