"""
agent.py — Node Agent de lixbon (corre en cada PC con GPU).
Expone métricas y hace de proxy autenticado hacia el Ollama local.
Ollama NUNCA se expone directo a internet: todo pasa por este agente.

Seguridad:
- Toda ruta (excepto /health) exige el header X-Node-Token == NODE_SHARED_SECRET.
- Sin NODE_SHARED_SECRET configurado, el agente arranca pero responde 503
  en las rutas protegidas (evita exponer la GPU por accidente).

Uso:
  python -m core.node_agent.agent               # Iniciar
  python -m core.node_agent.agent --install     # Autoarranque en Windows (Task Scheduler)
  python -m core.node_agent.agent --uninstall

Variables de entorno:
  NODE_SHARED_SECRET  Token que debe enviar el gateway (obligatorio en producción)
  AGENT_PORT          Puerto HTTP (default: 8765)
  OLLAMA_URL          Ollama local (default: http://127.0.0.1:11434)
  OLLAMA_WATCHDOG     '1' para reiniciar Ollama si cae (default: 1)
"""
from __future__ import annotations

import asyncio
import os
import platform
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
AGENT_VERSION = "3.1.0"

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


@app.get("/metrics")
async def metrics(_: None = Depends(require_node_token)):
    cpu = psutil.cpu_percent(interval=0.3)
    mem = psutil.virtual_memory()
    modelos, model_info = await _ollama_model_info()
    return {
        "cpu_percent": round(cpu, 1),
        "ram_percent": round(mem.percent, 1),
        "ram_free_gb": round(mem.available / (1024 ** 3), 2),
        "ram_total_gb": round(mem.total / (1024 ** 3), 2),
        "hostname": os.environ.get("COMPUTERNAME", platform.node()),
        "models": modelos,          # lista plana: contrato viejo, no tocar
        "model_info": model_info,   # + capabilities por modelo (gateway ≥ 2.5)
        "agent_version": AGENT_VERSION,
        **_gpu_metrics(),
    }


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


# ── Registro en Task Scheduler de Windows ──────────────────────────────────

def instalar_tarea() -> bool:
    python = sys.executable
    cmd = (
        f'schtasks /Create /F /SC ONSTART /DELAY 0000:30 '
        f'/TN "{TASK_NAME}" '
        f'/TR "\\"{python}\\" -m core.node_agent.agent" '
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
