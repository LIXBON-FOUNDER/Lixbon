"""Bootstrap observacional de Mobile por /remote (LXO-107): el relay deja pasar
las dos lecturas del Core y no guarda ni repite sus respuestas."""
import asyncio

import pytest
from fastapi import HTTPException

from core.gateway.remote_hub import RemoteHub
from core.gateway.routers import remote as remote_router
from core.persistence.queries import REMOTE_PERSISTED_EVENTS


def test_respuestas_del_core_se_reparten_pero_no_entran_en_el_replay_ni_en_la_bd():
    async def scenario():
        hub = RemoteHub()
        ch = hub.channel("s1", 1)
        _, q = hub.attach_controller(ch)
        hub.publish_events(ch, [
            {"type": "user_msg", "text": "hola"},
            {"type": "orch_core_snapshot", "rid": "m1", "ok": True, "snapshot": {"snapshot_version": 1}},
            {"type": "orch_core_events", "rid": "m2", "ok": True, "events": [], "next_cursor": 0},
        ])
        assert [q.get_nowait()["type"] for _ in range(3)] == ["user_msg", "orch_core_snapshot", "orch_core_events"]
        assert [ev["type"] for ev in hub.replay(ch, 0)] == ["user_msg"]
        assert ch.orch is None, "no sustituyen al estado `orch` del host"

    asyncio.run(scenario())
    for kind in ("orch_core_snapshot", "orch_core_events"):
        assert kind not in REMOTE_PERSISTED_EVENTS, f"{kind} no se guarda en la BD"


@pytest.fixture
def host_online(monkeypatch):
    hub = RemoteHub()
    monkeypatch.setattr(remote_router, "hub", hub)
    ch = hub.channel("s1", 1)
    monkeypatch.setattr(hub, "host_online", lambda _ch: True)
    return hub, ch


@pytest.mark.parametrize("action,args", [
    ("core_snapshot", {"rid": "m1", "attention_items": 5}),
    ("core_events", {"rid": "m2", "cursor": 42, "limit": 100}),
])
def test_el_controller_puede_pedir_las_lecturas_del_core(host_online, action, args):
    hub, ch = host_online
    remote_router._queue_command(ch, {"type": "orch", "action": action, "args": args}, rid="r1")
    command = ch.host_queue.get_nowait()
    assert command["type"] == "orch"
    assert command["action"] == action
    assert command["args"] == args


def test_una_accion_desconocida_sigue_rechazada(host_online):
    _, ch = host_online
    with pytest.raises(HTTPException) as err:
        remote_router._queue_command(ch, {"type": "orch", "action": "core_write", "args": {}}, rid="r2")
    assert err.value.status_code == 422
