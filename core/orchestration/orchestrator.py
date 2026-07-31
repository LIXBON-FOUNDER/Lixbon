"""
orchestrator.py — Orquestador de nodos GPU de lixbon.
Gestiona el estado de los nodos registrados en BD, elige el mejor según
recursos disponibles y expone el destino Ollama (proxy del node_agent).

Cambios F2:
- Nodos desde la tabla `nodes` (adiós nodes.json)
- Toda comunicación gateway→nodo autenticada con X-Node-Token
- Sin fallback de métricas falsas: agente caído ⇒ nodo offline
  (antes un agente caído recibía score PERFECTO — bug de inversión de lógica)
- ollama_target(): resuelve a qué URL/headers mandar cada petición de inferencia
"""

import logging
import threading
import time

import httpx

from core.config import OLLAMA_BASE_URL

logger = logging.getLogger("lixbon.orchestrator")

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


class ModelUnavailable(RuntimeError):
    """El modelo pedido no está en ningún nodo online.

    La levanta ollama_target(strict=True) para que el gateway pueda devolver un
    error claro en vez de enrutar la petición a un Ollama que no lo tiene.
    """

    def __init__(self, model: str, nodes_online: list[str]):
        super().__init__(f"El modelo '{model}' no está en ningún nodo online ({', '.join(nodes_online)})")
        self.model = model
        self.nodes_online = nodes_online


def _normalizar_modelo(nombre: str | None) -> str:
    """`nomic-embed-text` ≡ `nomic-embed-text:latest` (lo que devuelve /api/tags)."""
    n = (nombre or "").strip()
    return n[: -len(":latest")] if n.endswith(":latest") else n


def _calcular_score(metricas: dict) -> float:
    """Score 0-100. Mayor = más recursos libres. Sin GPU usa 50.0 neutral."""
    cpu_libre = 100.0 - float(metricas.get("cpu_percent", 100))
    ram_libre = 100.0 - float(metricas.get("ram_percent", 100))
    gpu_libre = float(metricas.get("gpu_free_percent", 50.0))
    return round(cpu_libre * PESO_CPU + ram_libre * PESO_RAM + gpu_libre * PESO_GPU, 2)


class NodeOrchestrator:
    """Hace polling de métricas de los nodos en background y selecciona el mejor."""

    def __init__(self):
        self._nodos: list[dict] = []          # Config desde la tabla nodes
        self._estado: dict[str, dict] = {}    # Estado dinámico por node id
        self._lock = threading.Lock()
        self._rr_index: int = 0
        self._hilo_poll: threading.Thread | None = None
        self._activo = False
        self._cliente = httpx.Client(timeout=8.0)

    # ──────────────────────────────────────────
    # Carga de nodos (desde BD)
    # ──────────────────────────────────────────

    def cargar_nodos(self) -> None:
        """Carga los nodos habilitados desde la tabla `nodes`."""
        from core.persistence.queries import list_nodes  # import tardío: evita ciclo en arranque
        try:
            nodos = list_nodes(enabled_only=True, mask_token=False)
        except Exception as exc:
            logger.error(f"No se pudieron cargar nodos de la BD: {exc}")
            return

        with self._lock:
            self._nodos = nodos
            vigentes = {n["id"] for n in nodos}
            # Descartar estado de nodos eliminados/deshabilitados
            for nid in list(self._estado):
                if nid not in vigentes:
                    del self._estado[nid]
            for nodo in nodos:
                nid = nodo["id"]
                if nid not in self._estado:
                    self._estado[nid] = {
                        "online": False,
                        "fallos": 0,
                        "next_retry": 0.0,
                        "metricas": {},
                        "modelos": [],
                        "capabilities": {},     # modelo → [capabilities] (node_agent ≥ 3.1)
                        "tamanos": {},          # modelo → bytes
                        "agent_version": None,
                        "score": 0.0,
                        "ultimo_poll": None,
                        "config": nodo,
                    }
                else:
                    self._estado[nid]["config"] = nodo

        logger.info(f"Nodos cargados desde BD: {[n['id'] for n in nodos]}")

    def iniciar(self) -> None:
        """Arranca el hilo de polling. Hace un primer poll inmediato."""
        self.cargar_nodos()
        self._activo = True

        for nodo in list(self._nodos):
            try:
                self._poll_nodo(nodo)
            except Exception:
                pass

        self._hilo_poll = threading.Thread(
            target=self._loop_polling, daemon=True, name="orchestrator-poll",
        )
        self._hilo_poll.start()
        if not self._nodos:
            logger.warning("Sin nodos registrados. Se usará Ollama local como fallback.")
        logger.info(f"Orquestador iniciado. Polling cada {POLL_INTERVAL}s.")

    def detener(self) -> None:
        self._activo = False
        self._cliente.close()

    # ──────────────────────────────────────────
    # Polling de métricas
    # ──────────────────────────────────────────

    def _headers_nodo(self, nodo: dict) -> dict:
        return {"X-Node-Token": nodo.get("token") or ""}

    def _loop_polling(self) -> None:
        while self._activo:
            for nodo in list(self._nodos):
                try:
                    self._poll_nodo(nodo)
                except Exception as exc:
                    logger.error(f"Error inesperado en poll de {nodo.get('id')}: {exc}")
            time.sleep(POLL_INTERVAL)

    def _poll_nodo(self, nodo: dict) -> None:
        """Consulta /metrics del node_agent. Sin métricas reales ⇒ nodo offline (sin datos inventados)."""
        nid = nodo["id"]
        now = time.time()

        with self._lock:
            if nid not in self._estado:
                return
            next_retry = self._estado[nid].get("next_retry", 0.0)
        if now < next_retry:
            return

        url = f"{nodo['agent_url'].rstrip('/')}/metrics"

        try:
            resp = self._cliente.get(url, headers=self._headers_nodo(nodo))
            resp.raise_for_status()
            metricas = resp.json()
            modelos = metricas.pop("models", [])
            # model_info solo lo manda el node_agent ≥ 3.1. Sin él, capabilities
            # queda vacío = "desconocidas", que NO es lo mismo que "ninguna":
            # los roles no descartan modelos por falta de datos.
            model_info = metricas.pop("model_info", None) or []
            agent_version = metricas.pop("agent_version", None)
            capabilities = {
                m["name"]: list(m["capabilities"])
                for m in model_info
                if m.get("name") and m.get("capabilities")
            }
            tamanos = {m["name"]: m.get("size", 0) for m in model_info if m.get("name")}
            score = _calcular_score(metricas)

            with self._lock:
                if nid not in self._estado:
                    return
                self._estado[nid].update({
                    "online": True,
                    "fallos": 0,
                    "next_retry": 0.0,
                    "metricas": metricas,
                    "modelos": modelos,
                    "capabilities": capabilities,
                    "tamanos": tamanos,
                    "agent_version": agent_version,
                    "score": score,
                    "ultimo_poll": time.time(),
                })
            logger.debug(f"[{nid}] score={score} modelos={len(modelos)}")

        except Exception as exc:
            with self._lock:
                if nid not in self._estado:
                    return
                estado = self._estado[nid]
                estado["fallos"] += 1
                fallos = estado["fallos"]

                wait_seconds = 0
                for threshold, wait in sorted(CIRCUIT_BACKOFF.items(), reverse=True):
                    if fallos >= threshold:
                        wait_seconds = wait
                        break

                if fallos >= MAX_FALLOS:
                    estado["online"] = False
                    estado["score"] = 0.0
                    if wait_seconds:
                        estado["next_retry"] = time.time() + wait_seconds
                        logger.warning(f"[{nid}] Offline ({exc}). Reintento en {wait_seconds}s.")
                    else:
                        logger.warning(f"[{nid}] Offline ({exc})")

    # ──────────────────────────────────────────
    # Selección del mejor nodo
    # ──────────────────────────────────────────

    def best_node(self) -> dict | None:
        """Config del nodo online con mayor score; round-robin entre empatados."""
        with self._lock:
            candidatos = [est for est in self._estado.values() if est["online"]]
            if not candidatos:
                return None
            max_score = max(e["score"] for e in candidatos)
            empatados = [e for e in candidatos if e["score"] == max_score]
            ganador = empatados[self._rr_index % len(empatados)]
            self._rr_index = (self._rr_index + 1) % max(len(empatados), 1)
            return ganador["config"]

    def best_node_for_model(self, model: str, strict: bool = True) -> dict | None:
        """Nodo online con mayor score que tenga el modelo.

        `strict=True` (default) devuelve None si ningún nodo online lo tiene, en
        vez de enrutar a ciegas al mejor nodo: antes la petición llegaba a un
        Ollama sin ese modelo y el usuario veía el error crudo de Ollama en
        lugar de un "modelo no disponible" del gateway.
        La comparación normaliza `:latest` (`nomic-embed-text` ≡ `nomic-embed-text:latest`).
        """
        objetivo = _normalizar_modelo(model)
        with self._lock:
            online = [est for est in self._estado.values() if est["online"]]
            if not online:
                return None
            con_modelo = [
                est for est in online
                if any(_normalizar_modelo(m) == objetivo for m in est["modelos"])
            ]
            if not con_modelo:
                if strict:
                    return None
                con_modelo = online
            return max(con_modelo, key=lambda e: e["score"])["config"]

    def nodos_online(self) -> list[str]:
        with self._lock:
            return [est["config"]["id"] for est in self._estado.values() if est["online"]]

    def ollama_target(self, model: str | None = None, strict: bool = False) -> tuple[str, dict, str]:
        """
        Resuelve el destino de inferencia: (base_url_ollama, headers, origen).
        - Con nodo online: el proxy del node_agent ({agent_url}/ollama) autenticado.
        - Sin nodos: el Ollama local del gateway (OLLAMA_BASE_URL) — solo útil en desarrollo.

        Con `strict=True`, si hay nodos online pero ninguno tiene el modelo se
        levanta ModelUnavailable en vez de mandar la petición a un nodo que no
        lo tiene. El caso "sin nodos online" sigue cayendo al Ollama local: es
        el camino legítimo de desarrollo.
        """
        if model:
            nodo = self.best_node_for_model(model, strict=strict)
            if nodo is None and strict:
                online = self.nodos_online()
                if online:
                    raise ModelUnavailable(model, online)
        else:
            nodo = self.best_node()
        if nodo:
            base = f"{nodo['agent_url'].rstrip('/')}/ollama"
            return base, self._headers_nodo(nodo), nodo["id"]
        return OLLAMA_BASE_URL, {}, "local"

    def todos_los_modelos(self) -> list[dict]:
        """Agrega los modelos de todos los nodos online (agrupando duplicados).

        `capabilities` es la unión de las conocidas; la clave se OMITE si ningún
        nodo la conoce, para que el consumidor distinga "desconocido" de "vacío".
        """
        vistos: dict[str, dict] = {}
        with self._lock:
            for est in self._estado.values():
                if not est["online"]:
                    continue
                nid = est["config"]["id"]
                caps_nodo = est.get("capabilities") or {}
                tam_nodo = est.get("tamanos") or {}
                for nombre in est["modelos"]:
                    entrada = vistos.get(nombre)
                    if entrada is None:
                        entrada = {
                            "id": nombre, "object": "model",
                            "owned_by": "ollama", "nodos": [nid],
                        }
                        vistos[nombre] = entrada
                    else:
                        entrada["nodos"].append(nid)
                    caps = caps_nodo.get(nombre)
                    if caps:
                        entrada["capabilities"] = sorted(
                            set(entrada.get("capabilities") or []) | set(caps)
                        )
                    if tam_nodo.get(nombre):
                        entrada["size"] = max(entrada.get("size", 0), tam_nodo[nombre])
        return list(vistos.values())

    def reintentar_nodo(self, nid: str) -> bool:
        """
        Fuerza un reintento inmediato de un nodo: limpia el circuit breaker
        (next_retry=0, fallos=0) y lo vuelve a pollear al instante, sin esperar
        el backoff. Devuelve True si el nodo quedó online.
        """
        with self._lock:
            estado = self._estado.get(nid)
            if estado is None:
                return False
            estado["fallos"] = 0
            estado["next_retry"] = 0.0
            nodo = estado["config"]

        try:
            self._poll_nodo(nodo)
        except Exception as exc:
            logger.error(f"Error en reintento manual de {nid}: {exc}")

        with self._lock:
            estado = self._estado.get(nid)
            return bool(estado and estado["online"])

    # ──────────────────────────────────────────
    # Información para endpoints de API
    # ──────────────────────────────────────────

    def estado_nodos(self) -> list[dict]:
        """Estado completo de todos los nodos (para /api/nodes). Nunca expone el token."""
        now = time.time()
        with self._lock:
            resultado = []
            for nid, est in self._estado.items():
                next_retry = est.get("next_retry", 0.0)
                resultado.append({
                    "id": nid,
                    "name": est["config"].get("name", nid),
                    "agent_url": est["config"].get("agent_url"),
                    "online": est["online"],
                    "score": est["score"],
                    "fallos": est["fallos"],
                    "modelos": est["modelos"],
                    # None = node_agent < 3.1: no manda capabilities y los roles
                    # de inferencia no se pueden autodetectar contra ese nodo.
                    "agent_version": est.get("agent_version"),
                    "capabilities": est.get("capabilities") or {},
                    "metricas": est["metricas"],
                    "ultimo_poll": est["ultimo_poll"],
                    "seconds_ago": round(now - est["ultimo_poll"], 1) if est["ultimo_poll"] else None,
                    "circuit_breaker": next_retry > now,
                    "retry_in_seconds": max(0, round(next_retry - now)) if next_retry > now else 0,
                })
            return resultado
