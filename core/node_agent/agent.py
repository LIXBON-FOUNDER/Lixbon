"""
node_agent.py — Agente de métricas para nodos FOLAX DTC
=======================================================
Corre en cada equipo worker. Expone métricas de CPU/RAM/GPU y lista de modelos.

Mejoras v2.0:
- GET /info     — info estática del nodo (hostname, OS, versiones)
- GET /metrics  — incluye 'models' para evitar request extra al orquestador
- Watchdog de Ollama: lo reinicia si detecta que cayó

Uso:
  python app/node_agent.py                # Iniciar el agente
  python app/node_agent.py --install      # Registrar inicio automático en Windows
  python app/node_agent.py --uninstall    # Eliminar inicio automático

Variables de entorno:
  AGENT_PORT   Puerto HTTP  (default: 8765)
  OLLAMA_URL   URL de Ollama local (default: http://127.0.0.1:11434)
  OLLAMA_WATCHDOG  '1' para habilitar watchdog (default: 1)
"""

import json
import os
import platform
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

# ──────────────────────────────────────────────
# Auto-instalación de psutil si no está presente
# ──────────────────────────────────────────────
try:
    import psutil
except ImportError:
    print("[node_agent] psutil no encontrado. Instalando...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "psutil", "--quiet"])
    import psutil

PORT = int(os.getenv("AGENT_PORT", "8765"))
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_WATCHDOG = os.getenv("OLLAMA_WATCHDOG", "1") == "1"
TASK_NAME = "FOLAX_NodeAgent"
AGENT_VERSION = "2.0.0"


# ──────────────────────────────────────────────
# Recolección de métricas
# ──────────────────────────────────────────────

def _gpu_metrics() -> dict:
    """Lee GPU via nvidia-smi. Devuelve valores neutrales si no hay GPU."""
    try:
        resultado = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu,memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if resultado.returncode != 0:
            raise RuntimeError("nvidia-smi falló")

        linea = resultado.stdout.strip().split("\n")[0]  # Primera GPU
        partes = [p.strip() for p in linea.split(",")]
        uso_gpu = float(partes[0])
        mem_usada_mb = float(partes[1])
        mem_total_mb = float(partes[2])
        mem_libre_mb = mem_total_mb - mem_usada_mb
        gpu_libre_pct = (mem_libre_mb / mem_total_mb) * 100.0

        return {
            "gpu_available": True,
            "gpu_used_percent": round(uso_gpu, 1),
            "gpu_free_mb": round(mem_libre_mb, 1),
            "gpu_total_mb": round(mem_total_mb, 1),
            "gpu_free_percent": round(gpu_libre_pct, 1),
        }
    except Exception:
        return {
            "gpu_available": False,
            "gpu_used_percent": 0.0,
            "gpu_free_mb": 0.0,
            "gpu_total_mb": 0.0,
            "gpu_free_percent": 50.0,  # Valor neutral para el scoring
        }


def _fetch_ollama_models() -> list[str]:
    """Obtiene la lista de modelos instalados en Ollama local."""
    try:
        import urllib.request as _url_req
        with _url_req.urlopen(f"{OLLAMA_URL}/api/tags", timeout=4) as resp:
            data = json.loads(resp.read().decode())
        return [m["name"] for m in data.get("models", [])]
    except Exception:
        return []


def obtener_metricas() -> dict:
    """Recopila CPU, RAM, GPU y modelos disponibles del equipo local."""
    cpu = psutil.cpu_percent(interval=0.5)
    mem = psutil.virtual_memory()
    ram_libre_gb = round(mem.available / (1024 ** 3), 2)
    ram_total_gb = round(mem.total / (1024 ** 3), 2)

    gpu = _gpu_metrics()

    return {
        "cpu_percent": round(cpu, 1),
        "ram_percent": round(mem.percent, 1),
        "ram_free_gb": ram_libre_gb,
        "ram_total_gb": ram_total_gb,
        "ollama_url": OLLAMA_URL,
        "hostname": os.environ.get("COMPUTERNAME", platform.node()),
        "models": _fetch_ollama_models(),  # Incluido para evitar request extra del orquestador
        **gpu,
    }


def obtener_info() -> dict:
    """Devuelve información estática del nodo (no cambia entre polls)."""
    return {
        "hostname": os.environ.get("COMPUTERNAME", platform.node()),
        "os": f"{platform.system()} {platform.release()}",
        "python_version": platform.python_version(),
        "agent_version": AGENT_VERSION,
        "ollama_url": OLLAMA_URL,
        "port": PORT,
    }


# ──────────────────────────────────────────────
# Servidor HTTP mínimo (solo stdlib)
# ──────────────────────────────────────────────

class AgentHandler(BaseHTTPRequestHandler):
    """Maneja las peticiones HTTP del agente."""

    def log_message(self, format, *args):
        # Silenciar logs de acceso en consola (opcional)
        pass

    def do_GET(self):
        if self.path == "/metrics":
            try:
                datos = obtener_metricas()
                cuerpo = json.dumps(datos, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(cuerpo)))
                self.end_headers()
                self.wfile.write(cuerpo)
            except Exception as exc:
                error = json.dumps({"error": str(exc)}).encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(error)

        elif self.path == "/info":
            try:
                datos = obtener_info()
                cuerpo = json.dumps(datos, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(cuerpo)))
                self.end_headers()
                self.wfile.write(cuerpo)
            except Exception as exc:
                error = json.dumps({"error": str(exc)}).encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(error)

        elif self.path == "/health":
            cuerpo = b'{"status":"ok","service":"FOLAX Node Agent"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(cuerpo)

        else:
            self.send_response(404)
            self.end_headers()


def iniciar_servidor():
    """Arranca el servidor HTTP en un hilo separado."""
    servidor = HTTPServer(("0.0.0.0", PORT), AgentHandler)
    hilo = threading.Thread(target=servidor.serve_forever, daemon=True)
    hilo.start()
    print(f"[FOLAX Agent] Escuchando en http://0.0.0.0:{PORT}/metrics")
    print(f"[FOLAX Agent] Ollama local:    {OLLAMA_URL}")
    print(f"[FOLAX Agent] Versión:         {AGENT_VERSION}")
    return servidor


def _watchdog_ollama():
    """
    Watchdog: verifica cada 30s si Ollama responde.
    Si detecta que cayó, intenta reiniciarlo con 'ollama serve'.
    """
    import urllib.request as _url_req
    while True:
        time.sleep(30)
        try:
            with _url_req.urlopen(f"{OLLAMA_URL}/api/tags", timeout=4):
                pass  # Ollama OK
        except Exception:
            print("[FOLAX Watchdog] Ollama no responde. Intentando reiniciar...")
            try:
                subprocess.Popen(
                    ["ollama", "serve"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                time.sleep(5)
                print("[FOLAX Watchdog] Ollama reiniciado.")
            except Exception as exc:
                print(f"[FOLAX Watchdog] No se pudo reiniciar Ollama: {exc}")


# ──────────────────────────────────────────────
# Registro en Task Scheduler de Windows
# ──────────────────────────────────────────────

def _ruta_python() -> str:
    return sys.executable


def _ruta_script() -> str:
    return os.path.abspath(__file__)


def instalar_tarea():
    """Registra el agente como tarea de inicio en Windows Task Scheduler."""
    python = _ruta_python()
    script = _ruta_script()
    cmd = (
        f'schtasks /Create /F /SC ONSTART /DELAY 0000:30 '
        f'/TN "{TASK_NAME}" '
        f'/TR "\\"{python}\\" \\"{script}\\"" '
        f'/RU SYSTEM /RL HIGHEST'
    )
    resultado = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if resultado.returncode == 0:
        print(f"[node_agent] Tarea '{TASK_NAME}' registrada. Se iniciará automáticamente con Windows.")
    else:
        print(f"[node_agent] Error al registrar tarea:\n{resultado.stderr}")
        print("[node_agent] Intenta ejecutar este script como Administrador.")
    return resultado.returncode == 0


def desinstalar_tarea():
    """Elimina la tarea del Task Scheduler."""
    cmd = f'schtasks /Delete /F /TN "{TASK_NAME}"'
    resultado = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if resultado.returncode == 0:
        print(f"[node_agent] Tarea '{TASK_NAME}' eliminada.")
    else:
        print(f"[node_agent] No se encontró la tarea o error al eliminarla:\n{resultado.stderr}")


# ──────────────────────────────────────────────
# Punto de entrada
# ──────────────────────────────────────────────

if __name__ == "__main__":
    if "--install" in sys.argv:
        instalar_tarea()
        sys.exit(0)

    if "--uninstall" in sys.argv:
        desinstalar_tarea()
        sys.exit(0)

    servidor = iniciar_servidor()

    # Iniciar watchdog de Ollama si está habilitado
    if OLLAMA_WATCHDOG:
        threading.Thread(target=_watchdog_ollama, daemon=True, name="ollama-watchdog").start()
        print("[FOLAX Watchdog] Monitoreando Ollama cada 30s.")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[FOLAX Agent] Deteniendo agente...")
        servidor.shutdown()
