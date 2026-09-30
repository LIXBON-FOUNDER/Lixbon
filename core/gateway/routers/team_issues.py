"""
team_issues.py — Las issues propias de Lixbon Team en el gateway.

Rutas bajo `/api/team/*` con la misma sesión que el resto de Team (cookie en
team.lixbon.com, Bearer en el IDE). Cada cambio sale en vivo por `/ws/team` a
todo el equipo:

- `{"tipo": "issue", "accion": "guardada", "issue": {...}}` al crear o cambiar;
- `{"tipo": "issue", "accion": "borrada", "issue_id": ...}` al borrar;
- `{"tipo": "issue_comentario", "accion": "creado"|"borrado", ...}`;
- `proyecto_actualizado` cuando cambian estados, etiquetas, ciclos, proyectos
  o ajustes, que viajan en el `tablero` de cada proyecto.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from core.gateway.team_hub import hub
from core.persistence import team_issues as ti
from core.persistence import team_queries as tq
from core.security.auth import cookie_auth_required

router = APIRouter()


def _ejecutar(fn, *args):
    try:
        return fn(*args)
    except ti.ErrorIssues as e:
        raise HTTPException(status_code=e.codigo, detail=e.detalle)


def _emitir_issue(proyecto_id: str, issue_id: str) -> dict[str, Any] | None:
    r = ti.resumen(issue_id)
    if r:
        hub.a_usuarios(ti.miembros(proyecto_id), {
            "tipo": "issue", "accion": "guardada", "proyecto_id": proyecto_id, "issue": r})
    return r


def _emitir_tablero(proyecto_id: str) -> None:
    """Cada miembro recibe SU vista del proyecto, como en el resto de Team."""
    for uid in tq.miembros_de_proyecto(proyecto_id):
        hub.a_usuario(uid, {"tipo": "proyecto_actualizado",
                            "proyecto": tq.proyecto_salida(proyecto_id, uid, hub.estado_publico)})


# ── Cuerpos ────────────────────────────────────────────────────────────────

class IssueNueva(BaseModel):
    titulo: str = Field(..., min_length=1, max_length=200)
    descripcion: str = Field(default="", max_length=20000)
    estado_id: str | None = None
    prioridad: int = 0
    estimacion: int | None = None
    asignado_id: int | None = None
    agente_rol: str | None = None
    ciclo_id: str | None = None
    iniciativa_id: str | None = None
    padre_id: str | None = None
    fecha_limite: str | None = None
    etiquetas: list[str] = Field(default_factory=list)


class IssueCambios(BaseModel):
    titulo: str | None = Field(default=None, min_length=1, max_length=200)
    descripcion: str | None = Field(default=None, max_length=20000)
    estado_id: str | None = None
    prioridad: int | None = None
    estimacion: int | None = None
    asignado_id: int | None = None
    agente_rol: str | None = None
    ciclo_id: str | None = None
    iniciativa_id: str | None = None
    padre_id: str | None = None
    fecha_limite: str | None = None
    orden: float | None = None
    etiquetas: list[str] | None = None


class ComentarioNuevo(BaseModel):
    texto: str = Field(..., min_length=1, max_length=20000)
    de_agente: str | None = None


class VinculoNuevo(BaseModel):
    tipo: str
    ref: str = Field(..., min_length=1, max_length=200)
    estado: str | None = None
    url: str | None = None


class EstadoNuevo(BaseModel):
    nombre: str = Field(..., min_length=1, max_length=40)
    tipo: str
    color: str | None = None


class EstadoCambios(BaseModel):
    nombre: str | None = Field(default=None, min_length=1, max_length=40)
    color: str | None = None
    orden: float | None = None


class EtiquetaNueva(BaseModel):
    nombre: str = Field(..., min_length=1, max_length=40)
    color: str | None = None


class EtiquetaCambios(BaseModel):
    nombre: str | None = Field(default=None, min_length=1, max_length=40)
    color: str | None = None


class IniciativaNueva(BaseModel):
    nombre: str = Field(..., min_length=1, max_length=60)
    color: str | None = None
    responsable_id: int | None = None
    objetivo: str | None = None
    estado: str | None = None


class IniciativaCambios(BaseModel):
    nombre: str | None = Field(default=None, min_length=1, max_length=60)
    color: str | None = None
    responsable_id: int | None = None
    objetivo: str | None = None
    estado: str | None = None


class Ajustes(BaseModel):
    prefijo: str | None = None
    ciclos: dict[str, Any] | None = None
    estimacion: str | None = None
    automatismos: dict[str, bool] | None = None


# ── Issues ─────────────────────────────────────────────────────────────────

@router.get("/api/team/projects/{proyecto_id}/issues")
async def listar(proyecto_id: str, yo: dict[str, Any] = Depends(cookie_auth_required)):
    return _ejecutar(ti.listar_issues, proyecto_id, yo["id"])


@router.post("/api/team/projects/{proyecto_id}/issues", status_code=201)
async def crear(proyecto_id: str, cuerpo: IssueNueva, yo: dict[str, Any] = Depends(cookie_auth_required)):
    iid = _ejecutar(ti.crear_issue, proyecto_id, yo["id"], cuerpo.model_dump())
    return _emitir_issue(proyecto_id, iid)


@router.get("/api/team/issues/buscar")
async def buscar(clave: str, yo: dict[str, Any] = Depends(cookie_auth_required)):
    r = ti.buscar_por_clave(yo["id"], clave)
    if not r:
        raise HTTPException(status_code=404, detail="No existe esa issue.")
    return r


@router.get("/api/team/issues/{issue_id}")
async def ver(issue_id: str, yo: dict[str, Any] = Depends(cookie_auth_required)):
    return _ejecutar(ti.detalle, issue_id, yo["id"])


@router.patch("/api/team/issues/{issue_id}")
async def editar(issue_id: str, cuerpo: IssueCambios, yo: dict[str, Any] = Depends(cookie_auth_required)):
    pid = _ejecutar(ti.editar_issue, issue_id, yo["id"], cuerpo.model_dump(exclude_unset=True))
    return _emitir_issue(pid, issue_id)


@router.delete("/api/team/issues/{issue_id}", status_code=204)
async def borrar(issue_id: str, yo: dict[str, Any] = Depends(cookie_auth_required)):
    pid = _ejecutar(ti.borrar_issue, issue_id, yo["id"])
    hub.a_usuarios(ti.miembros(pid), {"tipo": "issue", "accion": "borrada",
                                      "proyecto_id": pid, "issue_id": issue_id})
    return Response(status_code=204)


@router.post("/api/team/issues/{issue_id}/comments", status_code=201)
async def comentar(issue_id: str, cuerpo: ComentarioNuevo,
                   yo: dict[str, Any] = Depends(cookie_auth_required)):
    pid, c = _ejecutar(ti.comentar, issue_id, yo["id"], cuerpo.texto, cuerpo.de_agente)
    hub.a_usuarios(ti.miembros(pid), {"tipo": "issue_comentario", "accion": "creado",
                                      "proyecto_id": pid, "issue_id": issue_id, "comentario": c})
    _emitir_issue(pid, issue_id)
    return c


@router.delete("/api/team/issue-comments/{comentario_id}", status_code=204)
async def borrar_comentario(comentario_id: str, yo: dict[str, Any] = Depends(cookie_auth_required)):
    pid, iid = _ejecutar(ti.borrar_comentario, comentario_id, yo["id"])
    hub.a_usuarios(ti.miembros(pid), {"tipo": "issue_comentario", "accion": "borrado",
                                      "proyecto_id": pid, "issue_id": iid,
                                      "comentario_id": comentario_id})
    _emitir_issue(pid, iid)
    return Response(status_code=204)


@router.post("/api/team/issues/{issue_id}/links", status_code=201)
async def vincular(issue_id: str, cuerpo: VinculoNuevo, yo: dict[str, Any] = Depends(cookie_auth_required)):
    pid = _ejecutar(ti.vincular, issue_id, yo["id"], cuerpo.tipo, cuerpo.ref, cuerpo.estado, cuerpo.url)
    return _emitir_issue(pid, issue_id)


# ── Tablero del equipo ─────────────────────────────────────────────────────

@router.patch("/api/team/projects/{proyecto_id}/issue-settings")
async def ajustes(proyecto_id: str, cuerpo: Ajustes, yo: dict[str, Any] = Depends(cookie_auth_required)):
    _ejecutar(ti.editar_ajustes, proyecto_id, yo["id"], cuerpo.model_dump(exclude_none=True))
    _emitir_tablero(proyecto_id)
    return tq.proyecto_salida(proyecto_id, yo["id"], hub.estado_publico)["tablero"]


@router.post("/api/team/projects/{proyecto_id}/states", status_code=201)
async def crear_estado(proyecto_id: str, cuerpo: EstadoNuevo,
                       yo: dict[str, Any] = Depends(cookie_auth_required)):
    _ejecutar(ti.crear_estado, proyecto_id, yo["id"], cuerpo.nombre, cuerpo.tipo, cuerpo.color)
    _emitir_tablero(proyecto_id)
    return Response(status_code=201)


@router.patch("/api/team/states/{estado_id}")
async def editar_estado(estado_id: str, cuerpo: EstadoCambios,
                        yo: dict[str, Any] = Depends(cookie_auth_required)):
    pid = _ejecutar(ti.editar_estado, estado_id, yo["id"], cuerpo.model_dump(exclude_unset=True))
    _emitir_tablero(pid)
    return Response(status_code=204)


@router.delete("/api/team/states/{estado_id}", status_code=204)
async def borrar_estado(estado_id: str, mover_a: str | None = None,
                        yo: dict[str, Any] = Depends(cookie_auth_required)):
    pid = _ejecutar(ti.borrar_estado, estado_id, yo["id"], mover_a)
    _emitir_tablero(pid)
    for i in ti.listar_issues(pid, yo["id"]):
        if i["estado_id"] == mover_a:
            _emitir_issue(pid, i["id"])
    return Response(status_code=204)


@router.post("/api/team/projects/{proyecto_id}/labels", status_code=201)
async def crear_etiqueta(proyecto_id: str, cuerpo: EtiquetaNueva,
                         yo: dict[str, Any] = Depends(cookie_auth_required)):
    e = _ejecutar(ti.crear_etiqueta, proyecto_id, yo["id"], cuerpo.nombre, cuerpo.color)
    _emitir_tablero(proyecto_id)
    return e


@router.patch("/api/team/labels/{etiqueta_id}")
async def editar_etiqueta(etiqueta_id: str, cuerpo: EtiquetaCambios,
                          yo: dict[str, Any] = Depends(cookie_auth_required)):
    pid = _ejecutar(ti.editar_etiqueta, etiqueta_id, yo["id"], cuerpo.model_dump(exclude_unset=True))
    _emitir_tablero(pid)
    return Response(status_code=204)


@router.delete("/api/team/labels/{etiqueta_id}", status_code=204)
async def borrar_etiqueta(etiqueta_id: str, yo: dict[str, Any] = Depends(cookie_auth_required)):
    pid = _ejecutar(ti.borrar_etiqueta, etiqueta_id, yo["id"])
    _emitir_tablero(pid)
    return Response(status_code=204)


@router.post("/api/team/projects/{proyecto_id}/initiatives", status_code=201)
async def crear_iniciativa(proyecto_id: str, cuerpo: IniciativaNueva,
                           yo: dict[str, Any] = Depends(cookie_auth_required)):
    xid = _ejecutar(ti.crear_iniciativa, proyecto_id, yo["id"], cuerpo.model_dump(exclude_unset=True))
    _emitir_tablero(proyecto_id)
    return {"id": xid}


@router.patch("/api/team/initiatives/{iniciativa_id}")
async def editar_iniciativa(iniciativa_id: str, cuerpo: IniciativaCambios,
                            yo: dict[str, Any] = Depends(cookie_auth_required)):
    pid = _ejecutar(ti.editar_iniciativa, iniciativa_id, yo["id"], cuerpo.model_dump(exclude_unset=True))
    _emitir_tablero(pid)
    return Response(status_code=204)


@router.delete("/api/team/initiatives/{iniciativa_id}", status_code=204)
async def borrar_iniciativa(iniciativa_id: str, yo: dict[str, Any] = Depends(cookie_auth_required)):
    pid, tocadas = _ejecutar(ti.borrar_iniciativa, iniciativa_id, yo["id"])
    _emitir_tablero(pid)
    for iid in tocadas:
        _emitir_issue(pid, iid)
    return Response(status_code=204)
