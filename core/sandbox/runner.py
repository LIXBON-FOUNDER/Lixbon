"""Arranque y parada de los entornos aislados de Coding.

Cada sesión tiene:
- un contenedor `lixbon-sbx-<sid>` con la imagen `lixbon-sandbox`,
- una red `lixbon-net-<sid>` INTERNA (sin salida): solo están el contenedor y
  los dos proxies, así que ningún entorno ve a otro,
- un volumen `lixbon-ws-<sid>` con /workspace, que sobrevive a las pausas.

La salida pasa por `lixbon-egress` (lista blanca) y la vista previa entra por
`lixbon-ingress` (clave que solo conoce el gateway). Pausar = borrar el
contenedor (libera memoria); reanudar = crear otro con el mismo volumen y un
token nuevo.

Usa el CLI de docker (sin dependencias nuevas). Todo es bloqueante: llamar
desde hilos (`asyncio.to_thread`).
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import secrets
import shutil
import subprocess
from dataclasses import dataclass, field
from typing import Any, Protocol

log = logging.getLogger("lixbon.sandbox")

IMAGEN = os.getenv("CODING_SANDBOX_IMAGE", "lixbon-sandbox")
EGRESS = "lixbon-egress"
INGRESS = "lixbon-ingress"
INGRESS_PUERTO = int(os.getenv("CODING_INGRESS_PORT", "8899"))
GATEWAY_URL = os.getenv("CODING_GATEWAY_URL", "http://host.docker.internal:8000")
MEMORIA = os.getenv("CODING_SANDBOX_MEMORY", "2g")
CPUS = os.getenv("CODING_SANDBOX_CPUS", "2")
PIDS = os.getenv("CODING_SANDBOX_PIDS", "512")
_SID = re.compile(r"^[0-9a-f]{12}$")


class SandboxError(RuntimeError):
    """Fallo del motor de contenedores, con un mensaje que se puede enseñar."""


def nombres(sid: str) -> tuple[str, str, str]:
    if not _SID.match(sid or ""):
        raise ValueError("id de sesión no válido")
    return f"lixbon-sbx-{sid}", f"lixbon-net-{sid}", f"lixbon-ws-{sid}"


@dataclass
class Arranque:
    session_id: str
    user_id: int
    token: str
    repo: str
    default_branch: str
    mode: str
    model: str | None


def origen() -> str:
    """Huella de ESTA instalación (su base de datos). Contenedores, redes y
    volúmenes la llevan en una etiqueta: el recolector solo borra restos que
    creó este gateway, nunca los de otro que comparta el mismo Docker (p. ej.
    dos gateways de desarrollo con bases de datos distintas)."""
    base = os.getenv("CODING_ORIGEN") or os.getenv("DATABASE_URL", "")
    return hashlib.sha256(base.encode()).hexdigest()[:12]


def _sid_de(nombre: str) -> str | None:
    """lixbon-sbx-<sid> / lixbon-net-<sid> / lixbon-ws-<sid> → sid."""
    sid = nombre.strip().rsplit("-", 1)[-1]
    return sid if _SID.match(sid) else None


class SandboxRunner(Protocol):
    def disponible(self) -> bool: ...
    def vivos(self) -> set[str] | None: ...
    def restos(self) -> set[str]: ...
    def arrancar(self, a: Arranque) -> str: ...
    def detener(self, session_id: str) -> None: ...
    def borrar(self, session_id: str) -> None: ...
    def proxy_vista_previa(self) -> str: ...


def entorno_contenedor(a: Arranque) -> dict[str, str]:
    """Variables del contenedor. El token de GitHub NUNCA va aquí: git habla
    con el proxy git del gateway usando el token acotado de la sesión."""
    proxy = f"http://{EGRESS}:8888"
    return {
        "LIXBON_SESSION_ID": a.session_id,
        "LIXBON_SESSION_TOKEN": a.token,
        "LIXBON_GATEWAY": GATEWAY_URL,
        "LIXBON_REPO": a.repo,
        "LIXBON_DEFAULT_BRANCH": a.default_branch,
        "LIXBON_MODE": a.mode,
        "LIXBON_MODEL": a.model or "",
        # Ruta base con la que arrancar el servidor de desarrollo para la vista
        # previa ({port} lo sustituye el CLI): /api/coding/sessions/<sid>/preview/{port}/
        "LIXBON_PREVIEW_BASE": f"/api/coding/sessions/{a.session_id}/preview/{{port}}/",
        "HTTP_PROXY": proxy, "HTTPS_PROXY": proxy, "http_proxy": proxy, "https_proxy": proxy,
        "NO_PROXY": "localhost,127.0.0.1", "no_proxy": "localhost,127.0.0.1",
        # git → proxy git del gateway con el token de la sesión.
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "http.extraHeader",
        "GIT_CONFIG_VALUE_0": f"Authorization: Bearer {a.token}",
        "GIT_TERMINAL_PROMPT": "0",
    }


def argumentos_run(a: Arranque) -> list[str]:
    """`docker run` endurecido. Aislado aquí para poder testearlo sin Docker."""
    cont, red, vol = nombres(a.session_id)
    args = [
        "run", "-d", "--name", cont, "--hostname", "nube",
        "--label", "lixbon.sandbox=1", "--label", f"lixbon.session={a.session_id}",
        "--label", f"lixbon.user={a.user_id}", "--label", f"lixbon.origen={origen()}",
        "--user", "1000:1000",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--read-only",
        "--tmpfs", "/tmp:rw,exec,size=1g",
        "--tmpfs", "/home/lixbon:rw,exec,size=2g,uid=1000,gid=1000,mode=0700",
        "--memory", MEMORIA, "--memory-swap", MEMORIA, "--cpus", CPUS, "--pids-limit", PIDS,
        "--network", red,
        "-v", f"{vol}:/workspace",
    ]
    for k, v in entorno_contenedor(a).items():
        args += ["-e", f"{k}={v}"]
    return args + [IMAGEN]


def _clave_estable() -> str:
    """Clave del proxy de entrada que sobrevive a reinicios y despliegues del
    gateway (si cambiara, las vistas previas de las sesiones vivas darían 401):
    sale de CONNECTORS_SECRET_KEY. Sin ella (desarrollo), una al azar."""
    base = os.getenv("CONNECTORS_SECRET_KEY", "").strip()
    if not base:
        return secrets.token_urlsafe(32)
    return hmac.new(base.encode(), b"lixbon-coding-ingress", hashlib.sha256).hexdigest()


class DockerRunner:
    def __init__(self, ingress_secret: str | None = None):
        self.ingress_secret = ingress_secret or os.getenv("CODING_INGRESS_SECRET") or _clave_estable()
        self.docker = shutil.which("docker") or r"C:\Program Files\Docker\Docker\resources\bin\docker.exe"

    # ------------------------------------------------------------ bajo nivel
    def _d(self, *args: str, check: bool = True, timeout: float = 120) -> subprocess.CompletedProcess:
        try:
            r = subprocess.run([self.docker, *args], capture_output=True, text=True, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise SandboxError(f"Docker no responde: {exc}") from exc
        if check and r.returncode != 0:
            # El comando puede llevar el token en -e: nunca se registra entero.
            log.warning("docker %s falló: %s", args[0], (r.stderr or "").strip()[:300])
            raise SandboxError((r.stderr or "docker falló").strip()[:300])
        return r

    def _existe(self, tipo: str, nombre: str) -> bool:
        return self._d(tipo, "inspect", nombre, check=False).returncode == 0

    # ------------------------------------------------------------ infraestructura
    def disponible(self) -> bool:
        try:
            return (self._d("info", "--format", "{{.ServerVersion}}", check=False, timeout=15).returncode == 0
                    and self._existe("image", IMAGEN))
        except SandboxError:
            return False

    def _infra(self, nombre: str, run: list[str], huella: str | None = None) -> bool:
        """Deja un proxy en marcha. Si no existe, es de otro arranque del gateway
        (otra clave) o no se deja arrancar (Docker Desktop recién reiniciado lo
        puede tener a medio restaurar), se crea de nuevo."""
        fmt = '{{index .Config.Labels "lixbon.secreto"}}|{{.State.Running}}'
        r = self._d("inspect", "-f", fmt, nombre, check=False)
        if r.returncode == 0:
            secreto, _, corriendo = r.stdout.strip().partition("|")
            if huella is not None and secreto != huella:
                self._d("rm", "-f", nombre, check=False)
            elif corriendo == "true":
                return False
            elif self._d("start", nombre, check=False).returncode == 0:
                return False
            else:
                self._d("rm", "-f", nombre, check=False)
        self._d("run", "-d", "--name", nombre, *run)
        return True

    def _asegurar_proxies(self) -> None:
        comunes = ["--restart", "unless-stopped", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                   "--read-only", "--label", "lixbon.sandbox.infra=1"]
        nuevos = []
        if self._infra(EGRESS, [*comunes, EGRESS]):
            nuevos.append(EGRESS)
        huella = hashlib.sha256(self.ingress_secret.encode()).hexdigest()[:16]
        if self._infra(INGRESS, [*comunes, "--tmpfs", "/tmp:rw,size=8m", "--label", f"lixbon.secreto={huella}",
                                 "-e", f"INGRESS_SECRET={self.ingress_secret}",
                                 "-p", f"127.0.0.1:{INGRESS_PUERTO}:8899", INGRESS], huella=huella):
            nuevos.append(INGRESS)
        if nuevos:
            # Un proxy recreado no está en las redes de las sesiones vivas: sin
            # esto se quedarían sin salida (egress) o sin vista previa (ingress).
            r = self._d("network", "ls", "--filter", "label=lixbon.session", "--format", "{{.Name}}", check=False)
            for red in (r.stdout or "").split():
                for proxy in nuevos:
                    self._d("network", "connect", red, proxy, check=False)

    def reparar_vista_previa(self) -> None:
        """El proxy de entrada no reconoce la clave (lo creó otro arranque)."""
        self._asegurar_proxies()

    # ------------------------------------------------------------ ciclo
    def arrancar(self, a: Arranque) -> str:
        cont, red, vol = nombres(a.session_id)
        self._asegurar_proxies()
        if not self._existe("network", red):
            self._d("network", "create", "--internal", "--label", f"lixbon.session={a.session_id}",
                    "--label", f"lixbon.origen={origen()}", red)
        for proxy in (EGRESS, INGRESS):
            r = self._d("network", "connect", red, proxy, check=False)
            if r.returncode != 0 and "already exists" not in (r.stderr or ""):
                raise SandboxError((r.stderr or "").strip()[:300])
        if not self._existe("volume", vol):
            self._d("volume", "create", "--label", f"lixbon.session={a.session_id}",
                    "--label", f"lixbon.origen={origen()}", vol)
        self._d("rm", "-f", cont, check=False)
        r = self._d(*argumentos_run(a))
        return r.stdout.strip()[:64]

    def detener(self, session_id: str) -> None:
        cont, red, _ = nombres(session_id)
        self._d("rm", "-f", cont, check=False)
        for proxy in (EGRESS, INGRESS):
            self._d("network", "disconnect", "-f", red, proxy, check=False)
        self._d("network", "rm", red, check=False)

    def borrar(self, session_id: str) -> None:
        self.detener(session_id)
        self._d("volume", "rm", "-f", nombres(session_id)[2], check=False)

    def proxy_vista_previa(self) -> str:
        return f"http://lixbon:{self.ingress_secret}@127.0.0.1:{INGRESS_PUERTO}"

    # ------------------------------------------------------------ inventario
    def vivos(self) -> set[str] | None:
        """Sesiones con el contenedor EN MARCHA. None si Docker no contesta:
        no saber no es lo mismo que «no hay ninguno»."""
        try:
            r = self._d("ps", "--filter", "label=lixbon.sandbox=1", "--format", "{{.Names}}",
                        check=False, timeout=30)
        except SandboxError:
            return None
        if r.returncode != 0:
            return None
        return {sid for n in (r.stdout or "").split() if (sid := _sid_de(n))}

    def restos(self) -> set[str]:
        """Sesiones con algún recurso (contenedor, red o volumen) creado por
        esta instalación. Si una consulta falla, no se devuelve nada."""
        filtro = ["--filter", f"label=lixbon.origen={origen()}", "--format"]
        sids: set[str] = set()
        for cmd in (["ps", "-a", *filtro, "{{.Names}}"], ["network", "ls", *filtro, "{{.Name}}"],
                    ["volume", "ls", *filtro, "{{.Name}}"]):
            try:
                r = self._d(*cmd, check=False, timeout=30)
            except SandboxError:
                return set()
            if r.returncode != 0:
                return set()
            sids |= {sid for n in (r.stdout or "").split() if (sid := _sid_de(n))}
        return sids


@dataclass
class FakeRunner:
    """Para los tests: recuerda lo que se le pidió."""
    ok: bool = True
    llamadas: list[tuple[str, Any]] = field(default_factory=list)
    # None = «Docker no contesta». Los tests ponen aquí lo que hay en marcha.
    en_marcha: set[str] | None = None
    sobras: set[str] = field(default_factory=set)

    def vivos(self) -> set[str] | None:
        return None if self.en_marcha is None else set(self.en_marcha)

    def restos(self) -> set[str]:
        return set(self.sobras)

    def reparar_vista_previa(self) -> None:
        self.llamadas.append(("reparar", None))

    def disponible(self) -> bool:
        return self.ok

    def arrancar(self, a: Arranque) -> str:
        if not self.ok:
            raise SandboxError("Docker no responde")
        self.llamadas.append(("arrancar", a))
        return f"c-{a.session_id}"

    def detener(self, session_id: str) -> None:
        self.llamadas.append(("detener", session_id))

    def borrar(self, session_id: str) -> None:
        self.llamadas.append(("borrar", session_id))

    def proxy_vista_previa(self) -> str:
        return "http://lixbon:x@127.0.0.1:1"


_runner: SandboxRunner | None = None


def runner() -> SandboxRunner:
    global _runner
    if _runner is None:
        _runner = DockerRunner()
    return _runner


def usar(r: SandboxRunner | None) -> None:
    """Sustituye el runner (tests)."""
    global _runner
    _runner = r
