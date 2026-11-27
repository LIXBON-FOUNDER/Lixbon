"""Ciclo de vida de los entornos de Coding: arrancar, pausar, terminar, barrer.

Estados (coding_sandboxes.estado):
  creada → preparando (contenedor arrancando, clonando) → activa
  activa → pausada (30 min sin actividad o a mano) → preparando (al reanudar)
  preparando → error (no arrancó / no clonó) → preparando (reintentar)
  pausada/error/creada → terminada (7 días, o al eliminar la sesión)
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from fastapi import HTTPException

from core.gateway.remote_hub import hub
from core.persistence import coding as store
from core.persistence.queries import end_remote_session, touch_remote_session
from core.sandbox.runner import Arranque, SandboxError, runner

log = logging.getLogger("lixbon.sandbox")

MAX_ACTIVAS = int(os.getenv("CODING_MAX_ACTIVAS", "2"))
PAUSA_MIN = float(os.getenv("CODING_IDLE_MIN", "30"))
BORRAR_DIAS = float(os.getenv("CODING_BORRAR_DIAS", "7"))
# Una sesión fijada en la barra conserva su entorno más tiempo.
BORRAR_DIAS_FIJADAS = float(os.getenv("CODING_BORRAR_DIAS_FIJADAS", "30"))
BARRIDO_S = float(os.getenv("CODING_BARRIDO_S", "60"))
# Un entorno «preparando» tarda unos segundos en tener contenedor: hasta
# pasado este margen no se da por perdido.
GRACIA_ARRANQUE_S = float(os.getenv("CODING_GRACIA_ARRANQUE_S", "120"))
# El recolector de restos pasa cada tantos barridos (y en el primero).
RECOLECTAR_CADA = int(os.getenv("CODING_RECOLECTAR_CADA", "10"))


def avisar(sb: dict[str, Any], estado: str, **extra: Any) -> None:
    """Publica el estado del entorno en el canal de la sesión (lo pinta la web)."""
    ch = hub.channel(sb["session_id"], sb["user_id"])
    hub.publish_events(ch, [{"type": "sandbox_status", "estado": estado, **extra}])


async def arrancar(sb: dict[str, Any]) -> dict[str, Any]:
    """Arranca (o reanuda) el contenedor. Respeta el límite de activas."""
    sid = sb["session_id"]
    if sb["estado"] in store.ESTADOS_ACTIVOS:
        return sb
    if sb["estado"] == "terminada":
        raise HTTPException(status_code=410, detail={"code": "session_ended", "message": "La sesión ya terminó"})
    activas = await asyncio.to_thread(store.contar_activas, sb["user_id"])
    if activas >= MAX_ACTIVAS:
        raise HTTPException(status_code=429, detail={
            "code": "max_active_sessions",
            "message": f"Tienes {activas} sesiones en la nube activas. Pausa o elimina una para empezar otra. "
                       "Las pausadas no cuentan."})
    if not await asyncio.to_thread(store.reclamar_estado, sid, ("creada", "pausada", "error"), "preparando"):
        return await asyncio.to_thread(store.obtener, sid)  # otro clic ya lo está arrancando
    avisar(sb, "preparando")
    token = await asyncio.to_thread(store.emitir_token, sid)
    try:
        cid = await asyncio.to_thread(runner().arrancar, Arranque(
            session_id=sid, user_id=sb["user_id"], token=token, repo=sb["repo"],
            default_branch=sb["default_branch"], mode=sb["mode"], model=sb.get("model")))
    except SandboxError as exc:
        await asyncio.to_thread(store.revocar_token, sid)
        sb = await asyncio.to_thread(store.actualizar, sid, estado="error",
                                     error="No se pudo crear el entorno. Prueba de nuevo en unos minutos")
        log.warning("[coding] %s no arrancó: %s", sid, exc)
        avisar(sb, "error", detalle=sb["error"])
        raise HTTPException(status_code=503, detail={"code": "sandbox_unavailable", "message": sb["error"]})
    return await asyncio.to_thread(store.actualizar, sid, container_id=cid, error=None, paused_at=None)


async def pausar(sb: dict[str, Any], motivo: str = "manual") -> dict[str, Any]:
    sid = sb["session_id"]
    if sb["estado"] not in store.ESTADOS_ACTIVOS:
        return sb
    await asyncio.to_thread(store.revocar_token, sid)
    try:
        await asyncio.to_thread(runner().detener, sid)
    except SandboxError as exc:
        log.warning("[coding] no se pudo parar %s: %s", sid, exc)
    sb = await asyncio.to_thread(store.actualizar, sid, estado="pausada", container_id=None,
                                 paused_at=store._hace(seconds=0))
    await asyncio.to_thread(touch_remote_session, sid, "offline")
    avisar(sb, "pausada", motivo=motivo)
    return sb


async def terminar(sb: dict[str, Any]) -> None:
    """Borra contenedor, red y volumen. La rama en GitHub se queda."""
    sid = sb["session_id"]
    await asyncio.to_thread(store.revocar_token, sid)
    try:
        await asyncio.to_thread(runner().borrar, sid)
    except SandboxError as exc:
        log.warning("[coding] no se pudo borrar %s: %s", sid, exc)
    await asyncio.to_thread(store.actualizar, sid, estado="terminada", container_id=None,
                            ended_at=store._hace(seconds=0))
    await asyncio.to_thread(end_remote_session, sid)
    ch = hub.get(sid)
    if ch:
        hub.push_command(ch, {"type": "bye", "reason": "ended"})
        hub.publish_events(ch, [{"type": "bye", "reason": "ended"}])
    hub.drop(sid)
    hub.notify_user(sb["user_id"], {"type": "session_ended", "session_id": sid})


async def reconciliar() -> int:
    """La base de datos dice «encendido» pero el contenedor ya no existe
    (Docker se reinició, alguien lo borró a mano): la sesión pasa a pausada
    para que la web ofrezca «Reanudar». El volumen sigue ahí."""
    # Primero la BD y después Docker: un entorno que arranca entre las dos
    # lecturas no está en la lista, así que no se puede dar por perdido.
    candidatas = await asyncio.to_thread(store.encendidas)
    if not candidatas:
        return 0
    vivos = await asyncio.to_thread(runner().vivos)
    if vivos is None:  # Docker no contesta: no se concluye nada
        return 0
    limite = store._hace(seconds=GRACIA_ARRANQUE_S)
    perdidas = 0
    for sb in candidatas:
        sid = sb["session_id"]
        if sid in vivos or (sb["estado"] == "preparando" and sb["last_activity_at"] > limite):
            continue
        if not await asyncio.to_thread(store.reclamar_estado, sid, store.ESTADOS_ACTIVOS, "pausada"):
            continue  # se pausó o terminó mientras tanto
        await asyncio.to_thread(store.revocar_token, sid)
        try:
            await asyncio.to_thread(runner().detener, sid)  # suelta la red
        except SandboxError as exc:
            log.warning("[coding] no se pudo limpiar %s: %s", sid, exc)
        sb = await asyncio.to_thread(store.actualizar, sid, container_id=None, paused_at=store._hace(seconds=0))
        await asyncio.to_thread(touch_remote_session, sid, "offline")
        avisar(sb, "pausada", motivo="entorno_perdido")
        log.warning("[coding] %s figuraba encendida sin contenedor: pausada", sid)
        perdidas += 1
    return perdidas


async def recolectar() -> int:
    """Borra contenedores, redes y volúmenes de esta instalación cuya sesión
    ya no existe (un borrado que falló a medias, una sesión eliminada con
    Docker caído)."""
    restos = await asyncio.to_thread(runner().restos)
    if not restos:
        return 0
    legitimas = await asyncio.to_thread(store.con_entorno, sorted(restos))
    sobran = restos - legitimas
    for sid in sobran:
        try:
            await asyncio.to_thread(runner().borrar, sid)
            log.info("[coding] recolectados los restos de %s", sid)
        except (SandboxError, ValueError) as exc:
            log.warning("[coding] no se pudieron recolectar los restos de %s: %s", sid, exc)
    return len(sobran)


_barridos = 0


async def barrer() -> None:
    global _barridos
    try:
        await reconciliar()
    except Exception as exc:  # noqa: BLE001 — el barrido sigue
        log.warning("[coding] reconciliación: %s", exc)
    for sb in await asyncio.to_thread(store.inactivas, PAUSA_MIN):
        # Un host con un turno en marcha publica eventos y toca la sesión, así
        # que aquí solo caen los que de verdad están quietos.
        try:
            await pausar(sb, motivo="inactividad")
        except Exception as exc:  # noqa: BLE001 — el barrido sigue con los demás
            log.warning("[coding] pausa automática de %s falló: %s", sb["session_id"], exc)
    for sb in await asyncio.to_thread(store.para_borrar, BORRAR_DIAS, BORRAR_DIAS_FIJADAS):
        try:
            await terminar(sb)
        except Exception as exc:  # noqa: BLE001
            log.warning("[coding] borrado de %s falló: %s", sb["session_id"], exc)
    if RECOLECTAR_CADA > 0 and _barridos % RECOLECTAR_CADA == 0:
        try:
            await recolectar()
        except Exception as exc:  # noqa: BLE001
            log.warning("[coding] recolector: %s", exc)
    _barridos += 1


def iniciar_barrido() -> asyncio.Task:
    async def bucle():
        while True:
            await asyncio.sleep(BARRIDO_S)
            try:
                await barrer()
            except Exception as exc:  # noqa: BLE001
                log.warning("[coding] barrido: %s", exc)
    return asyncio.get_running_loop().create_task(bucle())
