"""
El host (IDE/CLI) publica eventos del transcript y consume comandos; los
controllers (app móvil / web) consumen eventos y publican comandos. El hub
solo reenvía: no ejecuta nada ni persiste el transcript. Válido con 1 réplica
del gateway (Railway); con N réplicas se sustituirían las colas por Redis.
"""
from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

EVENT_BUFFER_SIZE = 500      # replay para controllers que (re)conectan
QUEUE_MAX = 1000             # tope defensivo por cola
MAX_CONTROLLERS = 5          # controllers simultáneos por sesión
RECENT_COMMANDS = 50         # comandos que se pueden reentregar a un host que reconecta
COMMAND_REPLAY_SECONDS = 300
RECENT_REQUESTS = 200        # rid de comandos ya encolados: un reenvío del móvil no duplica
# Un host que se reconecta tarda unos segundos: durante ese margen sigue
# contando como conectado para el móvil y sus comandos se encolan.
HOST_GRACE_SECONDS = 45


# Lo que el host anuncia en su `hello` y un controller que llega tarde necesita:
# qué agente es, dónde trabaja, qué comandos "/" acepta y qué puede recibir.
# Estado vivo que no es transcript: no entra en el buffer de replay (lo
# llenaría con snapshots repetidos) y nunca se persiste. Del orquestador se
# guarda solo el último, que el controller recibe al conectar.
STATE_EVENTS = frozenset({"orch"})
# Respuestas a una petición puntual de un controller (diff, terminal…): se
# reparten y se olvidan. `orch_core_snapshot` y `orch_core_events` son el
# bootstrap observacional de Mobile (LXO-107): estado del Core que el relay no
# guarda ni repite; el móvil las empareja por `rid`. `orch_core_attention` es
# la bandeja de Attention completa (LXO-109).
EPHEMERAL_EVENTS = frozenset({
    "orch_diff", "orch_term", "orch_agents", "orch_error",
    "orch_core_snapshot", "orch_core_events", "orch_core_attention",
})

HELLO_META_KEYS = (
    "source", "title", "machine", "mode", "model",
    "agent", "workspace", "commands", "capabilities",
    "models", "model_value", "efforts", "effort",
)


@dataclass
class RemoteChannel:
    session_id: str
    user_id: int
    meta: dict[str, Any] = field(default_factory=dict)      # hello del host
    orch: dict[str, Any] | None = None                      # último estado del orquestador
    host_queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=QUEUE_MAX))
    controllers: dict[int, asyncio.Queue] = field(default_factory=dict)
    buffer: deque = field(default_factory=lambda: deque(maxlen=EVENT_BUFFER_SIZE))
    last_seq: int = 0
    host_connected: bool = False
    host_gen: int = 0
    host_left_at: float = 0.0
    cmd_seq: int = 0
    recent_cmds: deque = field(default_factory=lambda: deque(maxlen=RECENT_COMMANDS))
    recent_rids: deque = field(default_factory=lambda: deque(maxlen=RECENT_REQUESTS))
    last_touch: float = 0.0
    last_host_seen: float = field(default_factory=time.time)
    _next_controller_id: int = 0


class RemoteHub:
    def __init__(self) -> None:
        self._channels: dict[str, RemoteChannel] = {}
        # Suscriptores de la lista de sesiones por usuario (pantalla Remote de la app)
        self._user_subs: dict[int, set[asyncio.Queue]] = {}

    def channel(self, session_id: str, user_id: int) -> RemoteChannel:
        ch = self._channels.get(session_id)
        if ch is None:
            ch = RemoteChannel(session_id=session_id, user_id=user_id)
            self._channels[session_id] = ch
        return ch

    def get(self, session_id: str) -> RemoteChannel | None:
        return self._channels.get(session_id)

    def live_host_sessions(self) -> list[str]:
        """Sesiones con el host enganchado ahora mismo. El barrido las refresca
        para no marcar offline un IDE conectado pero sin actividad de chat."""
        return [sid for sid, ch in self._channels.items() if ch.host_connected]

    def drop(self, session_id: str) -> None:
        ch = self._channels.pop(session_id, None)
        if ch:
            # Despierta a los controllers colgados del stream con un fin de sesión
            self._fanout(ch, {"type": "session_ended", "seq": ch.last_seq, "ts": time.time()})

    def publish_events(self, ch: RemoteChannel, events: list[dict[str, Any]]) -> int:
        """Asigna seq, guarda en el buffer de replay y reparte. Devuelve el último seq."""
        ch.last_host_seen = time.time()
        for ev in events:
            ch.last_seq += 1
            ev["seq"] = ch.last_seq
            ev.setdefault("ts", time.time())
            kind = ev.get("type")
            if kind == "hello":
                ch.meta = {k: ev.get(k) for k in HELLO_META_KEYS}
            if kind in STATE_EVENTS:
                ch.orch = ev
            elif kind not in EPHEMERAL_EVENTS:
                ch.buffer.append(ev)
            self._fanout(ch, ev)
        return ch.last_seq

    def _fanout(self, ch: RemoteChannel, ev: dict[str, Any]) -> None:
        for q in list(ch.controllers.values()):
            try:
                q.put_nowait(ev)
            except asyncio.QueueFull:
                pass  # controller lentísimo: perderá eventos y reconectará con from_seq

    def replay(self, ch: RemoteChannel, from_seq: int) -> list[dict[str, Any]]:
        return [ev for ev in ch.buffer if ev.get("seq", 0) > from_seq]

    def push_command(self, ch: RemoteChannel, command: dict[str, Any]) -> bool:
        ch.cmd_seq += 1
        command = {**command, "cmd_seq": ch.cmd_seq}
        try:
            ch.host_queue.put_nowait(command)
        except asyncio.QueueFull:
            ch.cmd_seq -= 1
            return False
        ch.recent_cmds.append((time.time(), command))
        return True

    def attach_host(self, ch: RemoteChannel, last_cmd: int | None) -> tuple[int, asyncio.Queue]:
        """Engancha un stream de comandos del host y jubila al anterior.

        Si el host pierde la red sin cerrar el socket, el gateway no se entera
        hasta que un ping falla: ese stream zombi seguía consumiendo la cola y
        los comandos del móvil se perdían en un socket muerto. Cada conexión
        tiene ahora su propia cola, y el host dice en `last_cmd` el último
        comando que recibió para que se le reentregue lo que el zombi se tragó.
        """
        ch.host_gen += 1
        old = ch.host_queue
        pending: dict[int, dict[str, Any]] = {}
        while not old.empty():
            cmd = old.get_nowait()
            if cmd is not None:
                pending[cmd.get("cmd_seq", 0)] = cmd
        if last_cmd is not None:
            cutoff = time.time() - COMMAND_REPLAY_SECONDS
            for at, cmd in ch.recent_cmds:
                if cmd["cmd_seq"] > last_cmd and at >= cutoff:
                    pending.setdefault(cmd["cmd_seq"], cmd)
        new: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)
        for seq in sorted(pending):
            new.put_nowait(pending[seq])
        ch.host_queue = new
        old.put_nowait(None)  # despierta al stream jubilado para que termine
        was_online = self.host_online(ch)
        ch.host_connected = True
        if not was_online:
            self._fanout(ch, self.host_status(ch))
        return ch.host_gen, new

    def detach_host(self, ch: RemoteChannel, gen: int) -> bool:
        """True si este stream era el vigente. No avisa a nadie: el host tiene
        HOST_GRACE_SECONDS para volver antes de darse por desconectado."""
        if ch.host_gen != gen:
            return False
        ch.host_connected = False
        ch.host_left_at = time.time()
        return True

    def host_online(self, ch: RemoteChannel) -> bool:
        if ch.host_connected:
            return True
        return ch.host_gen > 0 and time.time() - ch.host_left_at < HOST_GRACE_SECONDS

    def announce_host(self, ch: RemoteChannel) -> None:
        self._fanout(ch, self.host_status(ch))

    def host_status(self, ch: RemoteChannel) -> dict[str, Any]:
        return {"type": "channel_status", "seq": ch.last_seq, "host_connected": self.host_online(ch), "ts": time.time()}

    def seen_request(self, ch: RemoteChannel, rid: Any) -> bool:
        """Marca `rid` y dice si ya se había encolado (el móvil reenvía lo que
        no vio confirmado tras un corte)."""
        if not isinstance(rid, str) or not rid:
            return False
        if rid in ch.recent_rids:
            return True
        ch.recent_rids.append(rid)
        return False

    def attach_controller(self, ch: RemoteChannel) -> tuple[int, asyncio.Queue]:
        # Un móvil congelado en segundo plano deja su conexión abierta minutos:
        # al llegar al tope se jubila la más antigua en vez de rechazar la nueva.
        while len(ch.controllers) >= MAX_CONTROLLERS:
            oldest = min(ch.controllers)
            q_old = ch.controllers.pop(oldest)
            try:
                q_old.put_nowait(None)
            except asyncio.QueueFull:
                pass
        ch._next_controller_id += 1
        cid = ch._next_controller_id
        q: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)
        ch.controllers[cid] = q
        return cid, q

    def detach_controller(self, ch: RemoteChannel, cid: int) -> None:
        ch.controllers.pop(cid, None)

    def subscribe_user(self, user_id: int) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=100)
        self._user_subs.setdefault(user_id, set()).add(q)
        return q

    def unsubscribe_user(self, user_id: int, q: asyncio.Queue) -> None:
        subs = self._user_subs.get(user_id)
        if subs:
            subs.discard(q)
            if not subs:
                self._user_subs.pop(user_id, None)

    def notify_user(self, user_id: int, payload: dict[str, Any]) -> None:
        payload.setdefault("ts", time.time())
        for q in list(self._user_subs.get(user_id, ())):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                pass


hub = RemoteHub()
