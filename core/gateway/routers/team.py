"""
team.py — El gateway de Lixbon Team.

Implementa entero `docs/team-protocolo.md` (repo del IDE): `/api/team/*` y el
WebSocket `/ws/team`. El cliente de `src/team/` está escrito contra ese
documento y `tools/fake-team/server.mjs` lo implementa como referencia
ejecutable; si alguna vez discrepan, manda el documento.

Las once reglas del transporte se cumplen AQUÍ, no en la interfaz. Están citadas
una por una en el sitio donde se aplican, porque son la diferencia entre un chat
que funciona en una demo y uno que sobrevive a una red de verdad.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import (
    APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile,
    WebSocket, WebSocketDisconnect,
)
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from core.config import PUBLIC_BASE_URL, r2_configured
from core.gateway.team_hub import hub
from core.persistence import team_queries as tq
from core.persistence.queries import validate_api_key
from core.security.auth import cookie_auth_required
from core.storage import r2

logger = logging.getLogger("lixbon.team")
router = APIRouter()

MAX_ADJUNTO = 25 * 1024 * 1024      # 25 MB por archivo
MAX_POR_MENSAJE = 10
URL_TTL_S = 60 * 60                 # una hora: corta, y el cliente renueva
LIMITE_MENSAJES = 200

# El tipo se decide por el CONTENIDO, pero la extensión sigue siendo un veto:
# un ejecutable no se envía por el chat aunque su cabecera diga otra cosa.
EXT_PROHIBIDAS = {
    ".exe", ".msi", ".bat", ".cmd", ".com", ".scr", ".ps1", ".dll", ".jar", ".apk", ".sh",
}

# Secreto de las URLs firmadas de adjuntos. Si no se configura, se inventa uno
# al arrancar: las URLs ya repartidas dejan de valer tras un reinicio y el
# cliente las renueva con `/url`, que es exactamente para lo que existe esa ruta.
_URL_SECRETO = (os.getenv("TEAM_URL_SECRET") or secrets.token_hex(32)).encode("utf-8")


# ── Utilidades ─────────────────────────────────────────────────────────────

def _base_publico(peticion) -> str:
    """El origen que verá el cliente. Las URLs de adjuntos tienen que ser
    ABSOLUTAS: un `<img src>` del IDE se resuelve contra `tauri://localhost`,
    no contra lixbon.com."""
    if PUBLIC_BASE_URL:
        return PUBLIC_BASE_URL
    return str(peticion.base_url).rstrip("/")


def _firmante(base: str):
    """Devuelve la función que firma una URL de adjunto.

    REGLA 6 — la URL va firmada y caduca. Un `<img src>` no manda cabeceras, así
    que la autorización no puede vivir en `Authorization`: vive en la firma, que
    cubre `(id, caducidad)` y se comprueba en tiempo constante."""
    def firmar(adjunto_id: str) -> tuple[str, str]:
        exp = int(time.time()) + URL_TTL_S
        sig = hmac.new(_URL_SECRETO, f"{adjunto_id}.{exp}".encode("utf-8"),
                       hashlib.sha256).hexdigest()
        caduca = datetime.fromtimestamp(exp, timezone.utc).isoformat().replace("+00:00", "Z")
        return f"{base}/api/team/attachments/{adjunto_id}?exp={exp}&sig={sig}", caduca
    return firmar


def _firma_valida(adjunto_id: str, exp: str, sig: str) -> bool:
    try:
        if int(exp) < time.time():
            return False
    except (TypeError, ValueError):
        return False
    esperada = hmac.new(_URL_SECRETO, f"{adjunto_id}.{exp}".encode("utf-8"),
                        hashlib.sha256).hexdigest()
    return hmac.compare_digest(esperada, str(sig or ""))


def _no(codigo: int, detalle: str):
    return HTTPException(status_code=codigo, detail=detalle)


def _canal_o_404(canal_id: str, uid: int) -> dict[str, Any]:
    """Un canal que no se puede ver se contesta como si no existiera: confirmar
    que existe ya es contar algo de un proyecto ajeno."""
    c = tq.canal(canal_id)
    if not c or not tq.puede_ver_canal(canal_id, uid):
        raise _no(404, "No existe ese canal.")
    return c


def _emitir_canal(canal_id: str, evento: dict[str, Any], excepto: int | None = None) -> None:
    """REGLA 3 — la autorización vive en el emisor. Un canal privado no se
    «oculta» en el cliente: sus mensajes **no se emiten** a quien no es
    miembro, así que un cliente manipulado no puede ver nada extra."""
    hub.a_usuarios(tq.miembros_de_canal(canal_id), evento, excepto=excepto)


def _emitir_proyecto(proyecto_id: str, evento: dict[str, Any]) -> None:
    hub.a_usuarios(tq.miembros_de_proyecto(proyecto_id), evento)


def _difundir_presencia(uid: int) -> None:
    publico = {"tipo": "presencia", "usuario_id": uid, "estado": hub.estado_publico(uid)}
    hub.a_usuarios(tq.relacionados(uid), publico)
    # A uno mismo se le manda el estado REAL: es el único que puede saber que
    # está invisible.
    hub.a_usuario(uid, {"tipo": "presencia", "usuario_id": uid, "estado": hub.estado_real(uid)})


def _borrar_de_r2(claves: list[str]) -> None:
    """Los archivos de lo que se va. Sin esto el bucket crece para siempre con
    cosas que ya no puede ver nadie, que es una factura."""
    for clave in claves:
        try:
            r2.delete_object(clave)
        except Exception:  # noqa: BLE001 — un objeto que ya no está no es un error
            logger.warning("[team] no se pudo borrar %s de R2", clave)


# ── Cuerpos ────────────────────────────────────────────────────────────────

class ProyectoNuevo(BaseModel):
    nombre: str = Field(..., min_length=1, max_length=60)


class ProyectoCambios(BaseModel):
    nombre: str | None = Field(default=None, min_length=1, max_length=60)
    avatar_url: str | None = None
    github_repo: str | None = None
    linear_team_id: str | None = None
    linear_project_id: str | None = None


class MiembroNuevo(BaseModel):
    identificador: str = Field(..., min_length=1, max_length=200)


class CanalNuevo(BaseModel):
    nombre: str = Field(..., min_length=1, max_length=60)
    tipo: str = "publico"
    tema: str = ""


class CanalCambios(BaseModel):
    nombre: str | None = Field(default=None, min_length=1, max_length=60)
    tema: str | None = Field(default=None, max_length=200)


class UsuarioRef(BaseModel):
    usuario_id: int


class MensajeNuevo(BaseModel):
    client_id: str = Field(..., min_length=1, max_length=80)
    texto: str = ""
    adjuntos: list[str] = Field(default_factory=list)
    responde_a: str | None = None


class MensajeCambios(BaseModel):
    texto: str = ""


class PresenciaNueva(BaseModel):
    estado: str


# ── Arranque ───────────────────────────────────────────────────────────────

@router.get("/api/team/bootstrap")
async def team_bootstrap(yo: dict[str, Any] = Depends(cookie_auth_required)):
    """Todo lo que la ventana necesita para pintarse. UNA sola llamada: la
    ventana arranca de golpe, no a saltos."""
    uid = yo["id"]
    return tq.bootstrap(uid, hub.estado_real(uid), hub.estado_publico)


# ── Proyectos ──────────────────────────────────────────────────────────────

@router.post("/api/team/projects", status_code=201)
async def crear_proyecto(cuerpo: ProyectoNuevo, yo: dict[str, Any] = Depends(cookie_auth_required)):
    pid = tq.crear_proyecto(yo["id"], cuerpo.nombre.strip())
    return tq.proyecto_salida(pid, yo["id"], hub.estado_publico)


@router.patch("/api/team/projects/{proyecto_id}")
async def editar_proyecto(proyecto_id: str, cuerpo: ProyectoCambios,
                          yo: dict[str, Any] = Depends(cookie_auth_required)):
    if not tq.proyecto(proyecto_id):
        raise _no(404, "No existe ese proyecto.")
    if not tq.es_lider(proyecto_id, yo["id"]):
        raise _no(403, "Solo el líder puede hacer esto.")
    tq.editar_proyecto(proyecto_id, cuerpo.model_dump(exclude_unset=True))
    # A cada miembro se le manda SU vista del proyecto: los canales privados que
    # ve uno no son los que ve otro.
    for uid in tq.miembros_de_proyecto(proyecto_id):
        hub.a_usuario(uid, {"tipo": "proyecto_actualizado",
                            "proyecto": tq.proyecto_salida(proyecto_id, uid, hub.estado_publico)})
    return tq.proyecto_salida(proyecto_id, yo["id"], hub.estado_publico)


@router.delete("/api/team/projects/{proyecto_id}", status_code=204)
async def borrar_proyecto(proyecto_id: str, yo: dict[str, Any] = Depends(cookie_auth_required)):
    if not tq.proyecto(proyecto_id):
        raise _no(404, "No existe ese proyecto.")
    if not tq.es_lider(proyecto_id, yo["id"]):
        raise _no(403, "Solo el líder puede hacer esto.")
    canales = tq.canales_de_proyecto(proyecto_id)
    miembros = tq.miembros_de_proyecto(proyecto_id)
    claves = tq.claves_r2_de_canales(canales)
    tq.borrar_proyecto(proyecto_id)
    _borrar_de_r2(claves)
    for cid in canales:
        hub.a_usuarios(miembros, {"tipo": "canal_borrado", "canal_id": cid})
    return Response(status_code=204)


# ── Miembros ───────────────────────────────────────────────────────────────

@router.get("/api/team/projects/{proyecto_id}/members")
async def listar_miembros(proyecto_id: str, yo: dict[str, Any] = Depends(cookie_auth_required)):
    if not tq.proyecto(proyecto_id):
        raise _no(404, "No existe ese proyecto.")
    if not tq.es_miembro(proyecto_id, yo["id"]):
        raise _no(403, "No perteneces a este proyecto.")
    return tq.proyecto_salida(proyecto_id, yo["id"], hub.estado_publico)["miembros"]


@router.post("/api/team/projects/{proyecto_id}/members", status_code=201)
async def invitar_miembro(proyecto_id: str, cuerpo: MiembroNuevo,
                          yo: dict[str, Any] = Depends(cookie_auth_required)):
    if not tq.proyecto(proyecto_id):
        raise _no(404, "No existe ese proyecto.")
    if not tq.es_lider(proyecto_id, yo["id"]):
        raise _no(403, "Solo el líder gestiona los miembros.")
    invitado = tq.buscar_usuario(cuerpo.identificador)
    if not invitado:
        raise _no(404, "No hay ningún usuario con ese correo o nombre.")
    if not tq.anadir_miembro(proyecto_id, invitado["id"]):
        raise _no(409, "Ya está en el proyecto.")
    miembro = {"usuario": invitado, "rol": "integrante",
               "estado": hub.estado_publico(invitado["id"])}
    _emitir_proyecto(proyecto_id, {"tipo": "miembro_entra", "proyecto_id": proyecto_id,
                                   "miembro": miembro})
    # Al recién llegado se le manda el proyecto entero: acaba de aparecerle uno
    # nuevo y con un solo miembro no tendría con qué pintarlo.
    hub.a_usuario(invitado["id"], {
        "tipo": "proyecto_actualizado",
        "proyecto": tq.proyecto_salida(proyecto_id, invitado["id"], hub.estado_publico),
    })
    return miembro


@router.delete("/api/team/projects/{proyecto_id}/members/{usuario_id}", status_code=204)
async def quitar_miembro(proyecto_id: str, usuario_id: int,
                         yo: dict[str, Any] = Depends(cookie_auth_required)):
    p = tq.proyecto(proyecto_id)
    if not p:
        raise _no(404, "No existe ese proyecto.")
    if not tq.es_lider(proyecto_id, yo["id"]):
        raise _no(403, "Solo el líder gestiona los miembros.")
    if usuario_id == p["lider_id"]:
        raise _no(400, "El líder no puede salir de su propio proyecto.")
    tq.quitar_miembro(proyecto_id, usuario_id)
    aviso = {"tipo": "miembro_sale", "proyecto_id": proyecto_id, "usuario_id": usuario_id}
    _emitir_proyecto(proyecto_id, aviso)
    hub.a_usuario(usuario_id, aviso)   # ya no está en la lista: hay que avisarle aparte
    return Response(status_code=204)


# ── Canales ────────────────────────────────────────────────────────────────

@router.post("/api/team/projects/{proyecto_id}/channels", status_code=201)
async def crear_canal(proyecto_id: str, cuerpo: CanalNuevo,
                      yo: dict[str, Any] = Depends(cookie_auth_required)):
    if not tq.proyecto(proyecto_id):
        raise _no(404, "No existe ese proyecto.")
    if not tq.es_miembro(proyecto_id, yo["id"]):
        raise _no(403, "No perteneces a este proyecto.")
    nombre = cuerpo.nombre.strip().lstrip("#")
    if not nombre:
        raise _no(400, "El canal necesita un nombre.")
    tipo = "privado" if cuerpo.tipo == "privado" else "publico"
    if tipo == "privado" and not tq.es_lider(proyecto_id, yo["id"]):
        raise _no(403, "Solo el líder crea canales privados.")
    cid = tq.crear_canal(proyecto_id, nombre, tipo, cuerpo.tema or "", yo["id"])
    for uid in tq.miembros_de_canal(cid):
        hub.a_usuario(uid, {"tipo": "canal_creado",
                            "canal": tq.canal_salida(cid, uid, hub.estado_publico)})
    return tq.canal_salida(cid, yo["id"], hub.estado_publico)


@router.patch("/api/team/channels/{canal_id}")
async def editar_canal(canal_id: str, cuerpo: CanalCambios,
                       yo: dict[str, Any] = Depends(cookie_auth_required)):
    c = _canal_o_404(canal_id, yo["id"])
    if c["tipo"] == "directo":
        raise _no(400, "Un directo no se edita.")
    if not tq.es_lider(c["proyecto_id"], yo["id"]):
        raise _no(403, "Solo el líder.")
    cambios = cuerpo.model_dump(exclude_unset=True)
    if "nombre" in cambios and cambios["nombre"]:
        cambios["nombre"] = cambios["nombre"].strip().lstrip("#")
    tq.editar_canal(canal_id, cambios)
    for uid in tq.miembros_de_canal(canal_id):
        hub.a_usuario(uid, {"tipo": "canal_creado",
                            "canal": tq.canal_salida(canal_id, uid, hub.estado_publico)})
    return tq.canal_salida(canal_id, yo["id"], hub.estado_publico)


@router.delete("/api/team/channels/{canal_id}", status_code=204)
async def borrar_canal(canal_id: str, yo: dict[str, Any] = Depends(cookie_auth_required)):
    c = _canal_o_404(canal_id, yo["id"])
    if c["tipo"] == "directo":
        raise _no(400, "Un directo no se borra.")
    if not tq.es_lider(c["proyecto_id"], yo["id"]):
        raise _no(403, "Solo el líder.")
    claves = tq.claves_r2_de_canales([canal_id])
    # El aviso sale ANTES del borrado: después ya no habría de quién sacar la
    # lista de miembros a los que avisar.
    _emitir_canal(canal_id, {"tipo": "canal_borrado", "canal_id": canal_id})
    tq.borrar_canal(canal_id)
    _borrar_de_r2(claves)
    return Response(status_code=204)


@router.post("/api/team/channels/{canal_id}/members", status_code=201)
async def sumar_a_canal(canal_id: str, cuerpo: UsuarioRef,
                        yo: dict[str, Any] = Depends(cookie_auth_required)):
    c = tq.canal(canal_id)
    if not c:
        raise _no(404, "No existe ese canal.")
    if c["tipo"] != "privado":
        raise _no(400, "Solo los canales privados tienen lista propia.")
    if not tq.es_lider(c["proyecto_id"], yo["id"]):
        raise _no(403, "Solo el líder.")
    if not tq.es_miembro(c["proyecto_id"], cuerpo.usuario_id):
        raise _no(400, "No es miembro del proyecto.")
    if tq.sumar_a_canal(canal_id, cuerpo.usuario_id):
        hub.a_usuario(cuerpo.usuario_id, {
            "tipo": "canal_creado",
            "canal": tq.canal_salida(canal_id, cuerpo.usuario_id, hub.estado_publico)})
    return tq.canal_salida(canal_id, yo["id"], hub.estado_publico)


@router.delete("/api/team/channels/{canal_id}/members/{usuario_id}", status_code=204)
async def sacar_de_canal(canal_id: str, usuario_id: int,
                         yo: dict[str, Any] = Depends(cookie_auth_required)):
    c = tq.canal(canal_id)
    if not c:
        raise _no(404, "No existe ese canal.")
    if c["tipo"] != "privado":
        raise _no(400, "Solo los canales privados tienen lista propia.")
    if not tq.es_lider(c["proyecto_id"], yo["id"]):
        raise _no(403, "Solo el líder.")
    hub.a_usuario(usuario_id, {"tipo": "canal_borrado", "canal_id": canal_id})
    tq.sacar_de_canal(canal_id, usuario_id)
    return Response(status_code=204)


# ── Mensajes ───────────────────────────────────────────────────────────────

@router.get("/api/team/channels/{canal_id}/messages")
async def listar_mensajes(canal_id: str, peticion: Request, antes_de: int = 0,
                          limite: int = 50, hilo_de: str = "",
                          yo: dict[str, Any] = Depends(cookie_auth_required)):
    _canal_o_404(canal_id, yo["id"])
    limite = max(1, min(limite, LIMITE_MENSAJES))
    return tq.listar_mensajes(canal_id, antes_de, limite, hilo_de,
                              _firmante(_base_publico(peticion)))


@router.post("/api/team/channels/{canal_id}/messages")
async def enviar_mensaje(canal_id: str, cuerpo: MensajeNuevo, peticion: Request,
                         yo: dict[str, Any] = Depends(cookie_auth_required)):
    _canal_o_404(canal_id, yo["id"])
    texto = (cuerpo.texto or "").strip()
    adjuntos = list(cuerpo.adjuntos or [])

    # Un hilo tiene UN SOLO NIVEL: responder a una respuesta responde al mismo
    # hilo. Se normaliza aquí y no en el cliente porque un cliente manipulado
    # montaría un árbol de profundidad libre, que es justo el problema que el
    # hilo venía a resolver. Y la raíz tiene que ser de ESTE canal, o se colaría
    # una respuesta en una conversación que su autor no puede ni ver.
    responde_a = None
    if cuerpo.responde_a:
        citado = tq.mensaje(cuerpo.responde_a)
        if not citado or citado["canal_id"] != canal_id:
            raise _no(400, "No se puede responder a ese mensaje.")
        responde_a = citado["responde_a"] or citado["id"]

    # Una foto sin comentario es lo normal: solo se exige texto si no hay nada
    # más que enseñar.
    if not texto and not adjuntos:
        raise _no(400, "El mensaje está vacío.")
    if len(adjuntos) > MAX_POR_MENSAJE:
        raise _no(400, f"Como mucho {MAX_POR_MENSAJE} adjuntos por mensaje.")
    # REGLA 7 — solo adjuntos propios, de este canal y sin usar.
    if not tq.adjuntos_validos(adjuntos, canal_id, yo["id"]):
        raise _no(400, "Alguno de los adjuntos no vale para este mensaje.")

    mid, nuevo = tq.crear_mensaje(canal_id, yo["id"], cuerpo.client_id.strip(),
                                  texto, adjuntos, responde_a)
    firmar = _firmante(_base_publico(peticion))
    salida = tq.mensaje_salida(mid, firmar)

    if nuevo:
        # El contador de la raíz viaja CON la respuesta y no en un evento
        # aparte: en dos eventos, quien recibiera solo el primero tendría doce
        # respuestas en la lista y un contador que dice once.
        extra = {"resumen_hilo": tq.resumen_hilo(responde_a)} if responde_a else {}
        _emitir_canal(canal_id, {"tipo": "mensaje", "canal_id": canal_id,
                                 "mensaje": salida, **extra}, excepto=yo["id"])
        hub.a_usuario(yo["id"], {"tipo": "mensaje_ack", "canal_id": canal_id,
                                 "client_id": cuerpo.client_id.strip(),
                                 "mensaje": salida, **extra})
    return JSONResponse(salida, status_code=201 if nuevo else 200)


@router.patch("/api/team/messages/{mensaje_id}")
async def editar_mensaje(mensaje_id: str, cuerpo: MensajeCambios, peticion: Request,
                         yo: dict[str, Any] = Depends(cookie_auth_required)):
    m = tq.mensaje(mensaje_id)
    # Un mensaje que no se puede ver no puede confirmarse que exista.
    if not m or not tq.puede_ver_canal(m["canal_id"], yo["id"]):
        raise _no(404, "No existe ese mensaje.")
    # REGLA 8 — editar y borrar son del autor, de nadie más. No del líder del
    # proyecto, no de quien esté en el canal. El cliente esconde los botones,
    # pero eso es comodidad: la barrera está aquí.
    if m["autor_id"] != yo["id"]:
        raise _no(403, "Solo puedes tocar tus propios mensajes.")
    if m["borrado_en"]:
        raise _no(400, "Ese mensaje ya está borrado.")

    texto = (cuerpo.texto or "").strip()
    if not texto and not tq.claves_r2_de_mensaje(mensaje_id):
        raise _no(400, "El mensaje se quedaría vacío. Bórralo si es lo que quieres.")

    tq.editar_mensaje(mensaje_id, texto)
    salida = tq.mensaje_salida(mensaje_id, _firmante(_base_publico(peticion)))
    _emitir_canal(m["canal_id"], {"tipo": "mensaje_editado", "canal_id": m["canal_id"],
                                  "mensaje": salida})
    return salida


@router.delete("/api/team/messages/{mensaje_id}")
async def borrar_mensaje(mensaje_id: str, peticion: Request,
                         yo: dict[str, Any] = Depends(cookie_auth_required)):
    m = tq.mensaje(mensaje_id)
    if not m or not tq.puede_ver_canal(m["canal_id"], yo["id"]):
        raise _no(404, "No existe ese mensaje.")
    if m["autor_id"] != yo["id"]:
        raise _no(403, "Solo puedes tocar tus propios mensajes.")

    # REGLA 10 — una raíz CON respuestas deja lápida. Borrarla de verdad dejaría
    # doce respuestas colgando de una pregunta que ya no existe, o —peor—
    # obligaría a borrarlas también, que es tirar lo que escribieron otros. Una
    # sin respuestas sí se va entera: no hay nada que quede huérfano.
    lapida = not m["responde_a"] and tq.tiene_respuestas(mensaje_id)

    claves = tq.claves_r2_de_mensaje(mensaje_id)
    tq.borrar_adjuntos_de_mensaje(mensaje_id)
    _borrar_de_r2(claves)

    salida = None
    if lapida:
        tq.poner_lapida(mensaje_id)
        salida = tq.mensaje_salida(mensaje_id, _firmante(_base_publico(peticion)))
    else:
        tq.borrar_mensaje(mensaje_id)

    _emitir_canal(m["canal_id"], {
        "tipo": "mensaje_borrado",
        "canal_id": m["canal_id"],
        "mensaje_id": mensaje_id,
        "responde_a": m["responde_a"],
        "mensaje": salida,
        # Si era una respuesta, el contador de su raíz acaba de bajar.
        "resumen_hilo": tq.resumen_hilo(m["responde_a"]) if m["responde_a"] else None,
    })
    if salida:
        return salida
    return Response(status_code=204)


# ── Directos, amigos y búsqueda ────────────────────────────────────────────

@router.get("/api/team/dms")
async def listar_directos(yo: dict[str, Any] = Depends(cookie_auth_required)):
    return [tq.canal_salida(cid, yo["id"], hub.estado_publico)
            for cid in tq.directos_de(yo["id"])]


@router.post("/api/team/dms", status_code=201)
async def abrir_directo(cuerpo: UsuarioRef, yo: dict[str, Any] = Depends(cookie_auth_required)):
    otro = tq.usuario_publico_por_id(cuerpo.usuario_id)
    if not otro:
        raise _no(404, "No existe ese usuario.")
    # Solo con quien comparte proyecto o es amigo aceptado. No es una regla de
    # interfaz: el servidor lo comprueba.
    if cuerpo.usuario_id not in tq.relacionados(yo["id"]):
        raise _no(403, "Solo puedes escribir a compañeros de proyecto o amigos.")
    cid, nuevo = tq.abrir_directo(yo["id"], cuerpo.usuario_id)
    if nuevo:
        hub.a_usuario(cuerpo.usuario_id, {
            "tipo": "canal_creado",
            "canal": tq.canal_salida(cid, cuerpo.usuario_id, hub.estado_publico)})
    return tq.canal_salida(cid, yo["id"], hub.estado_publico)


@router.get("/api/team/users/search")
async def buscar_usuarios(q: str = "", yo: dict[str, Any] = Depends(cookie_auth_required)):
    if len(q.strip()) < 2:
        return []
    return tq.buscar_usuarios(q, yo["id"])


@router.get("/api/team/friends")
async def listar_amigos(yo: dict[str, Any] = Depends(cookie_auth_required)):
    return tq.amigos_de(yo["id"])


@router.post("/api/team/friends/requests", status_code=201)
async def pedir_amistad(cuerpo: MiembroNuevo, yo: dict[str, Any] = Depends(cookie_auth_required)):
    otro = tq.buscar_usuario(cuerpo.identificador)
    if not otro:
        raise _no(404, "No hay ningún usuario con ese correo o nombre.")
    if otro["id"] == yo["id"]:
        raise _no(400, "No puedes agregarte a ti mismo.")
    if tq.amistad_entre(yo["id"], otro["id"]):
        raise _no(409, "Ya hay una solicitud o amistad con esa persona.")
    tq.pedir_amistad(yo["id"], otro["id"])
    hub.a_usuario(otro["id"], {"tipo": "amistad", "accion": "solicitud",
                               "usuario": tq.usuario_publico_por_id(yo["id"])})
    return {"usuario": otro, "direccion": "enviada"}


@router.post("/api/team/friends/requests/{usuario_id}/accept")
async def aceptar_amistad(usuario_id: int, yo: dict[str, Any] = Depends(cookie_auth_required)):
    if not tq.aceptar_amistad(usuario_id, yo["id"]):
        raise _no(404, "No hay ninguna solicitud de esa persona.")
    hub.a_usuario(usuario_id, {"tipo": "amistad", "accion": "aceptada",
                               "usuario": tq.usuario_publico_por_id(yo["id"])})
    return {"usuario": tq.usuario_publico_por_id(usuario_id), "estado": "aceptada"}


@router.delete("/api/team/friends/{usuario_id}", status_code=204)
async def quitar_amigo(usuario_id: int, yo: dict[str, Any] = Depends(cookie_auth_required)):
    tq.quitar_amistad(yo["id"], usuario_id)
    return Response(status_code=204)


# ── Presencia ──────────────────────────────────────────────────────────────

@router.put("/api/team/presence")
async def poner_presencia(cuerpo: PresenciaNueva,
                          yo: dict[str, Any] = Depends(cookie_auth_required)):
    if cuerpo.estado not in tq.ESTADOS:
        raise _no(400, "Estado desconocido.")
    hub.poner_estado(yo["id"], cuerpo.estado)
    _difundir_presencia(yo["id"])
    return {"estado": cuerpo.estado}


# ── Adjuntos ───────────────────────────────────────────────────────────────

def _limpiar_nombre(nombre: str) -> str:
    """Quita rutas y caracteres raros: el nombre se enseña y se usa al
    descargar."""
    base = re.split(r"[\\/]", str(nombre or "archivo"))[-1]
    return re.sub(r'[\x00-\x1f<>:"|?*]', "_", base)[:120] or "archivo"


def _extension(nombre: str) -> str:
    punto = nombre.rfind(".")
    return nombre[punto:].lower() if punto >= 0 else ""


def _tipo_por_contenido(datos: bytes, mime_declarado: str = "") -> tuple[str, str]:
    """El tipo se decide por el CONTENIDO, no por la extensión ni por el mime
    que declare el cliente. Un `.png` que no empieza por la firma PNG no es una
    imagen, y tratarlo como tal es lo que convierte una subida en un problema."""
    def asc(desde: int, hasta: int) -> bytes:
        return datos[desde:hasta]

    if datos[:8] == b"\x89PNG\r\n\x1a\n":
        return "imagen", "image/png"
    if datos[:3] == b"\xff\xd8\xff":
        return "imagen", "image/jpeg"
    if datos[:3] == b"GIF":
        return "imagen", "image/gif"
    if asc(0, 4) == b"RIFF" and asc(8, 12) == b"WEBP":
        return "imagen", "image/webp"
    if asc(0, 4) == b"<svg" or asc(0, 5) == b"<?xml":
        # Un SVG es un documento con scripts dentro: nunca como imagen.
        return "archivo", "application/octet-stream"
    if asc(0, 4) == b"RIFF" and asc(8, 12) == b"WAVE":
        return "audio", "audio/wav"
    if asc(0, 4) == b"OggS":
        return "audio", "audio/ogg"
    if asc(0, 3) == b"ID3" or datos[:2] == b"\xff\xfb":
        return "audio", "audio/mpeg"
    if asc(4, 8) == b"ftyp":
        return "video", "video/mp4"
    if datos[:4] == b"\x1a\x45\xdf\xa3":
        # Matroska sirve para las dos cosas; el mime declarado es la única pista
        # de si es una nota de voz o un vídeo.
        if re.match(r"^audio/", mime_declarado or "", re.I):
            return "audio", "audio/webm"
        return "video", "video/webm"
    if asc(0, 4) == b"%PDF":
        return "archivo", "application/pdf"
    return "archivo", "application/octet-stream"


@router.post("/api/team/attachments", status_code=201)
async def subir_adjunto(
    peticion: Request,
    file: UploadFile = File(...),
    canal_id: str = Form(...),
    ancho: int | None = Form(default=None),
    alto: int | None = Form(default=None),
    duracion_ms: int | None = Form(default=None),
    yo: dict[str, Any] = Depends(cookie_auth_required),
):
    """Se sube ANTES de mandar el mensaje. REGLA 5 — el adjunto queda ligado a
    un canal, y solo sus miembros podrán obtener una URL: un id no es una
    credencial, y adivinarlo no puede dar acceso a nada."""
    if not r2_configured():
        raise _no(503, "El almacén de archivos no está configurado.")
    _canal_o_404(canal_id, yo["id"])

    trozos: list[bytes] = []
    total = 0
    while True:
        trozo = await file.read(1024 * 256)
        if not trozo:
            break
        total += len(trozo)
        if total > MAX_ADJUNTO:
            raise _no(413, "El archivo supera el límite de 25 MB.")
        trozos.append(trozo)
    datos = b"".join(trozos)
    if not datos:
        raise _no(400, "El archivo está vacío.")

    nombre = _limpiar_nombre(file.filename or "archivo")
    if _extension(nombre) in EXT_PROHIBIDAS:
        raise _no(415, "Ese tipo de archivo no se puede enviar.")

    tipo, mime = _tipo_por_contenido(datos, file.content_type or "")
    clave = f"team/{canal_id}/{secrets.token_hex(16)}"
    try:
        r2.upload_bytes(clave, datos, mime)
    except Exception as exc:  # noqa: BLE001
        logger.error("[team] fallo al subir adjunto a R2: %s", exc)
        raise _no(502, "No se pudo guardar el archivo.") from exc

    aid = tq.crear_adjunto(canal_id, yo["id"], tipo, nombre, mime, len(datos), clave,
                           ancho, alto, duracion_ms)
    a = tq.adjunto(aid)
    url, caduca = _firmante(_base_publico(peticion))(aid)
    return {"id": aid, "tipo": a["tipo"], "nombre": a["nombre"], "mime": a["mime"],
            "bytes": a["bytes"], "url": url, "caduca_en": caduca,
            "ancho": a["ancho"], "alto": a["alto"], "duracion_ms": a["duracion_ms"]}


@router.get("/api/team/attachments/{adjunto_id}/url")
async def renovar_url(adjunto_id: str, peticion: Request,
                      yo: dict[str, Any] = Depends(cookie_auth_required)):
    a = tq.adjunto(adjunto_id)
    if not a or not tq.puede_ver_canal(a["canal_id"], yo["id"]):
        raise _no(404, "No existe ese adjunto.")
    url, caduca = _firmante(_base_publico(peticion))(adjunto_id)
    return {"url": url, "caduca_en": caduca}


@router.get("/api/team/attachments/{adjunto_id}")
async def servir_adjunto(adjunto_id: str, exp: str = "", sig: str = ""):
    """Sin cabeceras: la autorización va en la firma de la URL (regla 6).

    Se contesta con un 302 a una URL prefirmada de R2 en vez de hacer de proxy:
    un vídeo de veinte megas atravesando el gateway cuesta memoria y tiempo, y
    —lo que de verdad importa para reproducirlo— R2 sí sabe contestar peticiones
    por rango, que es lo que necesita el navegador para poder saltar en la
    barra de reproducción."""
    if not _firma_valida(adjunto_id, exp, sig):
        raise _no(403, "El enlace caducó o no es válido.")
    a = tq.adjunto(adjunto_id)
    if not a:
        raise _no(404, "No existe ese adjunto.")
    try:
        return RedirectResponse(r2.presigned_get_url(a["clave_r2"]), status_code=302)
    except Exception as exc:  # noqa: BLE001
        logger.error("[team] no se pudo firmar la descarga de %s: %s", adjunto_id, exc)
        raise _no(502, "No se pudo servir el archivo.") from exc


# ── WebSocket ──────────────────────────────────────────────────────────────

@router.websocket("/ws/team")
async def ws_team(websocket: WebSocket):
    """Un solo canal bidireccional para todo lo que ocurre en vivo.

    La llave viaja en la query porque el navegador no deja poner cabeceras en un
    `new WebSocket`. Por eso NUNCA se registra la URL completa: en los logs solo
    entra el id del usuario."""
    llave = websocket.query_params.get("token", "")
    usuario = validate_api_key(llave) if llave else None
    if not usuario:
        await websocket.close(code=4401)
        return

    uid = usuario["id"]
    await websocket.accept()
    con = hub.entrar(uid)
    # `base_url` de un WebSocket viene con esquema ws:// o wss://, y las URLs de
    # los adjuntos las va a pedir un `<img src>`: tienen que ser http(s).
    base = PUBLIC_BASE_URL or re.sub(r"^ws", "http", str(websocket.base_url).rstrip("/"))
    firmar = _firmante(base)

    # Conectarse pone en línea, salvo que la persona haya elegido otra cosa
    # (no molestar, invisible): eso lo decide ella, no el hecho de abrir el IDE.
    if hub.estado_real(uid) == "desconectado":
        hub.poner_estado(uid, "en_linea")
    _difundir_presencia(uid)
    logger.info("[team] conectado usuario %s (%s conexiones)", uid, hub.cuantas(uid))

    async def bombear():
        """Saca de la cola y escribe. Separado del bucle de lectura porque un
        cliente que no lee no puede bloquear al que escribe."""
        while True:
            evento = await con.cola.get()
            await websocket.send_text(json.dumps(evento, ensure_ascii=False))

    salida = asyncio.create_task(bombear())
    try:
        while True:
            crudo = await websocket.receive_text()
            try:
                ev = json.loads(crudo)
            except (ValueError, TypeError):
                continue  # un marco ilegible no debe tirar la conexión
            await _marco_entrante(ev, uid, con, firmar)
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        logger.warning("[team] conexión de %s cerrada por error: %s", uid, exc)
    finally:
        salida.cancel()
        # Solo se marca desconectado al cerrarse la ÚLTIMA: con el IDE y la
        # ventana de Team abiertos a la vez, cerrar una no apaga a nadie.
        if hub.salir(con):
            hub.poner_estado(uid, "desconectado")
            _difundir_presencia(uid)
        logger.info("[team] desconectado usuario %s", uid)


async def _marco_entrante(ev: dict[str, Any], uid: int, con, firmar) -> None:
    tipo = ev.get("tipo")

    if tipo == "ping":
        con.poner({"tipo": "pong"})
        return

    if tipo == "hola":
        # REGLA 2 — replay desde los cursores del cliente. Nunca se reenvía el
        # historial entero: solo lo que se perdió mientras no estaba.
        cursores = ev.get("cursores") or {}
        if not isinstance(cursores, dict):
            cursores = {}
        eventos = tq.replay(uid, cursores, firmar)
        for evento in eventos:
            con.poner(evento)
        con.poner({"tipo": "listo", "yo": tq.usuario_publico_por_id(uid),
                   "reproducidos": len(eventos)})
        return

    if tipo == "escribiendo":
        canal_id = str(ev.get("canal_id") or "")
        if canal_id and tq.puede_ver_canal(canal_id, uid):
            _emitir_canal(canal_id, {"tipo": "escribiendo", "canal_id": canal_id,
                                     "usuario_id": uid}, excepto=uid)
        return

    if tipo == "presencia":
        estado = ev.get("estado")
        if estado in tq.ESTADOS:
            hub.poner_estado(uid, estado)
            _difundir_presencia(uid)
        return


# ── Mantenimiento ──────────────────────────────────────────────────────────

def purgar_adjuntos_huerfanos() -> int:
    """Los que se subieron y nunca llegaron a un mensaje: alguien eligió una
    foto y cerró la ventana antes de enviarla. Lo llama el cron de `app.py`."""
    claves = tq.purgar_adjuntos_huerfanos()
    _borrar_de_r2(claves)
    return len(claves)
