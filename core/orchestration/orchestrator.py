"""
orchestrator.py — Orquestador de nodos FOLAX DTC v2.0
=====================================================
Gestiona el estado de los nodos, elige el mejor según recursos
disponibles y reenvía peticiones al Ollama del nodo ganador.

Mejoras v2.0:
- Poll inicial inmediato (no espera POLL_INTERVAL para el primer estado)
- Circuit breaker con backoff exponencial (1 min → 5 min → 15 min)
- Round-robin para desempatar nodos con score idéntico
"""

import json
import logging
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger("folax.orchestrator")

# Ruta al archivo de configuración de nodos (raíz del monorepo)
NODES_CONFIG_PATH = Path(__file__).resolve().parents[2] / "nodes.json"

# Intervalo de polling de métricas (segundos)
POLL_INTERVAL = 15

# Cuántos fallos consecutivos marcan un nodo como offline
MAX_FALLOS = 2

# Backoff exponencial: fallos → segundos de espera antes de reintentar
CIRCUIT_BACKOFF = {2: 60, 4: 300, 8: 900}   # 1 min, 5 min, 15 min

# Pesos para el scoring (deben sumar 1.0)
PESO_CPU = 0.25
PESO_RAM = 0.35
PESO_GPU = 0.40


def _calcular_score(metricas: dict) -> float:
    """
    Calcula un score de 0-100. Mayor score = más recursos libres.
    Si no hay GPU, usa 50.0 como valor neutral.
    """
    cpu_libre = 100.0 - float(metricas.get("cpu_percent", 100))
    ram_libre = 100.0 - float(metricas.get("ram_percent", 100))
    gpu_libre = float(metricas.get("gpu_free_percent", 50.0))

    return round(
        cpu_libre * PESO_CPU + ram_libre * PESO_RAM + gpu_libre * PESO_GPU,
        2,
    )


class NodeOrchestrator:
    """
    Orquestador de nodos LAN. Hace polling de métricas en background
    y expone best_node() para seleccionar el nodo más libre.
    """

    def __init__(self):
        self._nodos: list[dict] = []          # Config estática de nodes.json
        self._estado: dict[str, dict] = {}    # Estado dinámico por node id
        self._lock = threading.Lock()
        self._rr_index: int = 0               # Índice para round-robin
        self._hilo_poll: threading.Thread | None = None
        self._activo = False
        self._cliente = httpx.Client(timeout=5.0)

    # ──────────────────────────────────────────
    # Inicialización
    # ──────────────────────────────────────────

    def cargar_nodos(self) -> None:
        """Carga la lista de nodos desde nodes.json."""
        if not NODES_CONFIG_PATH.exists():
            logger.warning("nodes.json no encontrado. Sin nodos registrados.")
            return

        try:
            with NODES_CONFIG_PATH.open(encoding="utf-8") as f:
                self._nodos = json.load(f)
            logger.info(f"Nodos cargados: {[n['id'] for n in self._nodos]}")

            # Inicializar estado de cada nodo
            for nodo in self._nodos:
                nid = nodo["id"]
                if nid not in self._estado:
                    self._estado[nid] = {
                        "online": False,
                        "fallos": 0,
                        "next_retry": 0.0,     # timestamp hasta el que no se intenta
                        "metricas": {},
                        "modelos": [],
                        "score": 0.0,
                        "ultimo_poll": None,
                        "config": nodo,
                    }
        except Exception as exc:
            logger.error(f"Error al cargar nodes.json: {exc}")

    def iniciar(self) -> None:
        """Arranca el hilo de polling en background. Hace un primer poll inmediato."""
        self.cargar_nodos()
        if not self._nodos:
            logger.warning("Sin nodos configurados. El orquestador usará Ollama local como fallback.")
            return

        self._activo = True

        # ── Poll inicial inmediato (no esperar POLL_INTERVAL para tener datos) ──
        for nodo in self._nodos:
            try:
                self._poll_nodo(nodo)
            except Exception:
                pass

        self._hilo_poll = threading.Thread(
            target=self._loop_polling,
            daemon=True,
            name="orchestrator-poll",
        )
        self._hilo_poll.start()
        logger.info(f"Orquestador iniciado. Polling cada {POLL_INTERVAL}s.")

    def detener(self) -> None:
        """Detiene el hilo de polling."""
        self._activo = False
        self._cliente.close()

    # ──────────────────────────────────────────
    # Polling de métricas
    # ──────────────────────────────────────────

    def _loop_polling(self) -> None:
        """Hilo principal de polling. Corre indefinidamente."""
        while self._activo:
            for nodo in self._nodos:
                self._poll_nodo(nodo)
            time.sleep(POLL_INTERVAL)

    def _poll_nodo(self, nodo: dict) -> None:
        """Consulta /metrics de un nodo y actualiza su estado. Respeta el circuit breaker."""
        nid = nodo["id"]
        now = time.time()

        # Circuit breaker: skip si el nodo está en backoff
        with self._lock:
            next_retry = self._estado[nid].get("next_retry", 0.0)
        if now < next_retry:
            return

        url = f"{nodo['agent_url'].rstrip('/')}/metrics"

        try:
            # Try to get metrics from the agent
            try:
                resp = self._cliente.get(url)
                resp.raise_for_status()
                metricas = resp.json()
            except Exception:
                # Fallback: Check if Ollama is alive directly
                ollama_url_tags = f"{nodo['ollama_url'].rstrip('/')}/api/tags"
                resp_ollama = self._cliente.get(ollama_url_tags)
                resp_ollama.raise_for_status()
                # Mock metrics if Ollama is up but agent is down
                metricas = {
                    "cpu_percent": 0.0,
                    "ram_percent": 0.0,
                    "gpu_free_percent": 100.0,
                    "models": [m["name"] for m in resp_ollama.json().get("models", [])]
                }

            # Si /metrics incluye modelos, usarlos directamente; si no, buscarlos aparte
            if "models" in metricas:
                modelos = metricas.pop("models", [])
            else:
                modelos = self._fetch_modelos_nodo(nodo)

            score = _calcular_score(metricas)

            with self._lock:
                self._estado[nid].update({
                    "online": True,
                    "fallos": 0,
                    "next_retry": 0.0,
                    "metricas": metricas,
                    "modelos": modelos,
                    "score": score,
                    "ultimo_poll": time.time(),
                })
            logger.debug(f"[{nid}] score={score} modelos={len(modelos)} cpu={metricas.get('cpu_percent')}%")

        except Exception as exc:
            with self._lock:
                estado = self._estado[nid]
                estado["fallos"] += 1
                fallos = estado["fallos"]

                # Circuit breaker: calcular tiempo de backoff
                wait_seconds = 0
                for threshold, wait in sorted(CIRCUIT_BACKOFF.items(), reverse=True):
                    if fallos >= threshold:
                        wait_seconds = wait
                        break

                if fallos >= MAX_FALLOS:
                    estado["online"] = False
                    if wait_seconds:
                        estado["next_retry"] = time.time() + wait_seconds
                        logger.warning(f"[{nid}] Offline ({exc}). Reintento en {wait_seconds}s.")
                    else:
                        logger.warning(f"[{nid}] Offline ({exc})")

    def _fetch_modelos_nodo(self, nodo: dict) -> list[str]:
        """
        Consulta /api/tags del Ollama del nodo y retorna la lista de nombres de modelos.
        Retorna lista vacía si falla.
        """
        try:
            url = f"{nodo['ollama_url'].rstrip('/')}/api/tags"
            resp = self._cliente.get(url)
            resp.raise_for_status()
            data = resp.json()
            return [m["name"] for m in data.get("models", [])]
        except Exception:
            return []

    # ──────────────────────────────────────────
    # Selección del mejor nodo
    # ──────────────────────────────────────────

    def best_node(self) -> dict | None:
        """
        Retorna la config del nodo con mayor score entre los online.
        Usa round-robin como desempate entre nodos con score idéntico.
        Retorna None si no hay nodos online.
        """
        with self._lock:
            candidatos = [est for est in self._estado.values() if est["online"]]

        if not candidatos:
            return None

        max_score = max(e["score"] for e in candidatos)
        empatados = [e for e in candidatos if e["score"] == max_score]

        # Round-robin entre empatados para distribuir carga
        with self._lock:
            ganador = empatados[self._rr_index % len(empatados)]
            self._rr_index = (self._rr_index + 1) % max(len(empatados), 1)

        return ganador["config"]

    def best_node_for_model(self, model: str) -> dict | None:
        """
        Retorna la config del nodo online con mayor score que tenga el modelo instalado.
        Si ningún nodo tiene el modelo, retorna el nodo con mayor score (Ollama lo
        descargará en el momento, o fallará con error claro).
        Retorna None si no hay nodos online.
        """
        with self._lock:
            online = [est for est in self._estado.values() if est["online"]]

        if not online:
            return None

        # Preferir nodos que ya tienen el modelo instalado
        con_modelo = [est for est in online if model in est["modelos"]]
        candidatos = con_modelo if con_modelo else online

        ganador = max(candidatos, key=lambda e: e["score"])
        return ganador["config"]

    def todos_los_modelos(self) -> list[dict]:
        """
        Agrega los modelos de todos los nodos online.
        Retorna lista de dicts con id, nodo y metadata.
        Los modelos duplicados (mismo nombre en varios nodos) se agrupan.
        """
        vistos: dict[str, dict] = {}
        with self._lock:
            for est in self._estado.values():
                if not est["online"]:
                    continue
                nid = est["config"]["id"]
                for nombre in est["modelos"]:
                    if nombre not in vistos:
                        vistos[nombre] = {
                            "id": nombre,
                            "object": "model",
                            "owned_by": "ollama",
                            "nodos": [nid],
                        }
                    else:
                        vistos[nombre]["nodos"].append(nid)
        return list(vistos.values())

    # ──────────────────────────────────────────
    # Proxy de petición al nodo ganador
    # ──────────────────────────────────────────

    async def proxy_chat(
        self,
        ollama_url: str,
        model: str,
        messages: list[dict],
        async_client: httpx.AsyncClient,
    ) -> dict[str, Any]:
        """
        Envía la petición de chat al Ollama del nodo seleccionado.
        Lanza httpx.HTTPError si falla.
        """
        url = f"{ollama_url.rstrip('/')}/api/chat"
        payload = {"model": model, "messages": messages, "stream": False}
        resp = await async_client.post(url, json=payload, timeout=httpx.Timeout(300.0))
        resp.raise_for_status()
        return resp.json()

    async def proxy_chat_stream(
        self,
        ollama_url: str,
        model: str,
        messages: list[dict],
        async_client: httpx.AsyncClient,
    ):
        """
        Envía la petición de chat y produce un generador SSE.
        Envía keep-alive comments cada segundo mientras el modelo procesa,
        evitando que Cloudflare u otros proxies corten la conexión por inactividad.
        """
        import asyncio

        url = f"{ollama_url.rstrip('/')}/api/chat"
        payload = {"model": model, "messages": messages, "stream": True}
        chat_id = f"chatcmpl-{uuid.uuid4()}"

        # Cliente propio para no interferir con el cliente compartido del gateway
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as client:
            async with client.stream("POST", url, json=payload) as response:
                response.raise_for_status()

                last_keepalive = time.time()

                async for chunk in response.aiter_lines():
                    # Keep-alive: si el modelo tarda > 5s en producir un chunk,
                    # enviamos un comentario SSE para que Cloudflare no corte la línea
                    now = time.time()
                    if now - last_keepalive >= 5:
                        yield ": keep-alive\n\n"
                        last_keepalive = now

                    if not chunk:
                        continue

                    try:
                        data = json.loads(chunk)
                        content = data.get("message", {}).get("content", "")
                        done = data.get("done", False)

                        openai_chunk = {
                            "id": chat_id,
                            "object": "chat.completion.chunk",
                            "created": int(time.time()),
                            "model": model,
                            "choices": [
                                {
                                    "index": 0,
                                    "delta": {"content": content} if not done else {},
                                    "finish_reason": "stop" if done else None,
                                }
                            ],
                        }
                        last_keepalive = time.time()
                        yield f"data: {json.dumps(openai_chunk)}\n\n"
                    except Exception as e:
                        logger.error(f"Error procesando chunk de Ollama: {e}")

            yield "data: [DONE]\n\n"

    # ──────────────────────────────────────────
    # Información para endpoints de API
    # ──────────────────────────────────────────

    def estado_nodos(self) -> list[dict]:
        """Devuelve el estado completo de todos los nodos (para /api/nodes)."""
        now = time.time()
        with self._lock:
            resultado = []
            for nid, est in self._estado.items():
                next_retry = est.get("next_retry", 0.0)
                resultado.append({
                    "id": nid,
                    "name": est["config"].get("name", nid),
                    "agent_url": est["config"].get("agent_url"),
                    "ollama_url": est["config"].get("ollama_url"),
                    "online": est["online"],
                    "score": est["score"],
                    "fallos": est["fallos"],
                    "modelos": est["modelos"],
                    "metricas": est["metricas"],
                    "ultimo_poll": est["ultimo_poll"],
                    "seconds_ago": round(now - est["ultimo_poll"], 1) if est["ultimo_poll"] else None,
                    "circuit_breaker": next_retry > now,
                    "retry_in_seconds": max(0, round(next_retry - now)) if next_retry > now else 0,
                })
            return resultado
