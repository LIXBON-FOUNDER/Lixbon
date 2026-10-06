"""
visual_events.py — Avisos en vivo de Visuals (versión nueva, render terminado) para
la web y el panel del IDE. Bus en memoria del proceso: con varias réplicas del
gateway hará falta moverlo a Redis (docs/ESPECIFICACION_VISUALS.md, punto abierto 5).
`publish` se puede llamar desde otro hilo (el worker de render en modo inline).
"""
from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any


class VisualEvents:
    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue]] = defaultdict(set)
        self._loop: asyncio.AbstractEventLoop | None = None

    def subscribe(self, visual_id: str) -> asyncio.Queue:
        try:
            self._loop = asyncio.get_running_loop()
        except RuntimeError:
            pass
        q: asyncio.Queue = asyncio.Queue(maxsize=50)
        self._subs[visual_id].add(q)
        return q

    def unsubscribe(self, visual_id: str, q: asyncio.Queue) -> None:
        subs = self._subs.get(visual_id)
        if subs:
            subs.discard(q)
            if not subs:
                self._subs.pop(visual_id, None)

    def publish(self, visual_id: str, event: dict[str, Any]) -> None:
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if self._loop is not None and running is not self._loop and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self._deliver, visual_id, event)
        else:
            self._deliver(visual_id, event)

    def _deliver(self, visual_id: str, event: dict[str, Any]) -> None:
        for q in list(self._subs.get(visual_id, ())):
            if q.full():
                q.get_nowait()
            q.put_nowait(event)


bus = VisualEvents()
