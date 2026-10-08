"""Instala el CLI Go con install.sh / install.ps1 contra un servidor de releases local.

Genera cada instalador con `installer_go` (el mismo código que sirve el gateway),
compila dos versiones del binario y ejecuta el script real con HOME/USERPROFILE
temporal (en Windows, el PATH de usuario se guarda y se restaura al terminar). El único cambio al script es apuntar el host de descarga al servidor
local: el gateway solo embebe URLs https y aquí no hay certificado.
"""
from __future__ import annotations

import codecs
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parents[2]
GO_DIR = ROOT / "apps" / "cli"
FAKE_HOST = "https://releases.invalid"
V1, V2 = "9.0.0-e2e.1", "9.0.0-e2e.2"

OS = {"linux": "linux", "darwin": "darwin", "win32": "windows"}[sys.platform]
ARCH = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "amd64"
PLATFORM = f"{OS}-{ARCH}"
EXE = "lixbon.exe" if OS == "windows" else "lixbon"
LEGACY_FILES = ["client_cli.py", "lixbon.cmd"] if OS == "windows" else ["client_cli.py"]


def load_installer_go():
    path = ROOT / "core" / "gateway" / "routers" / "installer_go.py"
    spec = importlib.util.spec_from_file_location("installer_go", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build(version: str, out_dir: pathlib.Path) -> pathlib.Path:
    out = out_dir / f"lixbon-{version}" / EXE
    ldflags = f"-s -w -X lixbon.com/cli/internal/config.Version={version}"
    subprocess.run(["go", "build", "-trimpath", "-ldflags", ldflags, "-o", str(out), "./cmd/lixbon"],
                   cwd=GO_DIR, check=True, env={**os.environ, "CGO_ENABLED": "0"})
    return out


def package(version: str, binary: pathlib.Path) -> tuple[str, bytes]:
    folder = f"lixbon-{version}-{PLATFORM}"
    buf = io.BytesIO()
    if OS == "windows":
        with zipfile.ZipFile(buf, "w") as z:
            z.write(binary, f"{folder}/{EXE}")
        return f"{folder}.zip", buf.getvalue()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:
        t.add(binary, f"{folder}/{EXE}")
    return f"{folder}.tar.gz", buf.getvalue()


class FakeReleases:
    def __init__(self):
        self.archives: dict[str, tuple[str, bytes]] = {}
        self.latest = V1
        self.sums_override: dict[str, str] = {}
        self.chat_started = threading.Event()
        self.stop = threading.Event()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def add(self, version: str, binary: pathlib.Path) -> None:
        self.archives[version] = package(version, binary)

    def sha(self, version: str) -> str:
        return hashlib.sha256(self.archives[version][1]).hexdigest()

    def asset_url(self, version: str, host: str) -> str:
        return f"{host}/cli-v{version}/{self.archives[version][0]}"

    def release(self, version: str, sha: str | None = None) -> dict:
        return {"version": version, "assets": {
            PLATFORM: {"url": self.asset_url(version, FAKE_HOST), "sha256": sha or self.sha(version)}}}

    def manifest(self) -> bytes:
        return json.dumps({"version": self.latest, "assets": {
            PLATFORM: {"url": self.asset_url(self.latest, self.url), "sha256": self.sha(self.latest)}}}).encode()

    def close(self) -> None:
        self.stop.set()
        self.server.shutdown()

    def _handler(self):
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, body: bytes, status: int = 200):
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                path = self.path.split("?")[0]
                if path == "/api/updates/cli/beta":
                    return self.reply(fake.manifest())
                if path == "/v1/models":
                    return self.reply(b'{"data":[{"id":"m"}]}')
                for version, (name, data) in fake.archives.items():
                    prefix = f"/cli-v{version}/"
                    if path == prefix + name:
                        return self.reply(data)
                    if path == prefix + "SHA256SUMS":
                        digest = fake.sums_override.get(version) or fake.sha(version)
                        return self.reply(f"{digest}  {name}\n".encode())
                self.reply(b"no encontrado", 404)

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                if self.path.split("?")[0] == "/v1/chat/completions":
                    fake.chat_started.set()
                    fake.stop.wait(120)
                    return
                self.reply(b"no encontrado", 404)

        return Handler


class Sandbox:
    def __init__(self, fake: FakeReleases, installer):
        self.fake, self.installer = fake, installer
        self.home = pathlib.Path(tempfile.mkdtemp(prefix="lixbon-e2e-"))
        skipped = ("psmodulepath",)  # el 5.1 hereda las rutas de PowerShell 7 del runner y pierde Get-FileHash
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("LIXBON_") and k.lower() not in skipped}
        self.env.update(HOME=str(self.home), USERPROFILE=str(self.home))
        self.exe = self.home / (".lixbon" if OS == "windows" else ".local/bin") / EXE

    def install(self, release: dict) -> subprocess.CompletedProcess:
        make = self.installer.install_ps1 if OS == "windows" else self.installer.install_sh
        script = make(self.fake.url, release).replace(FAKE_HOST, self.fake.url)
        path = self.home / ("install.ps1" if OS == "windows" else "install.sh")
        path.write_bytes(codecs.BOM_UTF8 + script.encode() if OS == "windows" else script.encode())
        if OS == "windows":
            cmd = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(path), self.fake.url]
        else:
            cmd = ["bash", str(path), self.fake.url]
        return subprocess.run(cmd, env=self.env, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=180)

    def lixbon(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([str(self.exe), *args], env=self.env, capture_output=True, text=True,
                              encoding="utf-8", timeout=60)

    def leftovers(self) -> list[str]:
        names = LEGACY_FILES
        return [n for n in names if (self.home / ".lixbon" / n).exists()]

    def cleanup(self) -> None:
        shutil.rmtree(self.home, ignore_errors=True)


def expect(condition: bool, message: str, detail: str = "") -> None:
    if not condition:
        raise AssertionError(f"{message}\n{detail}")
    print(f"  ok  {message}")


def output(result: subprocess.CompletedProcess) -> str:
    return (result.stdout or "") + (result.stderr or "")


def powershell(command: str, env: dict | None = None) -> str:
    return subprocess.run(["powershell.exe", "-NoProfile", "-Command", command], env=env, check=True,
                          capture_output=True, text=True).stdout.strip()


def user_path() -> str:
    return powershell("[Environment]::GetEnvironmentVariable('Path','User')")


def restore_user_path(value: str) -> None:
    powershell("[Environment]::SetEnvironmentVariable('Path',$env:SAVED_PATH,'User')",
               {**os.environ, "SAVED_PATH": value})


def fresh_install(fake, installer):
    box = Sandbox(fake, installer)
    try:
        (box.home / ".lixbon").mkdir()
        for decoy in LEGACY_FILES:
            (box.home / ".lixbon" / decoy).write_text("viejo")
        fake.latest = V1
        result = box.install(fake.release(V1))
        expect(result.returncode == 0, f"instala {V1} sin errores\n{output(result)}")
        expect(box.exe.exists(), f"el binario queda en {box.exe}")
        expect(not box.leftovers(), f"no quedan {' ni '.join(LEGACY_FILES)}")
        status = box.lixbon("status")
        expect(f"lixbon CLI v{V1}" in status.stdout, "status informa la versión instalada")
        expect(f"{fake.url}/v1" in status.stdout, "el instalador guarda base_url del servidor")
        expect(f"v{V1}" in box.lixbon("--version").stdout, "--version informa la versión instalada")
        check = box.lixbon("update", "--check")
        expect(check.returncode == 0 and "ya está actualizado" in check.stdout, "update --check funciona y está al día")
        return box
    except BaseException:
        box.cleanup()
        raise


def upgrade_while_running(box: Sandbox, fake: FakeReleases):
    box.lixbon("init", "--api-key", "k", "--model", "m")
    running = subprocess.Popen([str(box.exe), "chat", "--once", "hola"], env=box.env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        expect(fake.chat_started.wait(30), "el binario instalado está en uso (esperando respuesta del servidor)")
        fake.latest = V2
        result = box.install(fake.release(V2))
        expect(result.returncode == 0, f"instala {V2} encima con el binario en uso\n{output(result)}")
        expect(running.poll() is None, "el proceso en marcha sigue vivo tras actualizar")
        expect(f"lixbon CLI v{V2}" in box.lixbon("status").stdout, "status informa la versión nueva")
        check = box.lixbon("update", "--check")
        expect("ya está actualizado" in check.stdout, "update --check queda al día tras reinstalar")
    finally:
        running.kill()
        running.wait()


def rejects_without_installing(fake, installer, label: str, release: dict, message: str):
    box = Sandbox(fake, installer)
    try:
        result = box.install(release)
        expect(result.returncode != 0, f"{label}: el instalador falla", output(result))
        expect(message in output(result), f"{label}: explica el motivo", output(result))
        expect(not box.exe.exists(), f"{label}: no se instaló ningún binario")
    finally:
        box.cleanup()


def main() -> int:
    installer = load_installer_go()
    work = pathlib.Path(tempfile.mkdtemp(prefix="lixbon-e2e-build-"))
    fake = FakeReleases()
    boxes: list[Sandbox] = []
    saved_path = user_path() if OS == "windows" else None
    try:
        print(f"Plataforma {PLATFORM}: compilando {V1} y {V2}")
        for version in (V1, V2):
            fake.add(version, build(version, work))

        print("\nInstalación limpia")
        box = fresh_install(fake, installer)
        boxes.append(box)
        print("\nActualización con el binario en uso")
        upgrade_while_running(box, fake)

        fake.latest = V1
        print("\nDigest del gateway distinto")
        rejects_without_installing(fake, installer, "gateway", fake.release(V1, sha="f" * 64),
                                   "no coincide con el del servidor")
        print("\nSHA256SUMS de la release distinto")
        fake.sums_override[V1] = "e" * 64
        rejects_without_installing(fake, installer, "SHA256SUMS", fake.release(V1), "no coincide con SHA256SUMS")
        print("\nTodo correcto")
        return 0
    except AssertionError as err:
        print(f"\nFALLO: {err}", file=sys.stderr)
        return 1
    finally:
        fake.close()
        if saved_path is not None:
            restore_user_path(saved_path)
        for box in boxes:
            box.cleanup()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
