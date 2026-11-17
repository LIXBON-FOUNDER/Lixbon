"""Relay /remote por WebSocket: móvil ↔ gateway ↔ host en una conexión por lado."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from core.gateway import remote_hub
from core.gateway.routers import remote

SESS = {"id": "s1", "user_id": 7, "status": "online", "title": "t", "agent": "claude", "source": "ide"}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(remote, "hub", remote_hub.RemoteHub())
    monkeypatch.setattr(remote, "_owner_required", lambda *a, **k: dict(SESS))
    for name in ("touch_remote_session", "save_remote_events", "update_remote_session_meta", "end_remote_session"):
        monkeypatch.setattr(remote, name, lambda *a, **k: None)
    monkeypatch.setattr(remote, "list_remote_events", lambda *a, **k: [])
    monkeypatch.setattr(remote, "push_task", lambda *a, **k: None)
    app = FastAPI()
    app.include_router(remote.router)
    with TestClient(app) as c:
        yield c


def until(ws, kind):
    while True:
        ev = ws.receive_json()
        if ev.get("type") == kind:
            return ev


def test_prompt_del_movil_llega_al_host_y_la_respuesta_vuelve(client):
    with client.websocket_connect("/api/remote/sessions/s1/host?last_cmd=0") as host:
        host.send_json({"op": "auth", "token": "lxb_test"})
        assert host.receive_json() == {"type": "channel", "cmd_seq": 0}
        with client.websocket_connect("/api/remote/sessions/s1/ws", headers={"Authorization": "Bearer lxb_test"}) as phone:
            status = until(phone, "channel_status")
            assert status["host_connected"] is True

            cmd = {"op": "cmd", "rid": "r1", "command": {"type": "prompt", "text": "hola"}}
            phone.send_json(cmd)
            assert until(phone, "ack") == {"type": "ack", "rid": "r1", "ok": True}
            # un reenvío con el mismo rid no se encola dos veces
            phone.send_json(cmd)
            assert until(phone, "ack")["ok"] is True

            got = until(host, "prompt")
            assert got["text"] == "hola" and got["cmd_seq"] == 2  # el 1 es el request_snapshot del móvil

            host.send_json({"op": "events", "rid": "e1", "events": [{"type": "user_msg", "text": "hola", "origin": "remote"}]})
            assert until(host, "ack")["seq"] == 1
            assert until(phone, "user_msg")["text"] == "hola"

            phone.send_json({"op": "ping"})
            assert until(phone, "pong") == {"type": "pong"}
            assert remote.hub.get("s1").cmd_seq == 2


def test_comando_invalido_devuelve_ack_con_error(client):
    with client.websocket_connect("/api/remote/sessions/s1/ws") as phone:
        phone.send_json({"op": "auth", "token": "lxb_test"})
        until(phone, "channel_status")
        phone.send_json({"op": "cmd", "rid": "r2", "command": {"type": "prompt", "text": "x"}})
        ack = until(phone, "ack")
        assert ack["ok"] is False and ack["status"] == 409


def test_pregunta_mobile_valida_credencial_y_entrega_solo_al_controller(client, monkeypatch):
    identities = {
        "Bearer lixbon_at_mobile": {"id": 7, "session_id": 42, "client": "mobile"},
        "Bearer lixbon_at_other": {"id": 8, "session_id": 43, "client": "mobile"},
        "Bearer lixbon_at_ide": {"id": 7, "session_id": 44, "client": "ide"},
    }
    monkeypatch.setattr(remote, "authenticate", lambda _cookie, token, _limit: identities[token])
    args = {"rid": "p1", "attention_id": "att_1", "attempt_id": "t1-a1"}
    command = {"type": "orch", "action": "mobile_question", "args": args, "mobile": {"user_id": 8, "session_id": 999}}
    with client.websocket_connect("/api/remote/sessions/s1/host", headers={"Authorization": "Bearer host"}) as host:
        until(host, "channel")
        with client.websocket_connect("/api/remote/sessions/s1/ws", headers={"Authorization": "Bearer reader"}) as other:
            until(other, "channel_status")
            with client.websocket_connect("/api/remote/sessions/s1/ws", headers={"Authorization": "Bearer reader"}) as phone:
                until(phone, "channel_status")
                for credential in ("api-key", "lixbon_at_other", "lixbon_at_ide"):
                    phone.send_json({"op": "cmd", "rid": "outer", "command": command, "credential": credential})
                    assert until(phone, "ack")["status"] == 403

                phone.send_json({"op": "cmd", "rid": "outer", "command": command, "credential": "lixbon_at_mobile"})
                assert until(phone, "ack")["ok"] is True
                forwarded = until(host, "orch")
                assert forwarded["mobile"] == {"user_id": 7, "session_id": 42}
                assert forwarded["args"]["rid"] != "p1"
                assert "credential" not in forwarded
                event = {"type": "orch_mobile_question", "rid": forwarded["args"]["rid"], "result": {"questions": ["privada"]}}
                host.send_json({"op": "events", "events": [event]})
                assert until(phone, "orch_mobile_question")["rid"] == "p1"
                other.send_json({"op": "ping"})
                assert other.receive_json()["type"] == "pong"
                channel = remote.hub.get("s1")
                assert remote.hub.replay(channel, 0) == []
                assert all(cmd["action"] != "mobile_question" for _, cmd in channel.recent_cmds if "action" in cmd)


def test_con_eventos_en_el_buffer_no_se_pide_un_snapshot_que_los_borre(client):
    with client.websocket_connect("/api/remote/sessions/s1/host?last_cmd=0") as host:
        host.send_json({"op": "auth", "token": "lxb_test"})
        until(host, "channel")
        host.send_json({"op": "events", "rid": "e1", "events": [{"type": "tool_use", "id": "t1", "tool": "run_command"}]})
        until(host, "ack")
        with client.websocket_connect("/api/remote/sessions/s1/ws", headers={"Authorization": "Bearer lxb_test"}) as phone:
            until(phone, "channel_status")
            assert until(phone, "tool_use")["id"] == "t1"
        assert remote.hub.get("s1").cmd_seq == 0
