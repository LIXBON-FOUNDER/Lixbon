"""
/api/espacios/*: espacios del usuario (instrucciones, archivos, memoria, repo)
y sus agentes programados con sus ejecuciones. Solo sesión web.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from core.gateway import agentes
from core.persistence import espacios as store
from core.security.auth import session_required

router = APIRouter(tags=["espacios"])


async def _hacer(fn, *args):
    try:
        return await run_in_threadpool(fn, *args)
    except store.ErrorEspacio as e:
        raise HTTPException(status_code=e.codigo, detail=e.detalle)


class Nota(BaseModel):
    texto: str


@router.get("/api/espacios")
async def listar(yo: dict[str, Any] = Depends(session_required)):
    return await _hacer(store.listar, yo["id"])


@router.post("/api/espacios")
async def crear(datos: dict[str, Any], yo: dict[str, Any] = Depends(session_required)):
    return await _hacer(store.crear, yo["id"], datos)


@router.get("/api/espacios/{espacio_id}")
async def obtener(espacio_id: str, yo: dict[str, Any] = Depends(session_required)):
    return await _hacer(store.obtener, yo["id"], espacio_id)


@router.patch("/api/espacios/{espacio_id}")
async def editar(espacio_id: str, datos: dict[str, Any], yo: dict[str, Any] = Depends(session_required)):
    return await _hacer(store.editar, yo["id"], espacio_id, datos)


@router.delete("/api/espacios/{espacio_id}")
async def borrar(espacio_id: str, yo: dict[str, Any] = Depends(session_required)):
    await _hacer(store.borrar, yo["id"], espacio_id)
    return {"ok": True}


@router.post("/api/espacios/{espacio_id}/archivos")
async def subir_archivo(espacio_id: str, file: UploadFile = File(...),
                        yo: dict[str, Any] = Depends(session_required)):
    contenido = await file.read(store.MAX_ARCHIVO_BYTES + 1)
    return await _hacer(store.subir_archivo, yo["id"], espacio_id, file.filename or "archivo.txt",
                        file.content_type or "text/plain", contenido)


@router.delete("/api/espacios/{espacio_id}/archivos/{archivo_id}")
async def borrar_archivo(espacio_id: str, archivo_id: str, yo: dict[str, Any] = Depends(session_required)):
    await _hacer(store.borrar_archivo, yo["id"], espacio_id, archivo_id)
    return {"ok": True}


@router.post("/api/espacios/{espacio_id}/memoria")
async def anadir_memoria(espacio_id: str, nota: Nota, yo: dict[str, Any] = Depends(session_required)):
    return await _hacer(store.anadir_memoria, yo["id"], espacio_id, nota.texto)


@router.post("/api/espacios/{espacio_id}/memoria/{memoria_id}/aprobar")
async def aprobar_memoria(espacio_id: str, memoria_id: str, yo: dict[str, Any] = Depends(session_required)):
    return await _hacer(store.aprobar_memoria, yo["id"], espacio_id, memoria_id)


@router.delete("/api/espacios/{espacio_id}/memoria/{memoria_id}")
async def borrar_memoria(espacio_id: str, memoria_id: str, yo: dict[str, Any] = Depends(session_required)):
    await _hacer(store.borrar_memoria, yo["id"], espacio_id, memoria_id)
    return {"ok": True}


@router.post("/api/espacios/{espacio_id}/agentes")
async def crear_agente(espacio_id: str, datos: dict[str, Any], yo: dict[str, Any] = Depends(session_required)):
    return await _hacer(store.crear_agente, yo["id"], espacio_id, datos)


@router.get("/api/agentes/{agente_id}")
async def obtener_agente(agente_id: str, yo: dict[str, Any] = Depends(session_required)):
    return await _hacer(store.obtener_agente, yo["id"], agente_id)


@router.patch("/api/agentes/{agente_id}")
async def editar_agente(agente_id: str, datos: dict[str, Any], yo: dict[str, Any] = Depends(session_required)):
    return await _hacer(store.editar_agente, yo["id"], agente_id, datos)


@router.delete("/api/agentes/{agente_id}")
async def borrar_agente(agente_id: str, yo: dict[str, Any] = Depends(session_required)):
    await _hacer(store.borrar_agente, yo["id"], agente_id)
    return {"ok": True}


@router.post("/api/agentes/{agente_id}/ejecutar")
async def ejecutar_ahora(agente_id: str, yo: dict[str, Any] = Depends(session_required)):
    try:
        eje_id = await agentes.ejecutar(agente_id, "manual", yo["id"])
    except store.ErrorEspacio as e:
        raise HTTPException(status_code=e.codigo, detail=e.detalle)
    if not eje_id:
        raise HTTPException(status_code=409, detail="Ya está trabajando")
    return {"id": eje_id}


@router.get("/api/ejecuciones/{ejecucion_id}")
async def obtener_ejecucion(ejecucion_id: str, yo: dict[str, Any] = Depends(session_required)):
    return await _hacer(store.obtener_ejecucion, yo["id"], ejecucion_id)
