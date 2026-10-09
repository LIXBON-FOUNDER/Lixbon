"""Tests del RemoteHub (relay en memoria de /remote). Sin BD ni red."""
import asyncio

from core.gateway.remote_hub import MAX_CONTROLLERS, RemoteHub


def run(coro):
    return asyncio.run(coro)


def test_publish_asigna_seq_y_reparte():
    async def scenario():
        hub = RemoteHub()
        ch = hub.channel("s1", 1)
        _, q = hub.attach_controller(ch)
        hub.publish_events(ch, [{"type": "hello", "source": "cli"}, {"type": "user_msg", "text": "hola"}])
        first, second = q.get_nowait(), q.get_nowait()
        assert (first["seq"], second["seq"]) == (1, 2)
        assert ch.meta.get("source") == "cli"

    run(scenario())


def test_replay_desde_seq():
    async def scenario():
        hub = RemoteHub()
        ch = hub.channel("s1", 1)
        hub.publish_events(ch, [{"type": "user_msg", "text": str(i)} for i in range(5)])
        tail = hub.replay(ch, 3)
        assert [ev["seq"] for ev in tail] == [4, 5]

    run(scenario())


def test_tope_de_controllers_jubila_al_mas_antiguo():
    async def scenario():
        hub = RemoteHub()
        ch = hub.channel("s1", 1)
        colas = [hub.attach_controller(ch)[1] for _ in range(MAX_CONTROLLERS)]
        cid, _ = hub.attach_controller(ch)
        assert len(ch.controllers) == MAX_CONTROLLERS
        assert 1 not in ch.controllers and cid in ch.controllers
        assert colas[0].get_nowait() is None

    run(scenario())


def test_comandos_al_host_y_tope():
    async def scenario():
        hub = RemoteHub()
        ch = hub.channel("s1", 1)
        assert hub.push_command(ch, {"type": "prompt", "text": "x"})
        assert ch.host_queue.get_nowait()["text"] == "x"

    run(scenario())


def test_drop_notifica_fin_a_controllers():
    async def scenario():
        hub = RemoteHub()
        ch = hub.channel("s1", 1)
        _, q = hub.attach_controller(ch)
        hub.drop("s1")
        assert q.get_nowait()["type"] == "session_ended"
        assert hub.get("s1") is None

    run(scenario())


def test_suscripcion_por_usuario():
    async def scenario():
        hub = RemoteHub()
        q1 = hub.subscribe_user(1)
        q2 = hub.subscribe_user(2)
        hub.notify_user(1, {"type": "session_created"})
        assert q1.get_nowait()["type"] == "session_created"
        assert q2.empty()
        hub.unsubscribe_user(1, q1)
        hub.notify_user(1, {"type": "session_online"})
        assert q1.empty()

    run(scenario())


def test_hello_conserva_agente_comandos_y_capacidades():
    async def scenario():
        hub = RemoteHub()
        ch = hub.channel("s1", 1)
        hub.publish_events(ch, [{
            "type": "hello", "source": "ide", "agent": "claude", "workspace": "lixbon",
            "commands": [{"name": "compact", "group": "claude"}], "capabilities": ["images"],
            "basura": "x",
        }])
        assert ch.meta["agent"] == "claude"
        assert ch.meta["commands"][0]["name"] == "compact"
        assert ch.meta["capabilities"] == ["images"]
        assert "basura" not in ch.meta

    run(scenario())


def test_estado_del_orquestador_fuera_del_replay():
    async def scenario():
        hub = RemoteHub()
        ch = hub.channel("s1", 1)
        _, q = hub.attach_controller(ch)
        hub.publish_events(ch, [
            {"type": "user_msg", "text": "hola"},
            {"type": "orch", "enabled": True, "runs": []},
            {"type": "orch", "enabled": True, "runs": [{"id": "r1"}]},
            {"type": "orch_term", "task": "t1", "text": "…"},
        ])
        # Todo llega en vivo…
        assert [q.get_nowait()["type"] for _ in range(4)] == ["user_msg", "orch", "orch", "orch_term"]
        # …pero el replay solo guarda el transcript, y del orquestador el último.
        assert [ev["type"] for ev in hub.replay(ch, 0)] == ["user_msg"]
        assert ch.orch["runs"] == [{"id": "r1"}]

    run(scenario())


def test_reconexion_del_host_no_lo_marca_offline_y_reentrega_comandos():
    async def scenario():
        hub = RemoteHub()
        ch = hub.channel("s1", 1)
        viejo, cola_vieja = hub.attach_host(ch, None)
        hub.push_command(ch, {"type": "prompt", "text": "a"})
        hub.push_command(ch, {"type": "prompt", "text": "b"})
        # el stream zombi se traga "a" y el socket ya estaba muerto
        assert cola_vieja.get_nowait()["text"] == "a"

        nuevo, cola = hub.attach_host(ch, 0)
        assert [cola.get_nowait()["text"] for _ in range(2)] == ["a", "b"]
        assert cola_vieja.get_nowait() is None

        assert hub.detach_host(ch, viejo) is False
        assert ch.host_connected
        assert hub.detach_host(ch, nuevo) is True
        assert not ch.host_connected
        assert hub.host_online(ch)

    run(scenario())


def test_reconexion_sin_last_cmd_no_reentrega_lo_ya_enviado():
    async def scenario():
        hub = RemoteHub()
        ch = hub.channel("s1", 1)
        _, cola_vieja = hub.attach_host(ch, None)
        hub.push_command(ch, {"type": "prompt", "text": "a"})
        hub.push_command(ch, {"type": "prompt", "text": "b"})
        cola_vieja.get_nowait()
        _, cola = hub.attach_host(ch, None)
        assert cola.get_nowait()["text"] == "b"
        assert cola.empty()

    run(scenario())
