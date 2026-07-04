import asyncio
import time
import httpx
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from core.gateway import deps
from core.persistence import queries as db
from core.config import OLLAMA_BASE_URL

router = APIRouter()

async def check_database_status() -> tuple[str, int]:
    """Prueba la conexión a la base de datos y mide su latencia."""
    start_time = time.perf_counter()
    try:
        # Hacemos una consulta rápida e inofensiva
        db.get_user_by_id(1)
        latency = int((time.perf_counter() - start_time) * 1000)
        return "online", latency
    except Exception:
        return "offline", 0

async def check_ollama_status() -> tuple[str, list[str]]:
    """Comprueba si el servidor de Ollama está online y qué modelos tiene."""
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.get(f"{OLLAMA_BASE_URL}/api/tags")
            if response.status_code == 200:
                models_data = response.json().get("models", [])
                models = [m.get("name") for m in models_data]
                return "online", models
    except Exception:
        pass
    return "offline", []

@router.websocket("/ws/status")
async def ws_status_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            # Comprobar base de datos
            db_status, db_latency = await check_database_status()
            
            # Comprobar Ollama
            ollama_status, ollama_models = await check_ollama_status()
            
            # Comprobar Node Agents (orquestador)
            nodos = []
            if hasattr(deps, "orquestador") and deps.orquestador is not None:
                try:
                    nodos = deps.orquestador.estado_nodos()
                except Exception:
                    pass
            
            # Formatear el payload
            payload = {
                "server": {
                    "status": "online",
                    "version": "2.4.0",
                },
                "database": {
                    "status": db_status,
                    "latency_ms": db_latency
                },
                "ollama": {
                    "status": ollama_status,
                    "models": ollama_models
                },
                "nodes": nodos,
                "timestamp": time.time()
            }
            
            await websocket.send_json(payload)
            
            # Dormir 5 segundos antes del siguiente ping
            await asyncio.sleep(5)
            
    except WebSocketDisconnect:
        pass
    except Exception:
        # En caso de otros errores, cerrar de forma segura
        try:
            await websocket.close()
        except Exception:
            pass
