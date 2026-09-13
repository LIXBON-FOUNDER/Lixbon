"""
node_link.py — Nodos que se conectan AL gateway (conexión inversa).

El node_agent abre un WebSocket saliente hacia /api/nodes/ws y por ese único
canal empuja métricas y atiende peticiones de inferencia. Así una GPU alquilada
(RunPod, Vast…) no necesita túnel, DNS ni puerto entrante: solo salida a internet.

Protocolo (frames JSON de texto):
  nodo → gateway:  hello · metrics · response · chunk · end · error
  gateway → nodo:  welcome · request · cancel
Varias peticiones comparten el socket; cada una viaja con su `id`.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections.abc import AsyncIterator
from typing import Any

from starlette.websockets import WebSocket

logger = logging.getLogger("lixbon.node_link")

CONNECT_TIMEOUT = 15.0
READ_TIMEOUT = 300.0
# Ollama no envía cabeceras hasta tener el modelo cargado: un modelo grande en
# frío (decenas de GB + KV de una ventana larga) tarda minutos en un nodo
# alquilado. Las rutas que generan esperan ese tiempo; el enlace WS ya detecta
# si el nodo se cae.
LOAD_TIMEOUT = 600.0
RUTAS_CON_CARGA = ("/api/chat", "/api/generate", "/api/embed", "/api/embeddings")


class NodeLinkError(RuntimeError):
    pass


class NodeUnavailable(NodeLinkError):
    pass


class RespuestaNodo:
    """Cabecera de respuesta + cola de trozos del cuerpo (texto, ya en orden)."""

    def __init__(self, status: int, headers: dict[str, str], cola: asyncio.Queue, link: "NodeLink", rid: str):
        self.status = status
        self.headers = headers
        self._cola = cola
        self._link = link
        self._rid = rid
        self.terminada = False

    async def chunks(self, read_timeout: float | None = None) -> AsyncIterator[bytes]:
        timeout = read_timeout or READ_TIMEOUT
        while True:
            try:
                kind, data = await asyncio.wait_for(self._cola.get(), timeout=timeout)
            except asyncio.TimeoutError:
                raise NodeLinkError(f"Nodo '{self._link.node_id}' sin datos durante {timeout:.0f}s")
            if kind == "chunk":
                yield data.encode("utf-8")
            elif kind == "end":
                self.terminada = True
                return
            elif kind == "error":
                self.terminada = True
                raise NodeLinkError(data)
            elif kind == "closed":
                self.terminada = True
                raise NodeUnavailable(f"Nodo '{self._link.node_id}' se desconectó a mitad de respuesta")

    async def aclose(self) -> None:
        if not self.terminada:
            self.terminada = True
            await self._link.cancelar(self._rid)


class NodeLink:
    """Una conexión viva con un node_agent."""

    def __init__(self, node_id: str, ws: WebSocket, info: dict[str, Any] | None = None):
        self.node_id = node_id
        self.ws = ws
        self.info = info or {}
        self._pendientes: dict[str, asyncio.Queue] = {}
        self._envio = asyncio.Lock()
        self.cerrado = False

    async def enviar(self, msg: dict[str, Any]) -> None:
        if self.cerrado:
            raise NodeUnavailable(f"Nodo '{self.node_id}' desconectado")
        async with self._envio:
            await self.ws.send_text(json.dumps(msg, ensure_ascii=False))

    async def request(
        self,
        method: str,
        path: str,
        body: Any,
        connect_timeout: float | None = None,
    ) -> RespuestaNodo:
        rid = uuid.uuid4().hex
        cola: asyncio.Queue = asyncio.Queue()
        self._pendientes[rid] = cola
        try:
            await self.enviar({"type": "request", "id": rid, "method": method, "path": path, "body": body})
            kind, data = await asyncio.wait_for(cola.get(), timeout=connect_timeout or CONNECT_TIMEOUT)
        except asyncio.TimeoutError:
            # El nodo puede seguir generando: cancelar libera la GPU
            await self.cancelar(rid)
            raise NodeUnavailable(f"Nodo '{self.node_id}' no respondió a tiempo")
        except Exception:
            self._pendientes.pop(rid, None)
            raise

        if kind == "response":
            return RespuestaNodo(int(data["status"]), dict(data.get("headers") or {}), cola, self, rid)
        self._pendientes.pop(rid, None)
        if kind == "closed":
            raise NodeUnavailable(f"Nodo '{self.node_id}' se desconectó")
        raise NodeLinkError(str(data))

    def entregar(self, msg: dict[str, Any]) -> None:
        """Encola un frame response/chunk/end/error en la petición a la que pertenece."""
        rid = msg.get("id")
        cola = self._pendientes.get(rid)
        if cola is None:
            return
        tipo = msg.get("type")
        if tipo == "response":
            cola.put_nowait(("response", msg))
        elif tipo == "chunk":
            cola.put_nowait(("chunk", msg.get("data", "")))
        elif tipo == "end":
            cola.put_nowait(("end", None))
            self._pendientes.pop(rid, None)
        elif tipo == "error":
            cola.put_nowait(("error", msg.get("message", "error en el nodo")))
            self._pendientes.pop(rid, None)

    async def cancelar(self, rid: str) -> None:
        if self._pendientes.pop(rid, None) is None:
            return
        try:
            await self.enviar({"type": "cancel", "id": rid})
        except Exception:
            pass

    def cerrar(self) -> None:
        self.cerrado = True
        for cola in self._pendientes.values():
            cola.put_nowait(("closed", None))
        self._pendientes.clear()

    @property
    def peticiones_en_curso(self) -> int:
        return len(self._pendientes)


class NodeRegistry:
    def __init__(self):
        self._links: dict[str, NodeLink] = {}

    def registrar(self, link: NodeLink) -> NodeLink | None:
        """Registra la conexión; devuelve la anterior del mismo nodo (para cerrarla)."""
        anterior = self._links.get(link.node_id)
        self._links[link.node_id] = link
        return anterior

    def quitar(self, link: NodeLink) -> None:
        if self._links.get(link.node_id) is link:
            del self._links[link.node_id]

    def get(self, node_id: str) -> NodeLink | None:
        return self._links.get(node_id)

    def conectados(self) -> list[str]:
        return list(self._links)


registro = NodeRegistry()
