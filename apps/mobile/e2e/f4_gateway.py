"""Local-only F4 E2E gateway: real relay + production JS host + fixture Core.

Run from the repository root: python apps/mobile/e2e/f4_gateway.py
Never points to a real account/database/provider. Binds only to loopback.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from fastapi import FastAPI
import uvicorn
import websockets
from core.gateway import remote_hub
from core.gateway.routers import remote

USER = {"id": 7, "email": "ana@lixbon.com", "first_name": "Ana", "last_name": "Prueba", "plan": "pro"}
SESSION = {"id": "f4-e2e", "user_id": 7, "status": "online", "title": "Mobile F4", "source": "ide", "machine": "E2E Android", "host_connected": True}
CAPS = ["core_snapshot", "core_events", "core_task", "core_activity", "core_attention", "core_attempts", "core_attempt", "core_attempt_capabilities", "core_attempt_context", "core_usage"]
CORE_FIXTURE = Path(__file__).with_name("f4_core.mjs")
state = {"scenario": "ready", "requests": [], "queries": [], "failures": []}
remote.hub = remote_hub.RemoteHub()
remote._owner_required = lambda *a, **k: dict(SESSION)
remote.session_or_api_key = lambda *a, **k: USER
for name in ("touch_remote_session", "save_remote_events", "update_remote_session_meta", "end_remote_session", "push_task"):
    setattr(remote, name, lambda *a, **k: None)
remote.list_remote_events = lambda *a, **k: []


async def host():
    proc = await asyncio.create_subprocess_exec("node", str(CORE_FIXTURE), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
    try:
        for _ in range(100):
            try:
                ws = await websockets.connect("ws://127.0.0.1:8765/api/remote/sessions/f4-e2e/host")
                break
            except OSError:
                await asyncio.sleep(0.1)
        else:
            raise RuntimeError("Gateway did not start")
        import json
        async with ws:
            await ws.send(json.dumps({"op": "auth", "token": "fixture"}))
            await ws.send(json.dumps({"op": "events", "events": [{"type": "hello", "source": "ide", "machine": "E2E Android", "capabilities": CAPS}]}))
            async for raw in ws:
                frame = json.loads(raw)
                if frame.get("type") == "ping":
                    await ws.send(json.dumps({"op": "ping"}))
                    continue
                if frame.get("type") != "orch":
                    continue
                state["requests"].append({"action": frame["action"], "scenario": state["scenario"], "operation": frame.get("args", {}).get("operation", {}).get("kind"), "mutation": any(k in frame.get("args", {}) for k in ("operation", "reply", "decision", "open_desktop"))})
                proc.stdin.write((json.dumps({**frame, "scenario": state["scenario"], "epoch": state.get("epoch", 0)}) + "\n").encode())
                await proc.stdin.drain()
                response = json.loads(await proc.stdout.readline())
                if "error" in response:
                    state["failures"].append(response["error"])
                    continue
                state["queries"].extend(response["queries"])
                if response.get("effect"):
                    state.setdefault("effects", []).append(response["effect"])
                if response.get("drop"):
                    continue  # fixture: commit succeeded but its private response was lost
                encoded = json.dumps(response["event"])
                if "PRIVATE_SENTINEL" in encoded or "Normalizar el uso de cada proveedor sin fingir" in encoded:
                    state["failures"].append("Private Core contents escaped the host allowlist")
                await ws.send(json.dumps({"op": "events", "events": [response["event"]]}))
    finally:
        proc.terminate()
        await proc.wait()


@asynccontextmanager
async def lifespan(app):
    app.state.host_task = asyncio.create_task(host())
    yield
    app.state.host_task.cancel()
    try:
        await app.state.host_task
    except asyncio.CancelledError:
        pass


app = FastAPI(lifespan=lifespan)


@app.post("/api/auth/login")
@app.post("/api/auth/refresh")
async def login():
    return {"access_token": "lixbon_at_e2e", "refresh_token": "lixbon_rt_e2e", "token_type": "Bearer", "expires_in": 1800, "session_id": 1, "user": USER}


@app.get("/api/auth/me")
async def me(): return {"user": USER}


@app.get("/api/models")
@app.get("/v1/models")
async def models(): return {"data": [{"id": "qwen3:8b"}]}


@app.get("/api/conversations")
async def conversations(): return []


@app.get("/api/remote/sessions")
async def sessions(): return {"sessions": [SESSION]}


@app.get("/api/settings")
async def settings(): return {"save_history": True, "anonymous_usage": False}


@app.get("/__e2e/state")
async def get_state(): return state


@app.post("/__e2e/scenario/{scenario}")
async def scenario(scenario: str):
    assert scenario in {"ready", "blocked", "corrupt", "absent", "partial", "rate_limited"}
    state["scenario"] = scenario
    return {"ok": True}


@app.post("/__e2e/host/{online}")
async def host_connection(online: bool):
    if online:
        app.state.host_task = asyncio.create_task(host())
    else:
        app.state.host_task.cancel()
        try:
            await app.state.host_task
        except asyncio.CancelledError:
            pass
        await asyncio.sleep(0.2)
        channel = remote.hub.get(SESSION["id"])
        channel.host_left_at = time.time() - remote_hub.HOST_GRACE_SECONDS - 1
        remote.hub.announce_host(channel)
    return {"ok": True}


app.include_router(remote.router)

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8765)
