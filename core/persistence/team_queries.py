"""
team_queries.py — Acceso a datos de Lixbon Team.

Implementa el modelo de `docs/team-protocolo.md` (repo del IDE). Vive aparte de
`queries.py` porque aquel ya son 2.200 líneas de otro dominio, y porque todo lo
de aquí comparte una sola idea: **la autorización vive en la consulta, no en la
interfaz**. `miembros_de_canal()` es la función más importante del archivo — de
ella dependen tanto las respuestas REST como a quién se le emite cada evento
(regla 3 del transporte).

Nada de esto devuelve modelos de SQLAlchemy: devuelve diccionarios ya con la
forma que sale por el cable. Así el router no tiene que saber de sesiones ni de
objetos desligados, y la forma del contrato se lee en un solo sitio.
"""
from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError

from core.persistence.database import get_session
from core.persistence.models import (
    IdeAuthToken,
    TeamAdjunto,
    TeamAmistad,
    TeamCanal,
    TeamCanalMiembro,
    TeamMensaje,
    TeamMiembro,
    TeamProyecto,
    User,
)
from core.persistence.queries import avatar_url_for, now_iso

ESTADOS = ("en_linea", "desconectado", "no_molestar", "invisible")


def _id(prefijo: str) -> str:
    return f"{prefijo}_{uuid.uuid4().hex[:12]}"


# ── Usuarios ───────────────────────────────────────────────────────────────

def usuario_publico(u: User | None) -> dict[str, Any] | None:
    """Lo que se manda de un usuario a OTROS: sin correo, sin plan, sin rol.
    Un chat no es motivo para repartir la agenda de correos de la empresa."""
    if u is None:
        return None
    return {
        "id": u.id,
        "username": u.username,
        "first_name": u.first_name,
        "last_name": u.last_name,
        "avatar_url": avatar_url_for(u.avatar_key),
    }


def _usuarios_por_id(s, ids) -> dict[int, User]:
    ids = [i for i in set(ids) if i]
    if not ids:
        return {}
    return {u.id: u for u in s.scalars(select(User).where(User.id.in_(ids)))}


def usuario_publico_por_id(uid: int) -> dict[str, Any] | None:
    with get_session() as s:
        return usuario_publico(s.get(User, uid))


def buscar_usuario(identificador: str) -> dict[str, Any] | None:
    """Por correo exacto o por nombre de usuario exacto. Es lo que usan invitar
    y las solicitudes de amistad: ahí no se adivina, se nombra."""
    q = str(identificador or "").strip().lower()
    if not q:
        return None
    with get_session() as s:
        u = s.scalar(select(User).where(func.lower(User.email) == q))
        if not u:
            u = s.scalar(select(User).where(func.lower(User.username) == q))
        return usuario_publico(u)


def buscar_usuarios(q: str, excepto: int, limite: int = 10) -> list[dict[str, Any]]:
    patron = f"%{str(q or '').strip().lower()}%"
    with get_session() as s:
        filas = s.scalars(
            select(User)
            .where(User.id != excepto, User.is_active == 1)
            .where(or_(func.lower(User.username).like(patron), func.lower(User.email).like(patron)))
            .order_by(User.username)
            .limit(limite)
        )
        return [usuario_publico(u) for u in filas]


# ── Pertenencia y visibilidad ──────────────────────────────────────────────

def _miembro(s, proyecto_id: str, uid: int) -> TeamMiembro | None:
    return s.get(TeamMiembro, {"proyecto_id": proyecto_id, "usuario_id": uid})


def es_miembro(proyecto_id: str, uid: int) -> bool:
    with get_session() as s:
        return _miembro(s, proyecto_id, uid) is not None


def es_lider(proyecto_id: str, uid: int) -> bool:
    with get_session() as s:
        m = _miembro(s, proyecto_id, uid)
        return bool(m and m.rol == "lider")


def _miembros_de_canal(s, canal: TeamCanal) -> list[int]:
    """Quién puede ver un canal. De aquí dependen las respuestas REST **y** a
    quién se le emite cada evento: un canal privado no se «esconde» en el
    cliente, es que sus mensajes no se emiten (regla 3)."""
    if canal is None:
        return []
    if canal.tipo == "publico":
        return list(s.scalars(
            select(TeamMiembro.usuario_id).where(TeamMiembro.proyecto_id == canal.proyecto_id)
        ))
    return list(s.scalars(
        select(TeamCanalMiembro.usuario_id).where(TeamCanalMiembro.canal_id == canal.id)
    ))


def miembros_de_canal(canal_id: str) -> list[int]:
    with get_session() as s:
        return _miembros_de_canal(s, s.get(TeamCanal, canal_id))


def _puede_ver(s, canal: TeamCanal, uid: int) -> bool:
    return uid in _miembros_de_canal(s, canal)


def canales_visibles(uid: int) -> list[str]:
    """Ids de todos los canales que este usuario puede ver. Lo usa el replay."""
    with get_session() as s:
        propios = set(s.scalars(
            select(TeamCanalMiembro.canal_id).where(TeamCanalMiembro.usuario_id == uid)
        ))
        proyectos = list(s.scalars(
            select(TeamMiembro.proyecto_id).where(TeamMiembro.usuario_id == uid)
        ))
        if proyectos:
            propios |= set(s.scalars(
                select(TeamCanal.id).where(
                    TeamCanal.proyecto_id.in_(proyectos), TeamCanal.tipo == "publico"
                )
            ))
        return sorted(propios)


def relacionados(uid: int) -> list[int]:
    """Con quién comparte proyecto o amistad aceptada. Marca a quién se le avisa
    de un cambio de presencia y con quién se puede abrir un directo."""
    with get_session() as s:
        fuera: set[int] = set()
        proyectos = list(s.scalars(
            select(TeamMiembro.proyecto_id).where(TeamMiembro.usuario_id == uid)
        ))
        if proyectos:
            fuera |= set(s.scalars(
                select(TeamMiembro.usuario_id).where(TeamMiembro.proyecto_id.in_(proyectos))
            ))
        for a in s.scalars(select(TeamAmistad).where(
            TeamAmistad.estado == "aceptada",
            or_(TeamAmistad.de_id == uid, TeamAmistad.a_id == uid),
        )):
            fuera.add(a.a_id if a.de_id == uid else a.de_id)
        fuera.discard(uid)
        return sorted(fuera)


# ── Salida: la forma que viaja por el cable ────────────────────────────────

def _adjunto_salida(a: TeamAdjunto, firmar) -> dict[str, Any]:
    url, caduca = firmar(a.id)
    return {
        "id": a.id, "tipo": a.tipo, "nombre": a.nombre, "mime": a.mime,
        "bytes": a.bytes, "url": url, "caduca_en": caduca,
        "ancho": a.ancho, "alto": a.alto, "duracion_ms": a.duracion_ms,
    }


def _resumen_hilo(s, raiz_id: str) -> dict[str, Any]:
    """Cuántas respuestas, cuándo fue la última y quiénes hablaron. Viaja DENTRO
    del mensaje raíz —como los adjuntos— porque pintar el canal no puede costar
    una petición por hilo."""
    filas = list(s.scalars(
        select(TeamMensaje).where(TeamMensaje.responde_a == raiz_id).order_by(TeamMensaje.seq)
    ))
    gente: list[int] = []
    for r in filas:
        if r.autor_id not in gente:
            gente.append(r.autor_id)
    return {
        "mensaje_id": raiz_id,
        "respuestas": len(filas),
        "ultima_respuesta_en": filas[-1].creado_en if filas else None,
        "respondientes": gente[:5],
    }


def resumen_hilo(raiz_id: str) -> dict[str, Any]:
    with get_session() as s:
        return _resumen_hilo(s, raiz_id)


def _mensaje_salida(s, m: TeamMensaje, firmar) -> dict[str, Any]:
    adjuntos = list(s.scalars(
        select(TeamAdjunto).where(TeamAdjunto.mensaje_id == m.id).order_by(TeamAdjunto.creado_en)
    ))
    base = {
        "id": m.id, "canal_id": m.canal_id, "seq": m.seq, "autor_id": m.autor_id,
        "texto": m.texto, "client_id": m.client_id, "creado_en": m.creado_en,
        "editado_en": m.editado_en, "borrado_en": m.borrado_en,
        "responde_a": m.responde_a,
        "adjuntos": [_adjunto_salida(a, firmar) for a in adjuntos],
    }
    # El resumen solo lo lleva la raíz. Ponerlo también en cada respuesta
    # duplicaría el mismo dato en doce sitios que hay que mantener de acuerdo.
    if not m.responde_a:
        base.update(_resumen_hilo(s, m.id))
    return base


def _canal_salida(s, c: TeamCanal, uid: int, presencia) -> dict[str, Any]:
    base = {
        "id": c.id, "proyecto_id": c.proyecto_id, "nombre": c.nombre,
        "tipo": c.tipo, "tema": c.tema or "", "creado_en": c.creado_en,
    }
    if c.tipo != "directo":
        return base
    otro = next((x for x in _miembros_de_canal(s, c) if x != uid), None)
    return {**base, "con": usuario_publico(s.get(User, otro) if otro else None),
            "estado": presencia(otro) if otro else "desconectado"}


def _proyecto_salida(s, p: TeamProyecto, uid: int, presencia) -> dict[str, Any]:
    miembros = list(s.scalars(select(TeamMiembro).where(TeamMiembro.proyecto_id == p.id)))
    gente = _usuarios_por_id(s, [m.usuario_id for m in miembros])
    canales = [c for c in s.scalars(
        select(TeamCanal).where(TeamCanal.proyecto_id == p.id).order_by(TeamCanal.creado_en)
    ) if _puede_ver(s, c, uid)]
    mio = next((m for m in miembros if m.usuario_id == uid), None)
    return {
        "id": p.id, "nombre": p.nombre, "avatar_url": p.avatar_url,
        "lider_id": p.lider_id, "github_repo": p.github_repo,
        "linear_team_id": p.linear_team_id, "linear_project_id": p.linear_project_id,
        "creado_en": p.creado_en,
        "rol": mio.rol if mio else "integrante",
        "canales": [_canal_salida(s, c, uid, presencia) for c in canales],
        "miembros": [
            {"usuario": usuario_publico(gente.get(m.usuario_id)), "rol": m.rol,
             "estado": presencia(m.usuario_id)}
            for m in miembros if gente.get(m.usuario_id)
        ],
    }


def canal_salida(canal_id: str, uid: int, presencia) -> dict[str, Any] | None:
    with get_session() as s:
        c = s.get(TeamCanal, canal_id)
        return _canal_salida(s, c, uid, presencia) if c else None


def proyecto_salida(proyecto_id: str, uid: int, presencia) -> dict[str, Any] | None:
    with get_session() as s:
        p = s.get(TeamProyecto, proyecto_id)
        return _proyecto_salida(s, p, uid, presencia) if p else None


def mensaje_salida(mensaje_id: str, firmar) -> dict[str, Any] | None:
    with get_session() as s:
        m = s.get(TeamMensaje, mensaje_id)
        return _mensaje_salida(s, m, firmar) if m else None


# ── Bootstrap ──────────────────────────────────────────────────────────────

def bootstrap(uid: int, presencia_real: str, presencia) -> dict[str, Any]:
    """Todo lo que la ventana necesita para pintarse, en UNA llamada: arranca de
    golpe, no a saltos."""
    with get_session() as s:
        yo = s.get(User, uid)
        proyectos = list(s.scalars(
            select(TeamProyecto)
            .join(TeamMiembro, TeamMiembro.proyecto_id == TeamProyecto.id)
            .where(TeamMiembro.usuario_id == uid)
            .order_by(TeamProyecto.creado_en)
        ))
        directos = [c for c in s.scalars(
            select(TeamCanal)
            .join(TeamCanalMiembro, TeamCanalMiembro.canal_id == TeamCanal.id)
            .where(TeamCanalMiembro.usuario_id == uid, TeamCanal.tipo == "directo")
            .order_by(TeamCanal.creado_en)
        )]
        amistades = list(s.scalars(select(TeamAmistad).where(
            or_(TeamAmistad.de_id == uid, TeamAmistad.a_id == uid)
        )))
        otros = _usuarios_por_id(s, [a.a_id if a.de_id == uid else a.de_id for a in amistades])

        def otro_de(a):
            return otros.get(a.a_id if a.de_id == uid else a.de_id)

        return {
            "yo": usuario_publico(yo),
            "presencia": presencia_real,
            "proyectos": [_proyecto_salida(s, p, uid, presencia) for p in proyectos],
            "directos": [_canal_salida(s, c, uid, presencia) for c in directos],
            "amigos": [
                {"usuario": usuario_publico(otro_de(a)),
                 "estado": presencia(otro_de(a).id)}
                for a in amistades if a.estado == "aceptada" and otro_de(a)
            ],
            "solicitudes": [
                {"usuario": usuario_publico(otro_de(a)),
                 "direccion": "recibida" if a.a_id == uid else "enviada"}
                for a in amistades if a.estado == "pendiente" and otro_de(a)
            ],
        }


# ── Proyectos ──────────────────────────────────────────────────────────────

def crear_proyecto(uid: int, nombre: str) -> str:
    """El que lo crea queda como líder y se crea el canal #general: un proyecto
    sin ningún canal es una pantalla vacía sin nada que hacer."""
    ts = now_iso()
    pid = _id("p")
    with get_session() as s:
        s.add(TeamProyecto(id=pid, nombre=nombre, avatar_url=None, lider_id=uid,
                           github_repo=None, linear_team_id=None, linear_project_id=None,
                           creado_en=ts))
        s.flush()
        s.add(TeamMiembro(proyecto_id=pid, usuario_id=uid, rol="lider", desde=ts))
        s.add(TeamCanal(id=_id("c"), proyecto_id=pid, nombre="general", tipo="publico",
                        tema="Todo el equipo", creado_en=ts))
    return pid


CAMPOS_PROYECTO = ("nombre", "avatar_url", "github_repo", "linear_team_id", "linear_project_id")


def editar_proyecto(proyecto_id: str, cambios: dict[str, Any]) -> None:
    limpio = {k: v for k, v in cambios.items() if k in CAMPOS_PROYECTO}
    if not limpio:
        return
    with get_session() as s:
        s.execute(update(TeamProyecto).where(TeamProyecto.id == proyecto_id).values(**limpio))


def canales_de_proyecto(proyecto_id: str) -> list[str]:
    with get_session() as s:
        return list(s.scalars(select(TeamCanal.id).where(TeamCanal.proyecto_id == proyecto_id)))


def borrar_proyecto(proyecto_id: str) -> None:
    """Las claves ajenas van en CASCADE, así que miembros, canales y mensajes se
    van solos. Los adjuntos se sacan de R2 ANTES, en el router: la fila se borra
    aquí pero el objeto en el almacén no lo borra ninguna cascada."""
    with get_session() as s:
        s.execute(delete(TeamProyecto).where(TeamProyecto.id == proyecto_id))


def proyecto(proyecto_id: str) -> dict[str, Any] | None:
    with get_session() as s:
        p = s.get(TeamProyecto, proyecto_id)
        if not p:
            return None
        return {"id": p.id, "nombre": p.nombre, "lider_id": p.lider_id}


# ── Miembros ───────────────────────────────────────────────────────────────

def anadir_miembro(proyecto_id: str, uid: int) -> bool:
    """False si ya estaba."""
    with get_session() as s:
        if _miembro(s, proyecto_id, uid):
            return False
        s.add(TeamMiembro(proyecto_id=proyecto_id, usuario_id=uid, rol="integrante", desde=now_iso()))
        return True


def quitar_miembro(proyecto_id: str, uid: int) -> None:
    with get_session() as s:
        s.execute(delete(TeamMiembro).where(
            TeamMiembro.proyecto_id == proyecto_id, TeamMiembro.usuario_id == uid))
        canales = list(s.scalars(select(TeamCanal.id).where(TeamCanal.proyecto_id == proyecto_id)))
        if canales:
            s.execute(delete(TeamCanalMiembro).where(
                TeamCanalMiembro.canal_id.in_(canales), TeamCanalMiembro.usuario_id == uid))


def miembros_de_proyecto(proyecto_id: str) -> list[int]:
    with get_session() as s:
        return list(s.scalars(
            select(TeamMiembro.usuario_id).where(TeamMiembro.proyecto_id == proyecto_id)))


# ── Canales ────────────────────────────────────────────────────────────────

def crear_canal(proyecto_id: str, nombre: str, tipo: str, tema: str, creador: int) -> str:
    cid = _id("c")
    with get_session() as s:
        s.add(TeamCanal(id=cid, proyecto_id=proyecto_id, nombre=nombre, tipo=tipo,
                        tema=tema, creado_en=now_iso()))
        s.flush()
        # En un canal privado, quien lo crea entra solo: a los demás los añade
        # el líder, uno a uno y a propósito.
        if tipo == "privado":
            s.add(TeamCanalMiembro(canal_id=cid, usuario_id=creador))
    return cid


def canal(canal_id: str) -> dict[str, Any] | None:
    with get_session() as s:
        c = s.get(TeamCanal, canal_id)
        if not c:
            return None
        return {"id": c.id, "proyecto_id": c.proyecto_id, "nombre": c.nombre,
                "tipo": c.tipo, "tema": c.tema or ""}


def puede_ver_canal(canal_id: str, uid: int) -> bool:
    with get_session() as s:
        c = s.get(TeamCanal, canal_id)
        return bool(c) and _puede_ver(s, c, uid)


def editar_canal(canal_id: str, cambios: dict[str, Any]) -> None:
    limpio = {k: v for k, v in cambios.items() if k in ("nombre", "tema")}
    if not limpio:
        return
    with get_session() as s:
        s.execute(update(TeamCanal).where(TeamCanal.id == canal_id).values(**limpio))


def borrar_canal(canal_id: str) -> None:
    with get_session() as s:
        s.execute(delete(TeamCanal).where(TeamCanal.id == canal_id))


def sumar_a_canal(canal_id: str, uid: int) -> bool:
    with get_session() as s:
        if s.get(TeamCanalMiembro, {"canal_id": canal_id, "usuario_id": uid}):
            return False
        s.add(TeamCanalMiembro(canal_id=canal_id, usuario_id=uid))
        return True


def sacar_de_canal(canal_id: str, uid: int) -> None:
    with get_session() as s:
        s.execute(delete(TeamCanalMiembro).where(
            TeamCanalMiembro.canal_id == canal_id, TeamCanalMiembro.usuario_id == uid))


def abrir_directo(uid: int, otro_id: int) -> tuple[str, bool]:
    """(canal_id, nuevo). Idempotente: si ya existe el directo entre ambos, se
    devuelve ese."""
    with get_session() as s:
        mios = select(TeamCanalMiembro.canal_id).where(TeamCanalMiembro.usuario_id == uid)
        suyos = select(TeamCanalMiembro.canal_id).where(TeamCanalMiembro.usuario_id == otro_id)
        existente = s.scalar(select(TeamCanal.id).where(
            TeamCanal.tipo == "directo", TeamCanal.id.in_(mios), TeamCanal.id.in_(suyos)))
        if existente:
            return existente, False
        cid = _id("d")
        s.add(TeamCanal(id=cid, proyecto_id=None, nombre="", tipo="directo",
                        tema=None, creado_en=now_iso()))
        s.flush()
        s.add(TeamCanalMiembro(canal_id=cid, usuario_id=uid))
        s.add(TeamCanalMiembro(canal_id=cid, usuario_id=otro_id))
        return cid, True


def directos_de(uid: int) -> list[str]:
    with get_session() as s:
        return list(s.scalars(
            select(TeamCanal.id)
            .join(TeamCanalMiembro, TeamCanalMiembro.canal_id == TeamCanal.id)
            .where(TeamCanalMiembro.usuario_id == uid, TeamCanal.tipo == "directo")
            .order_by(TeamCanal.creado_en)))


# ── Mensajes ───────────────────────────────────────────────────────────────

def listar_mensajes(canal_id: str, antes_de: int, limite: int, hilo_de: str,
                    firmar) -> dict[str, Any]:
    """Sin `hilo_de` vienen SOLO las raíces: es lo que impide que una
    conversación de cuarenta réplicas entierre el canal. Con `hilo_de`, las
    respuestas de esa raíz y nada más — la raíz ya la tiene quien pregunta y
    repetirla la pintaría dos veces."""
    with get_session() as s:
        cond = [TeamMensaje.canal_id == canal_id]
        cond.append(TeamMensaje.responde_a == hilo_de if hilo_de
                    else TeamMensaje.responde_a.is_(None))
        if antes_de:
            cond.append(TeamMensaje.seq < antes_de)
        total = s.scalar(select(func.count()).select_from(TeamMensaje).where(*cond)) or 0
        # Los últimos `limite`: se piden descendente y se le da la vuelta, que
        # es lo único que un índice puede resolver sin leer el canal entero.
        filas = list(s.scalars(
            select(TeamMensaje).where(*cond).order_by(TeamMensaje.seq.desc()).limit(limite)
        ))[::-1]
        return {
            "mensajes": [_mensaje_salida(s, m, firmar) for m in filas],
            "hay_mas": total > len(filas),
        }


def mensaje(mensaje_id: str) -> dict[str, Any] | None:
    with get_session() as s:
        m = s.get(TeamMensaje, mensaje_id)
        if not m:
            return None
        return {"id": m.id, "canal_id": m.canal_id, "autor_id": m.autor_id,
                "responde_a": m.responde_a, "borrado_en": m.borrado_en, "texto": m.texto}


def crear_mensaje(canal_id: str, autor_id: int, client_id: str, texto: str,
                  adjuntos: list[str], responde_a: str | None) -> tuple[str, bool]:
    """(mensaje_id, nuevo). Idempotente por `client_id` (regla 1): la unicidad
    la impone la BD, así que dos envíos simultáneos del mismo reintento no
    pueden crear dos filas por mucho que lleguen a la vez.

    El `seq` se calcula dentro de la transacción y su unicidad también está en
    la BD: si dos mensajes se cruzan y eligen el mismo número, el segundo se
    reintenta en vez de romper el replay de todo el canal."""
    for _ in range(6):
        try:
            with get_session() as s:
                ya = s.scalar(select(TeamMensaje).where(
                    TeamMensaje.canal_id == canal_id, TeamMensaje.client_id == client_id))
                if ya:
                    return ya.id, False
                ultimo = s.scalar(select(func.max(TeamMensaje.seq)).where(
                    TeamMensaje.canal_id == canal_id)) or 0
                mid = _id("m")
                s.add(TeamMensaje(
                    id=mid, canal_id=canal_id, seq=ultimo + 1, autor_id=autor_id,
                    texto=texto, client_id=client_id, creado_en=now_iso(),
                    editado_en=None, responde_a=responde_a, borrado_en=None))
                s.flush()
                if adjuntos:
                    # A partir de aquí ya no se pueden reutilizar en otro
                    # mensaje: es la mitad de la regla 7.
                    s.execute(update(TeamAdjunto)
                              .where(TeamAdjunto.id.in_(adjuntos))
                              .values(mensaje_id=mid))
                return mid, True
        except IntegrityError:
            continue
    raise RuntimeError("No se pudo asignar seq al mensaje tras varios intentos")


def editar_mensaje(mensaje_id: str, texto: str) -> None:
    """Regla 9: cambia el texto y pone `editado_en`. No toca `seq`, ni
    `creado_en`, ni los adjuntos — un mensaje que salta al final por corregir
    una tilde rompe la conversación de todos los demás."""
    with get_session() as s:
        s.execute(update(TeamMensaje).where(TeamMensaje.id == mensaje_id)
                  .values(texto=texto, editado_en=now_iso()))


def tiene_respuestas(mensaje_id: str) -> bool:
    with get_session() as s:
        return bool(s.scalar(select(func.count()).select_from(TeamMensaje)
                             .where(TeamMensaje.responde_a == mensaje_id)))


def poner_lapida(mensaje_id: str) -> None:
    with get_session() as s:
        s.execute(update(TeamMensaje).where(TeamMensaje.id == mensaje_id)
                  .values(texto="", borrado_en=now_iso()))


def borrar_mensaje(mensaje_id: str) -> None:
    with get_session() as s:
        s.execute(delete(TeamMensaje).where(TeamMensaje.id == mensaje_id))


def replay(uid: int, cursores: dict[str, int], firmar, tope: int = 500) -> list[dict[str, Any]]:
    """Lo que se perdió mientras no estaba, por canal (regla 2). Nunca el
    historial entero: sin cursor de un canal se manda solo lo más reciente, que
    es lo que se va a mirar — el resto lo pide el cliente al hacer scroll."""
    salida: list[dict[str, Any]] = []
    with get_session() as s:
        for cid in canales_visibles(uid):
            desde = int(cursores.get(cid) or 0)
            cond = [TeamMensaje.canal_id == cid]
            if desde:
                cond.append(TeamMensaje.seq > desde)
            filas = list(s.scalars(
                select(TeamMensaje).where(*cond)
                .order_by(TeamMensaje.seq.desc()).limit(50 if not desde else tope)
            ))[::-1]
            for m in filas:
                salida.append({"tipo": "mensaje", "canal_id": cid,
                               "mensaje": _mensaje_salida(s, m, firmar)})
            if len(salida) >= tope:
                break
    return salida[:tope]


# ── Amistades ──────────────────────────────────────────────────────────────

def amistad_entre(a: int, b: int) -> dict[str, Any] | None:
    with get_session() as s:
        fila = s.scalar(select(TeamAmistad).where(or_(
            (TeamAmistad.de_id == a) & (TeamAmistad.a_id == b),
            (TeamAmistad.de_id == b) & (TeamAmistad.a_id == a),
        )))
        if not fila:
            return None
        return {"de_id": fila.de_id, "a_id": fila.a_id, "estado": fila.estado}


def pedir_amistad(de_id: int, a_id: int) -> None:
    with get_session() as s:
        s.add(TeamAmistad(de_id=de_id, a_id=a_id, estado="pendiente", creado_en=now_iso()))


def aceptar_amistad(de_id: int, a_id: int) -> bool:
    with get_session() as s:
        fila = s.scalar(select(TeamAmistad).where(
            TeamAmistad.de_id == de_id, TeamAmistad.a_id == a_id,
            TeamAmistad.estado == "pendiente"))
        if not fila:
            return False
        fila.estado = "aceptada"
        return True


def quitar_amistad(a: int, b: int) -> None:
    with get_session() as s:
        s.execute(delete(TeamAmistad).where(or_(
            (TeamAmistad.de_id == a) & (TeamAmistad.a_id == b),
            (TeamAmistad.de_id == b) & (TeamAmistad.a_id == a),
        )))


def amigos_de(uid: int) -> list[dict[str, Any]]:
    with get_session() as s:
        filas = list(s.scalars(select(TeamAmistad).where(
            TeamAmistad.estado == "aceptada",
            or_(TeamAmistad.de_id == uid, TeamAmistad.a_id == uid))))
        otros = _usuarios_por_id(s, [a.a_id if a.de_id == uid else a.de_id for a in filas])
        return [{"usuario": usuario_publico(otros[a.a_id if a.de_id == uid else a.de_id])}
                for a in filas if otros.get(a.a_id if a.de_id == uid else a.de_id)]


# ── Adjuntos ───────────────────────────────────────────────────────────────

def crear_adjunto(canal_id: str, subido_por: int, tipo: str, nombre: str, mime: str,
                  tamano: int, clave_r2: str, ancho: int | None, alto: int | None,
                  duracion_ms: int | None) -> str:
    aid = _id("a")
    with get_session() as s:
        s.add(TeamAdjunto(id=aid, canal_id=canal_id, subido_por=subido_por, mensaje_id=None,
                          tipo=tipo, nombre=nombre, mime=mime, bytes=tamano,
                          clave_r2=clave_r2, ancho=ancho, alto=alto,
                          duracion_ms=duracion_ms, creado_en=now_iso()))
    return aid


def adjunto(adjunto_id: str) -> dict[str, Any] | None:
    with get_session() as s:
        a = s.get(TeamAdjunto, adjunto_id)
        if not a:
            return None
        return {"id": a.id, "canal_id": a.canal_id, "subido_por": a.subido_por,
                "mensaje_id": a.mensaje_id, "tipo": a.tipo, "nombre": a.nombre,
                "mime": a.mime, "bytes": a.bytes, "clave_r2": a.clave_r2,
                "ancho": a.ancho, "alto": a.alto, "duracion_ms": a.duracion_ms}


def adjuntos_validos(ids: list[str], canal_id: str, uid: int) -> bool:
    """Regla 7: propios, de ESTE canal y sin usar. Si no, alguien podría colgar
    en su canal un archivo subido a otro."""
    if not ids:
        return True
    with get_session() as s:
        filas = list(s.scalars(select(TeamAdjunto).where(TeamAdjunto.id.in_(ids))))
        if len(filas) != len(set(ids)):
            return False
        return all(a.canal_id == canal_id and a.subido_por == uid and not a.mensaje_id
                   for a in filas)


def claves_r2_de_canales(canal_ids: list[str]) -> list[str]:
    if not canal_ids:
        return []
    with get_session() as s:
        return list(s.scalars(
            select(TeamAdjunto.clave_r2).where(TeamAdjunto.canal_id.in_(canal_ids))))


def claves_r2_de_mensaje(mensaje_id: str) -> list[str]:
    with get_session() as s:
        return list(s.scalars(
            select(TeamAdjunto.clave_r2).where(TeamAdjunto.mensaje_id == mensaje_id)))


def borrar_adjuntos_de_mensaje(mensaje_id: str) -> None:
    with get_session() as s:
        s.execute(delete(TeamAdjunto).where(TeamAdjunto.mensaje_id == mensaje_id))


def purgar_adjuntos_huerfanos(horas: int = 24) -> list[str]:
    """Los que se subieron y nunca llegaron a un mensaje (el usuario cerró la
    ventana antes de enviar). Devuelve sus claves de R2 para que el llamante las
    borre del almacén: sin esto el bucket crece para siempre con archivos que no
    puede ver nadie, que es una factura."""
    limite = (datetime.now(timezone.utc) - timedelta(hours=horas)).isoformat()
    with get_session() as s:
        filas = list(s.scalars(select(TeamAdjunto).where(
            TeamAdjunto.mensaje_id.is_(None), TeamAdjunto.creado_en < limite)))
        claves = [a.clave_r2 for a in filas]
        if filas:
            s.execute(delete(TeamAdjunto).where(TeamAdjunto.id.in_([a.id for a in filas])))
        return claves


# ── Canje del IDE ──────────────────────────────────────────────────────────

TOKEN_IDE_TTL_MIN = 2


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def emitir_token_ide(user_id: int, challenge: str, redirect_uri: str) -> str:
    """Devuelve el token en claro (solo se ve aquí y en la barra de direcciones;
    en la BD queda su hash). Vida corta a propósito: solo tiene que sobrevivir
    al salto del navegador al IDE."""
    token = secrets.token_hex(32)
    expira = (datetime.now(timezone.utc) + timedelta(minutes=TOKEN_IDE_TTL_MIN)).isoformat()
    with get_session() as s:
        s.execute(delete(IdeAuthToken).where(IdeAuthToken.expira_en < now_iso()))
        s.add(IdeAuthToken(token_hash=_hash_token(token), user_id=user_id,
                           challenge=challenge, redirect_uri=redirect_uri,
                           expira_en=expira, creado_en=now_iso()))
    return token


def consumir_token_ide(token: str) -> dict[str, Any] | None:
    """Regla 3 del canje: UN SOLO USO, y se borra **antes** de comprobar nada
    más, para que dos canjes simultáneos del mismo token no puedan darse nunca.
    El DELETE ... RETURNING lo hace en una sola operación atómica."""
    if not token:
        return None
    with get_session() as s:
        fila = s.execute(
            delete(IdeAuthToken)
            .where(IdeAuthToken.token_hash == _hash_token(token))
            .returning(IdeAuthToken.user_id, IdeAuthToken.challenge, IdeAuthToken.expira_en)
        ).first()
        if not fila:
            return None
        user_id, challenge, expira_en = fila
        if expira_en < now_iso():
            return None
        return {"user_id": user_id, "challenge": challenge}
