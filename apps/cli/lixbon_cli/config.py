"""Configuración local del CLI (~/.lixbon/config.json)."""
import json
from pathlib import Path

CLI_VERSION = "2.2.0"

DEFAULT_BASE_URL = "https://lixbon.com/v1"
CONFIG_DIR = Path.home() / ".lixbon"
CONFIG_FILE = CONFIG_DIR / "config.json"
HISTORY_FILE = CONFIG_DIR / "history"


def default_config() -> dict:
    return {
        "base_url": DEFAULT_BASE_URL,
        "api_key": "",
        "model": "",
        "key_model": "",  # Si está definido, la key es de modelo específico (no se puede cambiar)
        "max_context_messages": 12,
        # Ventana de contexto que se le pide a Ollama (num_ctx) y con la que se
        # calcula el presupuesto del turno de agente. 8192 se quedaba corto: los
        # resultados de las herramientas la llenaban en pocos pasos y el modelo
        # se quedaba sin system prompt (Ollama recorta por delante), que es como
        # el agente acababa congelado. Si el nodo va justo de VRAM, bájala con
        # /context-window: el CLI se adapta al valor que haya.
        "context_window": 16384,
        "mode": "agent",  # por defecto el modelo puede crear/editar archivos (con aprobación)
        "workspace": str(Path.cwd()),
        "auto_approve_tools": True,  # el agente escribe directo; /approve off para pedir confirmación
        # Poder escribir mientras el agente trabaja (se ejecuta al terminar).
        # A false, el teclado vuelve a estar muerto durante el turno.
        "input_queue": True,
    }


def load_config() -> dict:
    cfg = default_config()
    if not CONFIG_FILE.exists():
        return cfg
    try:
        stored = json.loads(CONFIG_FILE.read_text(encoding="utf-8-sig"))
        cfg.update({k: v for k, v in stored.items() if v is not None})
    except Exception:
        pass
    return cfg


def save_config(cfg: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    # El config guarda la API key: solo el dueño debe poder leerlo.
    # En Windows chmod es casi un no-op (ACLs aparte); en POSIX evita que el
    # umask por defecto lo deje legible para todo el mundo.
    try:
        CONFIG_FILE.chmod(0o600)
    except OSError:
        pass


def server_base(base_url: str) -> str:
    """https://lixbon.com/v1 -> https://lixbon.com (raíz para /api/*)."""
    base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
    return base_url.rsplit("/v1", 1)[0] if base_url.endswith("/v1") else base_url


def mask_key(key: str) -> str:
    if not key:
        return "no configurada"
    return f"{key[:10]}{'…' if len(key) > 14 else ''}{key[-4:]}" if len(key) > 14 else "***"
