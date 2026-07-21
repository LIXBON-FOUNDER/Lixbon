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


def test_limite_de_controllers():
    async def scenario():
        hub = RemoteHub()
        ch = hub.channel("s1", 1)
        for _ in range(MAX_CONTROLLERS):
            assert hub.attach_controller(ch) is not None
        assert hub.attach_controller(ch) is None
        # al soltar uno vuelve a haber sitio
        hub.detach_controller(ch, 1)
        assert hub.attach_controller(ch) is not None

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
