"""Tests del enlace de nodos por WebSocket y del transporte node://. Sin red ni BD:
el socket es un doble que simula al node_agent contestando frames."""
import asyncio
import json

import httpx
import pytest

from core.inference.node_transport import new_client
from core.orchestration.node_link import NodeLink, NodeLinkError, NodeUnavailable, registro


def run(coro):
    return asyncio.run(coro)


class FakeWS:
    """Simula al node_agent: por cada `request` responde según `guion(rid, msg)`."""

    def __init__(self, guion):
        self.guion = guion
        self.enviados = []
        self.link = None

    async def send_text(self, texto):
        msg = json.loads(texto)
        self.enviados.append(msg)
        if msg["type"] == "request":
            for frame in self.guion(msg["id"], msg):
                self.link.entregar(frame)


def _link(guion, nid="gpu-t1"):
    ws = FakeWS(guion)
    link = NodeLink(nid, ws)
    ws.link = link
    return link, ws


def _guion_ndjson(lineas, status=200):
    def guion(rid, _msg):
        yield {"type": "response", "id": rid, "status": status, "headers": {"content-type": "application/x-ndjson"}}
        for l in lineas:
            yield {"type": "chunk", "id": rid, "data": l + "\n"}
        yield {"type": "end", "id": rid}
    return guion


def test_request_entrega_cabecera_y_trozos():
    async def scenario():
        link, _ = _link(_guion_ndjson(['{"a":1}', '{"b":2}']))
        resp = await link.request("POST", "/api/chat", {"x": 1})
        assert resp.status == 200
        trozos = [t async for t in resp.chunks()]
        assert b"".join(trozos) == b'{"a":1}\n{"b":2}\n'
        assert link.peticiones_en_curso == 0

    run(scenario())


def test_error_a_mitad_de_respuesta():
    def guion(rid, _msg):
        yield {"type": "response", "id": rid, "status": 200, "headers": {}}
        yield {"type": "chunk", "id": rid, "data": "parcial"}
        yield {"type": "error", "id": rid, "message": "ollama murió"}

    async def scenario():
        link, _ = _link(guion)
        resp = await link.request("POST", "/api/chat", {})
        with pytest.raises(NodeLinkError, match="ollama murió"):
            async for _ in resp.chunks():
                pass

    run(scenario())


def test_cerrar_falla_las_pendientes():
    def guion(rid, _msg):
        yield {"type": "response", "id": rid, "status": 200, "headers": {}}

    async def scenario():
        link, _ = _link(guion)
        resp = await link.request("POST", "/api/chat", {})
        link.cerrar()
        with pytest.raises(NodeUnavailable):
            async for _ in resp.chunks():
                pass
        with pytest.raises(NodeUnavailable):
            await link.request("GET", "/api/tags", None)

    run(scenario())


def test_cancelar_avisa_al_nodo():
    def guion(rid, _msg):
        yield {"type": "response", "id": rid, "status": 200, "headers": {}}

    async def scenario():
        link, ws = _link(guion)
        resp = await link.request("POST", "/api/chat", {})
        await resp.aclose()
        assert ws.enviados[-1]["type"] == "cancel"
        assert link.peticiones_en_curso == 0

    run(scenario())


def test_sin_respuesta_a_tiempo():
    async def scenario():
        link, _ = _link(lambda rid, msg: [])
        with pytest.raises(NodeUnavailable, match="no respondió"):
            await link.request("POST", "/api/chat", {}, connect_timeout=0.05)
        assert link.peticiones_en_curso == 0

    run(scenario())


def test_transporte_node_scheme_streaming():
    async def scenario():
        link, ws = _link(_guion_ndjson(['{"n":1}', '{"n":2}']), nid="gpu-tx")
        registro.registrar(link)
        try:
            async with new_client(timeout=5.0) as client:
                async with client.stream("POST", "node://gpu-tx/api/chat", json={"model": "m"}) as r:
                    assert r.status_code == 200
                    lineas = [l async for l in r.aiter_lines() if l]
            assert [json.loads(l)["n"] for l in lineas] == [1, 2]
            pedido = ws.enviados[0]
            assert (pedido["method"], pedido["path"], pedido["body"]) == ("POST", "/api/chat", {"model": "m"})
        finally:
            registro.quitar(link)

    run(scenario())


def test_transporte_nodo_no_conectado():
    async def scenario():
        async with new_client(timeout=5.0) as client:
            with pytest.raises(httpx.ConnectError, match="no está conectado"):
                await client.post("node://gpu-nadie/api/embed", json={})

    run(scenario())


def test_registro_reemplaza_conexion_del_mismo_nodo():
    l1, _ = _link(lambda r, m: [], nid="gpu-dup")
    l2, _ = _link(lambda r, m: [], nid="gpu-dup")
    assert registro.registrar(l1) is None
    assert registro.registrar(l2) is l1
    registro.quitar(l1)
    assert registro.get("gpu-dup") is l2
    registro.quitar(l2)
    assert registro.get("gpu-dup") is None
