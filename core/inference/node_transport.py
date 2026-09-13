"""
node_transport.py — Transporte httpx para URLs `node://<node_id>/api/...`.

Permite que core/inference/ollama.py hable con un nodo conectado por WebSocket
exactamente igual que con un Ollama por HTTP: el orquestador devuelve
`node://gpu-a1b2` como base_url y este transporte reenvía la petición por el
socket del nodo. Los clientes se crean con `new_client()` para llevar el mount.
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator

import httpx

from core.orchestration.node_link import (
    LOAD_TIMEOUT,
    RUTAS_CON_CARGA,
    NodeLinkError,
    NodeUnavailable,
    RespuestaNodo,
    registro,
)


class _StreamNodo(httpx.AsyncByteStream):
    def __init__(self, resp: RespuestaNodo, read_timeout: float | None):
        self._resp = resp
        self._read_timeout = read_timeout

    async def __aiter__(self) -> AsyncIterator[bytes]:
        try:
            async for chunk in self._resp.chunks(self._read_timeout):
                yield chunk
        except NodeUnavailable as exc:
            raise httpx.RemoteProtocolError(str(exc)) from exc
        except NodeLinkError as exc:
            raise httpx.ReadError(str(exc)) from exc

    async def aclose(self) -> None:
        await self._resp.aclose()


class NodeTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        node_id = request.url.host
        link = registro.get(node_id)
        if link is None:
            raise httpx.ConnectError(f"Nodo '{node_id}' no está conectado", request=request)

        body = await request.aread()
        payload = json.loads(body) if body else None
        timeouts = request.extensions.get("timeout") or {}
        path = request.url.raw_path.decode()
        con_carga = path.split("?", 1)[0] in RUTAS_CON_CARGA
        try:
            resp = await link.request(
                request.method,
                path,
                payload,
                connect_timeout=LOAD_TIMEOUT if con_carga else timeouts.get("connect"),
            )
        except NodeUnavailable as exc:
            raise httpx.ConnectError(str(exc), request=request) from exc
        except NodeLinkError as exc:
            raise httpx.ReadError(str(exc), request=request) from exc

        return httpx.Response(
            resp.status,
            headers=resp.headers,
            stream=_StreamNodo(resp, timeouts.get("read")),
            request=request,
        )


NODE_MOUNTS = {"node://": NodeTransport()}


def new_client(**kwargs) -> httpx.AsyncClient:
    return httpx.AsyncClient(mounts=NODE_MOUNTS, **kwargs)
