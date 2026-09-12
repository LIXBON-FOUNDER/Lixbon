"""
agent.py — Node Agent de lixbon (corre en cada máquina con GPU).
Ollama NUNCA se expone directo a internet: todo pasa por este agente.

Dos modos:

1. Conexión (recomendado, sirve para GPUs alquiladas sin puerto entrante):
     LIXBON_ENROLL=<token> python -m core.node_agent.agent --connect https://lixbon.com
   El agente canjea el token de enrolamiento por su identidad (se guarda en
   ~/.lixbon/node.json), abre un WebSocket saliente al gateway y por ahí
   empuja métricas y atiende la inferencia. No hace falta túnel ni DNS.

2. Servidor (PC propia alcanzable por URL):
     python -m core.node_agent.agent
   Expone /metrics y un proxy a Ollama; toda ruta (excepto /health) exige
   X-Node-Token == NODE_SHARED_SECRET. Sin secreto responde 503.

  python -m core.node_agent.agent --install [--connect URL]   # Autoarranque en Windows
  python -m core.node_agent.agent --uninstall

Variables de entorno:
  LIXBON_GATEWAY      URL del gateway (equivale a --connect)
  LIXBON_ENROLL       Token de enrolamiento (solo la primera vez)
  LIXBON_NODE_ID      Id fijo opcional al enrolar (un pod reiniciado sigue siendo el mismo nodo)
  LIXBON_NODE_NAME    Nombre visible en el panel (default: hostname)
  LIXBON_PROVIDER     Etiqueta del proveedor: runpod, vast, propio…
  LIXBON_MODELS       Modelos a descargar al arrancar, separados por coma (ej: qwen3:8b,nomic-embed-text)
  LIXBON_STATE_FILE   Dónde guardar la identidad (default: ~/.lixbon/node.json)
  NODE_SHARED_SECRET  Modo servidor: token que debe enviar el gateway
  AGENT_PORT          Modo servidor: puerto HTTP (default: 8765)
  OLLAMA_URL          Ollama local (default: http://127.0.0.1:11434)
  OLLAMA_WATCHDOG     '1' para reiniciar Ollama si cae (default: 1)
"""
from __future__ import annotations

import asyncio
import json
import os
import platform
import random
import secrets as _secrets
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx
import psutil
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import StreamingResponse

# Cargar .env de la raíz del repo (mismo formato que core/config.py, sin dependencias)
_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"
if _ENV_FILE.exists():
    for _line in _ENV_FILE.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _key, _, _val = _line.partition("=")
            if _key.strip():
                os.environ.setdefault(_key.strip(), _val.strip().strip('"').strip("'"))

PORT = int(os.getenv("AGENT_PORT", "8765"))
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_WATCHDOG = os.getenv("OLLAMA_WATCHDOG", "1") == "1"
NODE_SHARED_SECRET = os.getenv("NODE_SHARED_SECRET", "")
TASK_NAME = "lixbon_NodeAgent"
AGENT_VERSION = "4.0.0"
STATE_FILE = Path(os.getenv("LIXBON_STATE_FILE") or Path.home() / ".lixbon" / "node.json")

app = FastAPI(title="lixbon Node Agent", version=AGENT_VERSION)


# ── Autenticación ──────────────────────────────────────────────────────────

def require_node_token(x_node_token: str | None = Header(default=None)) -> None:
    if not NODE_SHARED_SECRET:
        raise HTTPException(status_code=503, detail="Agente sin NODE_SHARED_SECRET configurado")
    if not x_node_token or not _secrets.compare_digest(x_node_token, NODE_SHARED_SECRET):
        raise HTTPException(status_code=401, detail="Token de nodo inválido")


# ── Métricas ───────────────────────────────────────────────────────────────

def _gpu_metrics() -> dict:
    """Lee GPU via nvidia-smi. Valores neutrales si no hay GPU."""
    try:
        resultado = subprocess.run(
            ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,memory.total",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        )
        if resultado.returncode != 0:
            raise RuntimeError("nvidia-smi falló")
        linea = resultado.stdout.strip().split("\n")[0]
        partes = [p.strip() for p in linea.split(",")]
        uso_gpu = float(partes[0])
        mem_usada_mb = float(partes[1])
        mem_total_mb = float(partes[2])
        mem_libre_mb = mem_total_mb - mem_usada_mb
        return {
            "gpu_available": True,
            "gpu_used_percent": round(uso_gpu, 1),
            "gpu_free_mb": round(mem_libre_mb, 1),
            "gpu_total_mb": round(mem_total_mb, 1),
            "gpu_free_percent": round((mem_libre_mb / mem_total_mb) * 100.0, 1),
        }
    except Exception:
        return {
            "gpu_available": False,
            "gpu_used_percent": 0.0,
            "gpu_free_mb": 0.0,
            "gpu_total_mb": 0.0,
            "gpu_free_percent": 50.0,
        }


# ── Capabilities de los modelos ────────────────────────────────────────────
# El gateway necesita saber qué puede hacer cada modelo (tools / vision /
# embedding / insert) para asignar los roles de inferencia sin adivinar por el
# nombre. Eso solo lo dice `POST /api/show`, así que se consulta aquí y viaja
# en /metrics. Se cachea por `digest`: un modelo que no cambió no se vuelve a
# consultar, y por poll solo se resuelven unos pocos nuevos para no pasarse del
# timeout con el que el gateway nos consulta.
# Este archivo NO importa nada de core/ a propósito (se despliega solo).

_MODEL_CAPS: dict[str, tuple[str, list[str]]] = {}   # name → (digest, capabilities)
_CAPS_PER_POLL = 8
_CAPS_TIMEOUT = 3.0


def merge_caps(
    tags: list[dict],
    cache: dict[str, tuple[str, list[str]]],
    budget: int,
) -> tuple[list[dict], list[str]]:
    """Cruza /api/tags con la caché. Función pura.

    Devuelve (model_info, pendientes): `capabilities` es None cuando aún no se
    conocen — el gateway lo interpreta como "desconocido", nunca como "no
    soportado". `pendientes` son los modelos a consultar en este poll.
    """
    info: list[dict] = []
    pendientes: list[str] = []
    for m in tags:
        name = m.get("name")
        if not name:
            continue
        digest = m.get("digest") or ""
        cached = cache.get(name)
        caps = cached[1] if cached and cached[0] == digest else None
        if caps is None and len(pendientes) < max(0, budget):
            pendientes.append(name)
        info.append({
            "name": name,
            "digest": digest,
            "size": m.get("size", 0),
            "capabilities": caps,
        })
    return info, pendientes


async def _ollama_model_info() -> tuple[list[str], list[dict]]:
    """(nombres, model_info). `models` se mantiene como lista plana de strings
    por compatibilidad: un gateway viejo ignora `model_info` sin enterarse."""
    try:
        async with httpx.AsyncClient(timeout=_CAPS_TIMEOUT) as client:
            resp = await client.get(f"{OLLAMA_URL}/api/tags")
            resp.raise_for_status()
            tags = resp.json().get("models", [])

            _, pendientes = merge_caps(tags, _MODEL_CAPS, _CAPS_PER_POLL)
            if pendientes:
                digests = {m.get("name"): (m.get("digest") or "") for m in tags}

                async def _show(name: str) -> None:
                    try:
                        r = await client.post(f"{OLLAMA_URL}/api/show", json={"model": name})
                        r.raise_for_status()
                        caps = r.json().get("capabilities")
                        if isinstance(caps, list):
                            _MODEL_CAPS[name] = (digests.get(name, ""), [str(c) for c in caps])
                    except Exception:
                        pass  # se reintenta en el siguiente poll

                await asyncio.gather(*(_show(n) for n in pendientes))

            info, _ = merge_caps(tags, _MODEL_CAPS, 0)
            return [m["name"] for m in info], info
    except Exception:
        return [], []


@app.get("/health")
async def health():
    """Público: solo confirma que el agente vive (sin datos del sistema)."""
    return {"status": "ok", "service": "lixbon Node Agent", "version": AGENT_VERSION}


def _hostname() -> str:
    return os.environ.get("COMPUTERNAME", platform.node())


async def _recolectar_metricas() -> dict:
    cpu = await asyncio.to_thread(psutil.cpu_percent, 0.3)
    mem = psutil.virtual_memory()
    modelos, model_info = await _ollama_model_info()
    return {
        "cpu_percent": round(cpu, 1),
        "ram_percent": round(mem.percent, 1),
        "ram_free_gb": round(mem.available / (1024 ** 3), 2),
        "ram_total_gb": round(mem.total / (1024 ** 3), 2),
        "hostname": _hostname(),
        "models": modelos,          # lista plana: contrato viejo, no tocar
        "model_info": model_info,   # + capabilities por modelo (gateway ≥ 2.5)
        "agent_version": AGENT_VERSION,
        **_gpu_metrics(),
    }


@app.get("/metrics")
async def metrics(_: None = Depends(require_node_token)):
    return await _recolectar_metricas()


@app.get("/info")
async def info(_: None = Depends(require_node_token)):
    return {
        "hostname": os.environ.get("COMPUTERNAME", platform.node()),
        "os": f"{platform.system()} {platform.release()}",
        "python_version": platform.python_version(),
        "agent_version": AGENT_VERSION,
        "port": PORT,
    }


# ── Proxy autenticado hacia Ollama ─────────────────────────────────────────
# Allowlist explícita: solo los endpoints que el gateway necesita.

@app.get("/ollama/api/tags")
async def proxy_tags(_: None = Depends(require_node_token)):
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(f"{OLLAMA_URL}/api/tags")
        resp.raise_for_status()
        return resp.json()


@app.post("/ollama/api/embed")
async def proxy_embed(request: Request, _: None = Depends(require_node_token)):
    payload = await request.json()
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(f"{OLLAMA_URL}/api/embed", json=payload)
        resp.raise_for_status()
        return resp.json()


@app.post("/ollama/api/chat")
async def proxy_chat(request: Request, _: None = Depends(require_node_token)):
    payload = await request.json()
    timeout = httpx.Timeout(300.0, connect=10.0)

    if payload.get("stream", False):
        async def _relay():
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream("POST", f"{OLLAMA_URL}/api/chat", json=payload) as resp:
                    resp.raise_for_status()
                    async for chunk in resp.aiter_raw():
                        yield chunk
        return StreamingResponse(_relay(), media_type="application/x-ndjson")

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(f"{OLLAMA_URL}/api/chat", json=payload)
        resp.raise_for_status()
        return resp.json()


@app.post("/ollama/api/generate")
async def proxy_generate(request: Request, _: None = Depends(require_node_token)):
    """Necesario para /api/fim del gateway: el autocompletado usa `suffix`, que
    solo existe en /api/generate. Sin este proxy el ghost text solo funcionaba
    contra el Ollama local del gateway, nunca contra un nodo."""
    payload = await request.json()
    timeout = httpx.Timeout(300.0, connect=10.0)

    if payload.get("stream", False):
        async def _relay():
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream("POST", f"{OLLAMA_URL}/api/generate", json=payload) as resp:
                    resp.raise_for_status()
                    async for chunk in resp.aiter_raw():
                        yield chunk
        return StreamingResponse(_relay(), media_type="application/x-ndjson")

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(f"{OLLAMA_URL}/api/generate", json=payload)
        resp.raise_for_status()
        return resp.json()


# ── Watchdog de Ollama (sin procesos duplicados) ───────────────────────────

_ollama_proc: subprocess.Popen | None = None


def _watchdog_ollama() -> None:
    """Cada 30s verifica Ollama; si cayó lo relanza — solo si no hay uno ya lanzado por nosotros vivo."""
    global _ollama_proc
    while True:
        time.sleep(30)
        try:
            httpx.get(f"{OLLAMA_URL}/api/tags", timeout=4.0).raise_for_status()
            continue  # Ollama OK
        except Exception:
            pass

        if _ollama_proc is not None and _ollama_proc.poll() is None:
            # Ya lanzamos uno y sigue vivo (posiblemente cargando); no duplicar
            continue

        print("[lixbon Watchdog] Ollama no responde. Intentando reiniciar...")
        try:
            _ollama_proc = subprocess.Popen(
                ["ollama", "serve"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            time.sleep(5)
            print("[lixbon Watchdog] Ollama relanzado.")
        except Exception as exc:
            print(f"[lixbon Watchdog] No se pudo reiniciar Ollama: {exc}")


# ── Modo conexión: el nodo llama al gateway ────────────────────────────────
# Frames JSON por WebSocket. nodo→gateway: hello, metrics, response, chunk,
# end, error. gateway→nodo: welcome, request, cancel. Cada petición viaja con
# su `id`; varias comparten el socket.

_RUTAS_PERMITIDAS = {"/api/chat", "/api/generate", "/api/embed", "/api/tags", "/api/show"}
_WS_MAX_FRAME = 64 * 1024 * 1024


def _leer_identidad() -> dict | None:
    try:
        datos = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if datos.get("node_id") and datos.get("secret"):
            return datos
    except (OSError, ValueError):
        pass
    return None


def _guardar_identidad(datos: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(datos, indent=2), encoding="utf-8")
    try:
        os.chmod(STATE_FILE, 0o600)
    except OSError:
        pass


async def _enrolar(gateway: str, enroll_token: str) -> dict:
    payload = {
        "enroll_token": enroll_token,
        "name": os.getenv("LIXBON_NODE_NAME") or None,
        "hostname": _hostname(),
        "provider": os.getenv("LIXBON_PROVIDER") or None,
        "agent_version": AGENT_VERSION,
        "node_id": os.getenv("LIXBON_NODE_ID") or None,
    }
    async with httpx.AsyncClient(timeout=20.0) as client:
        for intento in range(5):
            try:
                resp = await client.post(f"{gateway}/api/nodes/enroll", json=payload)
                break
            except httpx.HTTPError as exc:
                if intento == 4:
                    raise SystemExit(f"[lixbon Agent] No se pudo contactar con {gateway}: {exc}")
                print(f"[lixbon Agent] Gateway no responde ({exc}); reintento en 3s...")
                await asyncio.sleep(3)
    if resp.status_code != 200:
        detalle = resp.json().get("detail") if "json" in resp.headers.get("content-type", "") else resp.text
        raise SystemExit(f"[lixbon Agent] Enrolamiento rechazado ({resp.status_code}): {detalle}")
    datos = resp.json()
    identidad = {"gateway": gateway, "node_id": datos["node_id"], "secret": datos["secret"]}
    _guardar_identidad(identidad)
    print(f"[lixbon Agent] Enrolado como '{datos['node_id']}' ({datos.get('name')}). Identidad en {STATE_FILE}")
    return identidad


def _identidad_o_enrolar(gateway: str) -> dict:
    identidad = _leer_identidad()
    if identidad and identidad.get("gateway", gateway) == gateway:
        return identidad
    enroll = os.getenv("LIXBON_ENROLL", "").strip()
    secreto_fijo = os.getenv("LIXBON_NODE_SECRET", "").strip()
    node_id_fijo = os.getenv("LIXBON_NODE_ID", "").strip()
    if secreto_fijo and node_id_fijo:
        identidad = {"gateway": gateway, "node_id": node_id_fijo, "secret": secreto_fijo}
        _guardar_identidad(identidad)
        return identidad
    if not enroll:
        raise SystemExit(
            "[lixbon Agent] Sin identidad. Genera un token en el panel admin (Nodos -> Añadir GPU)\n"
            "y arranca con LIXBON_ENROLL=<token>, o define LIXBON_NODE_ID + LIXBON_NODE_SECRET."
        )
    return asyncio.run(_enrolar(gateway, enroll))


class _Conexion:
    def __init__(self, ws, intervalo: int):
        self.ws = ws
        self.intervalo = intervalo
        self._envio = asyncio.Lock()
        self._tareas: dict[str, asyncio.Task] = {}

    async def enviar(self, msg: dict) -> None:
        async with self._envio:
            await self.ws.send(json.dumps(msg, ensure_ascii=False))

    async def bucle_metricas(self) -> None:
        while True:
            try:
                await self.enviar({"type": "metrics", "data": await _recolectar_metricas()})
            except Exception as exc:
                print(f"[lixbon Agent] No se pudieron enviar métricas: {exc}")
                return
            await asyncio.sleep(self.intervalo)

    def despachar(self, msg: dict) -> None:
        tipo = msg.get("type")
        rid = msg.get("id")
        if tipo == "request" and rid:
            self._tareas[rid] = asyncio.create_task(self._atender(rid, msg))
            self._tareas[rid].add_done_callback(lambda _t, rid=rid: self._tareas.pop(rid, None))
        elif tipo == "cancel" and rid in self._tareas:
            self._tareas[rid].cancel()

    async def _atender(self, rid: str, msg: dict) -> None:
        path = str(msg.get("path") or "").split("?", 1)[0]
        metodo = str(msg.get("method") or "GET").upper()
        if path not in _RUTAS_PERMITIDAS:
            await self.enviar({"type": "response", "id": rid, "status": 404, "headers": {"content-type": "application/json"}})
            await self.enviar({"type": "chunk", "id": rid, "data": json.dumps({"error": f"ruta no permitida: {path}"})})
            await self.enviar({"type": "end", "id": rid})
            return

        cuerpo = msg.get("body")
        # Lectura larga: la petición puede esperar en la cola de Ollama detrás
        # de otra generación y luego evaluar un prompt grande en silencio.
        timeout = httpx.Timeout(900.0, connect=10.0)
        respondido = False
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream(metodo, f"{OLLAMA_URL}{path}", json=cuerpo) as resp:
                    cabeceras = {k: v for k, v in resp.headers.items() if k.lower() in ("content-type",)}
                    await self.enviar({"type": "response", "id": rid, "status": resp.status_code, "headers": cabeceras})
                    respondido = True
                    async for trozo in resp.aiter_text():
                        if trozo:
                            await self.enviar({"type": "chunk", "id": rid, "data": trozo})
            await self.enviar({"type": "end", "id": rid})
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if not respondido:
                await self.enviar({"type": "response", "id": rid, "status": 502, "headers": {"content-type": "application/json"}})
                await self.enviar({"type": "chunk", "id": rid, "data": json.dumps({"error": f"Ollama no responde: {exc}"})})
                await self.enviar({"type": "end", "id": rid})
            else:
                await self.enviar({"type": "error", "id": rid, "message": str(exc)})

    def cancelar_todo(self) -> None:
        for t in self._tareas.values():
            t.cancel()
        self._tareas.clear()


async def _sesion(ws_url: str, identidad: dict) -> str | None:
    """Una conexión completa. Devuelve un código de error terminal o None si se cortó."""
    from websockets.asyncio.client import connect

    async with connect(ws_url, max_size=_WS_MAX_FRAME, ping_interval=20, ping_timeout=20) as ws:
        await ws.send(json.dumps({
            "type": "hello",
            "node_id": identidad["node_id"],
            "secret": identidad["secret"],
            "hostname": _hostname(),
            "agent_version": AGENT_VERSION,
            "provider": os.getenv("LIXBON_PROVIDER") or None,
        }))
        bienvenida = json.loads(await ws.recv())
        if bienvenida.get("type") != "welcome":
            print(f"[lixbon Agent] Gateway rechazó la conexión: {bienvenida.get('message')}")
            return bienvenida.get("code") or "rejected"

        conexion = _Conexion(ws, int(bienvenida.get("metrics_interval") or 10))
        print(f"[lixbon Agent] Conectado como '{identidad['node_id']}'. Métricas cada {conexion.intervalo}s.")
        metricas = asyncio.create_task(conexion.bucle_metricas())
        try:
            async for crudo in ws:
                try:
                    conexion.despachar(json.loads(crudo))
                except ValueError:
                    continue
        finally:
            metricas.cancel()
            conexion.cancelar_todo()
    return None


async def _asegurar_modelos() -> None:
    """Descarga los LIXBON_MODELS que falten. En background: el nodo ya sirve
    los que tiene mientras bajan los demás."""
    pedidos = [m.strip() for m in os.getenv("LIXBON_MODELS", "").split(",") if m.strip()]
    if not pedidos:
        return
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(3600.0, connect=10.0)) as client:
            for _ in range(30):
                try:
                    resp = await client.get(f"{OLLAMA_URL}/api/tags", timeout=5.0)
                    resp.raise_for_status()
                    break
                except Exception:
                    await asyncio.sleep(2)
            else:
                print("[lixbon Agent] Ollama no arrancó: no se descargan modelos.")
                return
            instalados = {m.get("name") for m in resp.json().get("models", [])}
            for modelo in pedidos:
                nombre = modelo if ":" in modelo else f"{modelo}:latest"
                if nombre in instalados:
                    continue
                print(f"[lixbon Agent] Descargando {modelo}...")
                r = await client.post(f"{OLLAMA_URL}/api/pull", json={"model": modelo, "stream": False})
                print(f"[lixbon Agent] {modelo}: {'listo' if r.status_code == 200 else r.text[:200]}")
    except Exception as exc:
        print(f"[lixbon Agent] Error descargando modelos: {exc}")


def _modo_conexion(gateway: str) -> None:
    gateway = gateway.rstrip("/")
    identidad = _identidad_o_enrolar(gateway)
    ws_url = ("wss://" if gateway.startswith("https://") else "ws://") + gateway.split("://", 1)[1] + "/api/nodes/ws"

    async def _bucle() -> None:
        asyncio.create_task(_asegurar_modelos())
        espera = 2.0
        while True:
            inicio = time.monotonic()
            try:
                codigo = await _sesion(ws_url, identidad)
            except Exception as exc:
                codigo = None
                print(f"[lixbon Agent] Conexión perdida: {exc}")
            if codigo in ("unauthorized", "url_node", "disabled"):
                if codigo == "unauthorized":
                    print(f"[lixbon Agent] Identidad inválida. Borra {STATE_FILE} y vuelve a enrolar.")
                raise SystemExit(3)
            # Una sesión larga que se corta se reintenta rápido; fallos seguidos, con backoff
            if time.monotonic() - inicio > 60:
                espera = 2.0
            retardo = espera + random.uniform(0, 1)
            print(f"[lixbon Agent] Reconectando en {retardo:.0f}s...")
            await asyncio.sleep(retardo)
            espera = min(espera * 2, 60.0)

    asyncio.run(_bucle())


# ── Registro en Task Scheduler de Windows ──────────────────────────────────

def instalar_tarea() -> bool:
    python = sys.executable
    extra = " ".join(a for a in sys.argv[1:] if a != "--install")
    cmd = (
        f'schtasks /Create /F /SC ONSTART /DELAY 0000:30 '
        f'/TN "{TASK_NAME}" '
        f'/TR "\\"{python}\\" -m core.node_agent.agent {extra}" '
        f'/RU SYSTEM /RL HIGHEST'
    )
    resultado = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if resultado.returncode == 0:
        print(f"[node_agent] Tarea '{TASK_NAME}' registrada.")
    else:
        print(f"[node_agent] Error al registrar tarea:\n{resultado.stderr}")
        print("[node_agent] Ejecuta como Administrador.")
    return resultado.returncode == 0


def desinstalar_tarea() -> None:
    resultado = subprocess.run(
        f'schtasks /Delete /F /TN "{TASK_NAME}"',
        shell=True, capture_output=True, text=True,
    )
    if resultado.returncode == 0:
        print(f"[node_agent] Tarea '{TASK_NAME}' eliminada.")
    else:
        print(f"[node_agent] No se encontró la tarea:\n{resultado.stderr}")


# ── Punto de entrada ───────────────────────────────────────────────────────

def main() -> None:
    if "--install" in sys.argv:
        instalar_tarea()
        sys.exit(0)
    if "--uninstall" in sys.argv:
        desinstalar_tarea()
        sys.exit(0)

    gateway = os.getenv("LIXBON_GATEWAY", "").strip()
    if "--connect" in sys.argv:
        idx = sys.argv.index("--connect")
        if idx + 1 >= len(sys.argv) or sys.argv[idx + 1].startswith("--"):
            sys.exit("[lixbon Agent] Uso: --connect https://lixbon.com")
        gateway = sys.argv[idx + 1]
    if gateway:
        if OLLAMA_WATCHDOG:
            threading.Thread(target=_watchdog_ollama, daemon=True, name="ollama-watchdog").start()
        print(f"[lixbon Agent v{AGENT_VERSION}] Modo conexión -> {gateway}")
        print(f"[lixbon Agent] Ollama local: {OLLAMA_URL}")
        _modo_conexion(gateway)
        return

    if not NODE_SHARED_SECRET:
        print("=" * 60)
        print("ADVERTENCIA: NODE_SHARED_SECRET no está configurado.")
        print("Las rutas protegidas responderán 503 hasta definirlo.")
        print('Genera uno: python -c "import secrets; print(secrets.token_urlsafe(32))"')
        print("=" * 60)

    if OLLAMA_WATCHDOG:
        threading.Thread(target=_watchdog_ollama, daemon=True, name="ollama-watchdog").start()
        print("[lixbon Watchdog] Monitoreando Ollama cada 30s.")

    import uvicorn
    print(f"[lixbon Agent v{AGENT_VERSION}] Escuchando en http://0.0.0.0:{PORT}")
    print(f"[lixbon Agent] Ollama local: {OLLAMA_URL}")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
