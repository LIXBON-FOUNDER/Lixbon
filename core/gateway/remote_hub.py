"""
remote_hub.py — Relay en memoria de las sesiones /remote.

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


@dataclass
class RemoteChannel:
    session_id: str
    user_id: int
    meta: dict[str, Any] = field(default_factory=dict)      # hello del host
    host_queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=QUEUE_MAX))
    controllers: dict[int, asyncio.Queue] = field(default_factory=dict)
    buffer: deque = field(default_factory=lambda: deque(maxlen=EVENT_BUFFER_SIZE))
    last_seq: int = 0
    host_connected: bool = False
    last_host_seen: float = field(default_factory=time.time)
    _next_controller_id: int = 0


class RemoteHub:
    def __init__(self) -> None:
        self._channels: dict[str, RemoteChannel] = {}
        # Suscriptores de la lista de sesiones por usuario (pantalla Remote de la app)
        self._user_subs: dict[int, set[asyncio.Queue]] = {}

    # ── canales ──────────────────────────────────────────────────────────

    def channel(self, session_id: str, user_id: int) -> RemoteChannel:
        ch = self._channels.get(session_id)
        if ch is None:
            ch = RemoteChannel(session_id=session_id, user_id=user_id)
            self._channels[session_id] = ch
        return ch

    def get(self, session_id: str) -> RemoteChannel | None:
        return self._channels.get(session_id)

    def drop(self, session_id: str) -> None:
        ch = self._channels.pop(session_id, None)
        if ch:
            # Despierta a los controllers colgados del stream con un fin de sesión
            self._fanout(ch, {"type": "session_ended", "seq": ch.last_seq, "ts": time.time()})

    # ── eventos (host → controllers) ─────────────────────────────────────

    def publish_events(self, ch: RemoteChannel, events: list[dict[str, Any]]) -> int:
        """Asigna seq, guarda en el buffer de replay y reparte. Devuelve el último seq."""
        ch.last_host_seen = time.time()
        for ev in events:
            ch.last_seq += 1
            ev["seq"] = ch.last_seq
            ev.setdefault("ts", time.time())
            if ev.get("type") == "hello":
                ch.meta = {k: ev.get(k) for k in ("source", "title", "machine", "mode", "model")}
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

    # ── comandos (controller → host) ─────────────────────────────────────

    def push_command(self, ch: RemoteChannel, command: dict[str, Any]) -> bool:
        try:
            ch.host_queue.put_nowait(command)
            return True
        except asyncio.QueueFull:
            return False

    # ── controllers ──────────────────────────────────────────────────────

    def attach_controller(self, ch: RemoteChannel) -> tuple[int, asyncio.Queue] | None:
        if len(ch.controllers) >= MAX_CONTROLLERS:
            return None
        ch._next_controller_id += 1
        cid = ch._next_controller_id
        q: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)
        ch.controllers[cid] = q
        return cid, q

    def detach_controller(self, ch: RemoteChannel, cid: int) -> None:
        ch.controllers.pop(cid, None)

    # ── avisos de la lista de sesiones (pantalla Remote) ─────────────────

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
