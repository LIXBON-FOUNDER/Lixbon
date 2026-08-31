"""
team_hub.py — Las conexiones vivas de Lixbon Team.

Guarda, POR USUARIO, el conjunto de sus conexiones abiertas, y la presencia de
cada uno. Dos cosas que parecen detalles y no lo son:

  • **Un conjunto, no una conexión.** Una persona tiene el IDE y la ventana de
    Team a la vez, y a veces el portátil y el sobremesa. Todo evento dirigido a
    alguien se emite a TODAS sus conexiones abiertas; un hub que solo guardara
    la última dejaría el chat acoplado mudo en cuanto se abriera Team
    (sección 8 del contrato).

  • **La presencia se apaga con la ÚLTIMA.** Cerrar una de dos ventanas no
    desconecta a nadie.

Vive en memoria, como `remote_hub`: la presencia es un dato volátil y no pasa
nada si se pierde en un reinicio —el cliente reconecta y se vuelve a anunciar—.
Con N réplicas del gateway habría que sustituir este diccionario por un
pub/sub de Redis; con una, que es lo que hay en Railway, sobra.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger("lixbon.team")

COLA_MAX = 200  # tope defensivo por conexión


class Conexion:
    """Una pestaña. La cola desacopla al emisor del socket: si un cliente va
    lentísimo, se le pierden eventos y reconectará con sus cursores, en vez de
    bloquear a quien está escribiendo."""

    __slots__ = ("usuario_id", "cola")

    def __init__(self, usuario_id: int) -> None:
        self.usuario_id = usuario_id
        self.cola: asyncio.Queue = asyncio.Queue(maxsize=COLA_MAX)

    def poner(self, evento: dict[str, Any]) -> None:
        try:
            self.cola.put_nowait(evento)
        except asyncio.QueueFull:
            logger.warning("[team] cola llena para el usuario %s: evento descartado",
                           self.usuario_id)


class TeamHub:
    def __init__(self) -> None:
        self._conexiones: dict[int, set[Conexion]] = {}
        self._presencia: dict[int, str] = {}

    # ── Conexiones ───────────────────────────────────────────────────────

    def entrar(self, usuario_id: int) -> Conexion:
        con = Conexion(usuario_id)
        self._conexiones.setdefault(usuario_id, set()).add(con)
        return con

    def salir(self, con: Conexion) -> bool:
        """True si era la última conexión de esa persona (o sea, si acaba de
        quedarse desconectada de verdad)."""
        abiertas = self._conexiones.get(con.usuario_id)
        if not abiertas:
            return False
        abiertas.discard(con)
        if abiertas:
            return False
        self._conexiones.pop(con.usuario_id, None)
        return True

    def conectado(self, usuario_id: int) -> bool:
        return bool(self._conexiones.get(usuario_id))

    def cuantas(self, usuario_id: int) -> int:
        return len(self._conexiones.get(usuario_id, ()))

    # ── Presencia ────────────────────────────────────────────────────────

    def estado_real(self, usuario_id: int) -> str:
        """El de verdad. Solo lo ve su dueño."""
        return self._presencia.get(usuario_id, "desconectado")

    def estado_publico(self, usuario_id: int) -> str:
        """Lo que ven los demás. Regla 4 del transporte: `invisible` NO SALE
        NUNCA del servidor; a terceros se les dice `desconectado`. Si la
        traducción viviera en el cliente, un cliente manipulado vería quién está
        escondido, que es exactamente lo que el estado promete que no pasa."""
        estado = self._presencia.get(usuario_id, "desconectado")
        return "desconectado" if estado == "invisible" else estado

    def poner_estado(self, usuario_id: int, estado: str) -> None:
        self._presencia[usuario_id] = estado

    # ── Emisión ──────────────────────────────────────────────────────────

    def a_usuario(self, usuario_id: int, evento: dict[str, Any]) -> None:
        for con in tuple(self._conexiones.get(usuario_id, ())):
            con.poner(evento)

    def a_usuarios(self, ids, evento: dict[str, Any], excepto: int | None = None) -> None:
        for uid in ids:
            if uid == excepto:
                continue
            self.a_usuario(uid, evento)


hub = TeamHub()
