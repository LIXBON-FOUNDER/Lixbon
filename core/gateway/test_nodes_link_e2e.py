"""
E2E del nodo por conexión inversa con red real: uvicorn sirve el router
nodes_link y un Ollama falso; el node_agent REAL se enrola, abre el WebSocket
y atiende inferencia enrutada por `node://` desde core/inference/ollama.py.
Sin BD: las queries se sustituyen por dobles en memoria.
"""
import asyncio
import json
import socket
import threading
import time

import httpx
import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from core.gateway import deps
from core.gateway.routers import nodes_link
from core.inference import ollama
from core.node_agent import agent
from core.orchestration.node_link import registro
from core.orchestration.orchestrator import NodeOrchestrator

ENROLL = "enroll-token-de-prueba"
NODOS: dict[str, dict] = {}
ULTIMO: dict = {}   # collector del último /test/chat, rellenado en su finally


def _get_node(node_id, mask_token=True):
    return NODOS.get(node_id)


def _upsert_node(node_id, name, agent_url, token, enabled=True, provider=None, hostname=None):
    NODOS[node_id] = {
        "id": node_id, "name": name, "agent_url": agent_url, "token": token,
        "enabled": enabled, "provider": provider, "hostname": hostname, "mode": "link",
    }
    return NODOS[node_id]


def _consume_enrollment(token):
    return {"id": "enr_test"} if token == ENROLL else None


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(nodes_link.router)

    @app.get("/fake-ollama/api/tags")
    async def tags():
        return {"models": [{"name": "fake:1b", "digest": "d1", "size": 10}]}

    @app.post("/fake-ollama/api/show")
    async def show():
        return {"capabilities": ["completion", "tools"]}

    @app.post("/fake-ollama/api/chat")
    async def chat(request: Request):
        payload = await request.json()
        # "lento" en el prompt: muchos trozos espaciados, para poder cortar a mitad
        lento = payload["messages"][-1]["content"] == "lento"
        palabras = [f"p{i} " for i in range(200)] if lento else ["hola", " mundo"]

        async def gen():
            for palabra in palabras:
                yield json.dumps({"model": payload["model"], "message": {"role": "assistant", "content": palabra}, "done": False}) + "\n"
                await asyncio.sleep(0.05 if lento else 0.01)
            yield json.dumps({"model": payload["model"], "message": {"role": "assistant", "content": ""}, "done": True,
                              "prompt_eval_count": 3, "eval_count": 2}) + "\n"
        return StreamingResponse(gen(), media_type="application/x-ndjson")

    @app.get("/test/chat/{node_id}")
    async def test_chat(node_id: str, prompt: str = "hi"):
        collector: dict = {}

        async def sse():
            try:
                async for chunk in ollama.stream_chat_openai(f"node://{node_id}", "fake:1b", [{"role": "user", "content": prompt}], collector=collector):
                    yield chunk
                yield "data: " + json.dumps({"collector": collector}) + "\n\n"
            finally:
                ULTIMO.clear()
                ULTIMO.update(collector)
        return StreamingResponse(sse(), media_type="text/event-stream")

    @app.get("/test/ultimo")
    async def test_ultimo():
        link = registro.get(next(iter(NODOS), ""))
        return {"collector": ULTIMO, "pendientes": link.peticiones_en_curso if link else None}

    @app.get("/test/models/{node_id}")
    async def test_models(node_id: str):
        return {"models": await ollama.list_models(f"node://{node_id}")}

    @app.get("/test/estado")
    async def test_estado():
        return {"nodos": deps.orquestador.estado_nodos(), "conectados": registro.conectados()}

    return app


def _puerto_libre() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def servidor(monkeypatch, tmp_path):
    NODOS.clear()
    orq = NodeOrchestrator()
    monkeypatch.setattr(orq, "cargar_nodos", lambda: [
        orq._estado.setdefault(nid, {
            "online": False, "fallos": 0, "next_retry": 0.0, "metricas": {}, "modelos": [],
            "capabilities": {}, "tamanos": {}, "agent_version": None, "hostname": None,
            "score": 0.0, "ultimo_poll": None, "config": cfg,
        }) for nid, cfg in NODOS.items()
    ])
    monkeypatch.setattr(deps, "orquestador", orq)
    monkeypatch.setattr(nodes_link, "get_node", _get_node)
    monkeypatch.setattr(nodes_link, "upsert_node", _upsert_node)
    monkeypatch.setattr(nodes_link, "consume_enrollment", _consume_enrollment)
    monkeypatch.setattr(nodes_link, "touch_node", lambda *a, **k: None)
    monkeypatch.setattr(nodes_link, "log_audit_event", lambda *a, **k: None)

    puerto = _puerto_libre()
    base = f"http://127.0.0.1:{puerto}"
    monkeypatch.setattr(agent, "OLLAMA_URL", f"{base}/fake-ollama")
    monkeypatch.setattr(agent, "STATE_FILE", tmp_path / "node.json")
    monkeypatch.setenv("LIXBON_NODE_NAME", "Pod de prueba")
    monkeypatch.setenv("LIXBON_PROVIDER", "test")

    config = uvicorn.Config(_app(), host="127.0.0.1", port=puerto, log_level="warning")
    server = uvicorn.Server(config)
    hilo = threading.Thread(target=server.run, daemon=True)
    hilo.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    assert server.started
    yield base
    server.should_exit = True
    hilo.join(timeout=5)


def test_enrolar_conectar_e_inferir(servidor):
    base = servidor

    async def scenario():
        identidad = await agent._enrolar(base, ENROLL)
        nid = identidad["node_id"]
        assert nid.startswith("gpu-") and NODOS[nid]["name"] == "Pod de prueba"
        assert json.loads(agent.STATE_FILE.read_text())["secret"] == identidad["secret"]

        ws_url = f"ws://127.0.0.1:{base.rsplit(':', 1)[1]}/api/nodes/ws"
        sesion = asyncio.create_task(agent._sesion(ws_url, identidad))
        try:
            async with httpx.AsyncClient(base_url=base, timeout=10.0) as c:
                for _ in range(50):
                    estado = (await c.get("/test/estado")).json()
                    nodo = next((n for n in estado["nodos"] if n["id"] == nid), None)
                    if nodo and nodo["online"] and nodo["modelos"]:
                        break
                    await asyncio.sleep(0.1)
                assert nodo["online"] and nodo["mode"] == "link"
                assert nodo["modelos"] == ["fake:1b"]
                assert nodo["capabilities"] == {"fake:1b": ["completion", "tools"]}
                assert nodo["agent_version"] == agent.AGENT_VERSION
                assert estado["conectados"] == [nid]

                r = await c.get(f"/test/models/{nid}")
                assert [m["name"] for m in r.json()["models"]] == ["fake:1b"]

                async with c.stream("GET", f"/test/chat/{nid}") as r:
                    cuerpo = "".join([t async for t in r.aiter_text()])
                eventos = [json.loads(l[6:]) for l in cuerpo.splitlines() if l.startswith("data: ") and l != "data: [DONE]"]
                texto = "".join(e["choices"][0]["delta"].get("content", "") for e in eventos if "choices" in e)
                assert texto == "hola mundo"
                assert eventos[-1]["collector"]["content"] == "hola mundo"
                assert "data: [DONE]" in cuerpo

                # Detener a mitad: el cliente cierra el stream. El gateway debe
                # quedarse con el texto parcial y el nodo recibir el cancel.
                ULTIMO.clear()
                recibidos = 0
                async with c.stream("GET", f"/test/chat/{nid}", params={"prompt": "lento"}) as r:
                    async for linea in r.aiter_lines():
                        if linea.startswith("data: "):
                            recibidos += 1
                            if recibidos >= 5:
                                break
                for _ in range(50):
                    u = (await c.get("/test/ultimo")).json()
                    if u["collector"].get("content") and u["pendientes"] == 0:
                        break
                    await asyncio.sleep(0.1)
                assert u["pendientes"] == 0, "el nodo no canceló la petición"
                parcial = u["collector"]["content"]
                assert parcial.startswith("p0 p1 ") and len(parcial) < len("".join(f"p{i} " for i in range(200)))

            sesion.cancel()
            with pytest.raises(asyncio.CancelledError):
                await sesion
            for _ in range(50):
                if not deps.orquestador.nodos_online():
                    break
                await asyncio.sleep(0.1)
            assert deps.orquestador.nodos_online() == []
            assert registro.conectados() == []
        finally:
            if not sesion.done():
                sesion.cancel()

    asyncio.run(scenario())


def test_hello_con_secreto_malo_se_rechaza(servidor):
    base = servidor

    async def scenario():
        identidad = await agent._enrolar(base, ENROLL)
        ws_url = f"ws://127.0.0.1:{base.rsplit(':', 1)[1]}/api/nodes/ws"
        codigo = await agent._sesion(ws_url, {**identidad, "secret": "otro"})
        assert codigo == "unauthorized"
        assert deps.orquestador.nodos_online() == []

    asyncio.run(scenario())


def test_enroll_token_invalido(servidor):
    async def scenario():
        with pytest.raises(SystemExit, match="401"):
            await agent._enrolar(servidor, "nope-nope")

    asyncio.run(scenario())
