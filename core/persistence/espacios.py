"""
Espacios y sus agentes programados.

Un espacio guarda instrucciones, archivos de texto, memoria y un repo opcional.
Sus chats los reciben en cada turno (`contexto_de`) y sus agentes los usan en
cada ejecución. Como en `team_issues`, la autorización vive en la consulta:
todo lo que recibe un `uid` comprueba que el espacio es suyo, y todo devuelve
diccionarios con la forma del cable.
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import delete, desc, func, select, update

from core.persistence.database import get_session
from core.persistence.models import (
    Conversation,
    Espacio,
    EspacioAgente,
    EspacioArchivo,
    EspacioEjecucion,
    EspacioMemoria,
)
from core.persistence.queries import now_iso

MAX_ESPACIOS = 50
MAX_AGENTES = 20                 # por espacio
MAX_ARCHIVOS = 30                # por espacio
MAX_ARCHIVO_BYTES = 400_000      # texto: ~100K tokens como mucho
MAX_MEMORIA = 100
MAX_INSTRUCCIONES = 8000
# Lo que entra en cada turno: el resto de los archivos se recorta.
CONTEXTO_ARCHIVOS_CHARS = 60_000
# Una ejecución colgada (reinicio a mitad) se da por fallida pasado esto.
EJECUCION_MAX = timedelta(minutes=15)

HORA = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


class ErrorEspacio(Exception):
    """Un fallo que el router traduce a HTTP: (código, mensaje en español)."""

    def __init__(self, codigo: int, detalle: str) -> None:
        super().__init__(detalle)
        self.codigo = codigo
        self.detalle = detalle


def _id(prefijo: str) -> str:
    return f"{prefijo}_{uuid.uuid4().hex[:12]}"


def _texto(valor: Any, maximo: int, campo: str, obligatorio: bool = False) -> str | None:
    v = (valor or "").strip() if isinstance(valor, str) or valor is None else None
    if v is None:
        raise ErrorEspacio(400, f"«{campo}» no es texto")
    if obligatorio and not v:
        raise ErrorEspacio(400, f"Falta «{campo}»")
    if len(v) > maximo:
        raise ErrorEspacio(400, f"«{campo}» es demasiado largo (máximo {maximo} caracteres)")
    return v or None


def _propio(s, espacio_id: str, uid: int) -> Espacio:
    esp = s.get(Espacio, espacio_id)
    if not esp or esp.user_id != uid:
        raise ErrorEspacio(404, "Espacio no encontrado")
    return esp


def _agente_propio(s, agente_id: str, uid: int) -> EspacioAgente:
    ag = s.get(EspacioAgente, agente_id)
    if not ag or ag.user_id != uid:
        raise ErrorEspacio(404, "Agente no encontrado")
    return ag


# ── horario ─────────────────────────────────────────────────────────────────
def _zona(nombre: str) -> ZoneInfo:
    try:
        return ZoneInfo(nombre)
    except (ZoneInfoNotFoundError, ValueError):
        raise ErrorEspacio(400, "Zona horaria no válida")


def _dias(valor: Any) -> list[int]:
    if not isinstance(valor, list) or not valor:
        raise ErrorEspacio(400, "Elige al menos un día")
    dias = sorted({int(d) for d in valor if isinstance(d, int) and 0 <= d <= 6})
    if not dias:
        raise ErrorEspacio(400, "Elige al menos un día")
    return dias


def proxima_ejecucion(dias: list[int], hora: str, zona: str, desde: datetime | None = None) -> datetime:
    """Siguiente instante (UTC) que cae en uno de `dias` (0 = lunes) a `hora`
    local de `zona`, estrictamente después de `desde`."""
    tz = _zona(zona)
    desde = desde or datetime.now(timezone.utc)
    local = desde.astimezone(tz)
    hh, mm = (int(x) for x in hora.split(":"))
    for salto in range(0, 8):
        dia = (local + timedelta(days=salto)).date()
        if dia.weekday() not in dias:
            continue
        cand = datetime(dia.year, dia.month, dia.day, hh, mm, tzinfo=tz)
        if cand > local:
            return cand.astimezone(timezone.utc)
    raise ErrorEspacio(400, "Horario no válido")  # inalcanzable con ≥1 día


# ── serialización ───────────────────────────────────────────────────────────
def _esp_dict(e: Espacio, **extra: Any) -> dict[str, Any]:
    return {"id": e.id, "nombre": e.nombre, "descripcion": e.descripcion or "",
            "instrucciones": e.instrucciones or "", "repo": e.repo,
            "created_at": e.created_at, "updated_at": e.updated_at, **extra}


def _arc_dict(a: EspacioArchivo) -> dict[str, Any]:
    return {"id": a.id, "nombre": a.nombre, "mime": a.mime, "size": a.size, "created_at": a.created_at}


def _mem_dict(m: EspacioMemoria) -> dict[str, Any]:
    return {"id": m.id, "texto": m.texto, "origen": m.origen, "aprobada": bool(m.aprobada),
            "created_at": m.created_at}


def _eje_dict(x: EspacioEjecucion, completo: bool = False) -> dict[str, Any]:
    d = {"id": x.id, "agente_id": x.agente_id, "estado": x.estado, "origen": x.origen,
         "inicio": x.inicio, "fin": x.fin, "tokens": x.tokens, "error": x.error,
         "resumen": json.loads(x.resumen_json) if x.resumen_json else None}
    if completo:
        d["resultado"] = x.resultado or ""
        d["modelo"] = x.modelo
    return d


def _age_dict(a: EspacioAgente, ultima: EspacioEjecucion | None = None) -> dict[str, Any]:
    return {"id": a.id, "espacio_id": a.espacio_id, "nombre": a.nombre, "tarea": a.tarea,
            "dias": [int(d) for d in a.dias.split(",") if d != ""], "hora": a.hora, "zona": a.zona,
            "internet": bool(a.internet), "pausado": bool(a.pausado), "proxima_at": a.proxima_at,
            "created_at": a.created_at, "updated_at": a.updated_at,
            "ultima": _eje_dict(ultima) if ultima else None}


def _ultimas(s, agente_ids: list[str]) -> dict[str, EspacioEjecucion]:
    if not agente_ids:
        return {}
    sub = (select(EspacioEjecucion.agente_id, func.max(EspacioEjecucion.inicio).label("m"))
           .where(EspacioEjecucion.agente_id.in_(agente_ids))
           .group_by(EspacioEjecucion.agente_id).subquery())
    filas = s.execute(select(EspacioEjecucion).join(
        sub, (EspacioEjecucion.agente_id == sub.c.agente_id) & (EspacioEjecucion.inicio == sub.c.m))).scalars()
    return {x.agente_id: x for x in filas}


# ── espacios ────────────────────────────────────────────────────────────────
def listar(uid: int) -> list[dict[str, Any]]:
    with get_session() as s:
        esps = s.execute(select(Espacio).where(Espacio.user_id == uid)
                         .order_by(desc(Espacio.updated_at))).scalars().all()
        ids = [e.id for e in esps]
        if not ids:
            return []
        agentes = s.execute(select(EspacioAgente).where(EspacioAgente.espacio_id.in_(ids))).scalars().all()
        ultimas = _ultimas(s, [a.id for a in agentes])
        n_arch = dict(s.execute(select(EspacioArchivo.espacio_id, func.count())
                                .where(EspacioArchivo.espacio_id.in_(ids))
                                .group_by(EspacioArchivo.espacio_id)).all())
        out = []
        for e in esps:
            suyos = [a for a in agentes if a.espacio_id == e.id]
            ult = [ultimas[a.id] for a in suyos if a.id in ultimas]
            ult.sort(key=lambda x: x.inicio, reverse=True)
            out.append(_esp_dict(e, agentes=len(suyos), archivos=n_arch.get(e.id, 0),
                                 ultima=_eje_dict(ult[0]) if ult else None))
        return out


def crear(uid: int, datos: dict[str, Any]) -> dict[str, Any]:
    nombre = _texto(datos.get("nombre"), 80, "Nombre", obligatorio=True)
    desc_ = _texto(datos.get("descripcion"), 300, "Descripción")
    ts = now_iso()
    with get_session() as s:
        n = s.execute(select(func.count()).select_from(Espacio).where(Espacio.user_id == uid)).scalar_one()
        if n >= MAX_ESPACIOS:
            raise ErrorEspacio(409, f"Ya tienes {MAX_ESPACIOS} espacios")
        e = Espacio(id=_id("esp"), user_id=uid, nombre=nombre, descripcion=desc_,
                    created_at=ts, updated_at=ts)
        s.add(e)
        s.flush()
        return _esp_dict(e, agentes=0, archivos=0, ultima=None)


def obtener(uid: int, espacio_id: str) -> dict[str, Any]:
    with get_session() as s:
        e = _propio(s, espacio_id, uid)
        archivos = s.execute(select(EspacioArchivo).where(EspacioArchivo.espacio_id == e.id)
                             .order_by(EspacioArchivo.created_at)).scalars().all()
        memoria = s.execute(select(EspacioMemoria).where(EspacioMemoria.espacio_id == e.id)
                            .order_by(EspacioMemoria.aprobada, desc(EspacioMemoria.created_at))).scalars().all()
        agentes = s.execute(select(EspacioAgente).where(EspacioAgente.espacio_id == e.id)
                            .order_by(EspacioAgente.created_at)).scalars().all()
        ultimas = _ultimas(s, [a.id for a in agentes])
        chats = s.execute(select(Conversation).where(Conversation.user_id == uid,
                                                     Conversation.espacio_id == e.id)
                          .order_by(desc(Conversation.updated_at)).limit(30)).scalars().all()
        return _esp_dict(
            e,
            archivos=[_arc_dict(a) for a in archivos],
            memoria=[_mem_dict(m) for m in memoria],
            agentes=[_age_dict(a, ultimas.get(a.id)) for a in agentes],
            chats=[{"id": c.id, "title": c.title, "updated_at": c.updated_at} for c in chats],
        )


def editar(uid: int, espacio_id: str, datos: dict[str, Any]) -> dict[str, Any]:
    with get_session() as s:
        e = _propio(s, espacio_id, uid)
        if "nombre" in datos:
            e.nombre = _texto(datos["nombre"], 80, "Nombre", obligatorio=True)
        if "descripcion" in datos:
            e.descripcion = _texto(datos["descripcion"], 300, "Descripción")
        if "instrucciones" in datos:
            e.instrucciones = _texto(datos["instrucciones"], MAX_INSTRUCCIONES, "Instrucciones")
        if "repo" in datos:
            repo = _texto(datos["repo"], 200, "Repositorio")
            if repo and not REPO.match(repo):
                raise ErrorEspacio(400, "El repositorio va como dueño/nombre")
            e.repo = repo
        e.updated_at = now_iso()
        return _esp_dict(e)


def borrar(uid: int, espacio_id: str) -> None:
    with get_session() as s:
        e = _propio(s, espacio_id, uid)
        ags = [a for (a,) in s.execute(select(EspacioAgente.id).where(EspacioAgente.espacio_id == e.id)).all()]
        if ags:
            s.execute(delete(EspacioEjecucion).where(EspacioEjecucion.agente_id.in_(ags)))
        s.execute(delete(EspacioAgente).where(EspacioAgente.espacio_id == e.id))
        s.execute(delete(EspacioArchivo).where(EspacioArchivo.espacio_id == e.id))
        s.execute(delete(EspacioMemoria).where(EspacioMemoria.espacio_id == e.id))
        # Los chats se quedan (son del usuario), solo dejan de estar en el espacio.
        s.execute(update(Conversation).where(Conversation.espacio_id == e.id).values(espacio_id=None))
        s.delete(e)


# ── archivos ────────────────────────────────────────────────────────────────
def subir_archivo(uid: int, espacio_id: str, nombre: str, mime: str, contenido: bytes) -> dict[str, Any]:
    nombre = _texto(nombre, 160, "Nombre", obligatorio=True)
    if len(contenido) > MAX_ARCHIVO_BYTES:
        raise ErrorEspacio(413, f"El archivo pasa de {MAX_ARCHIVO_BYTES // 1000} KB")
    try:
        texto = contenido.decode("utf-8")
    except UnicodeDecodeError:
        raise ErrorEspacio(415, "Solo archivos de texto (md, txt, csv, json…) por ahora")
    if "\x00" in texto:
        raise ErrorEspacio(415, "Solo archivos de texto (md, txt, csv, json…) por ahora")
    with get_session() as s:
        e = _propio(s, espacio_id, uid)
        n = s.execute(select(func.count()).select_from(EspacioArchivo)
                      .where(EspacioArchivo.espacio_id == e.id)).scalar_one()
        if n >= MAX_ARCHIVOS:
            raise ErrorEspacio(409, f"Un espacio admite {MAX_ARCHIVOS} archivos")
        a = EspacioArchivo(id=_id("arc"), espacio_id=e.id, nombre=nombre, mime=mime or "text/plain",
                           size=len(contenido), contenido=texto, created_at=now_iso())
        s.add(a)
        e.updated_at = now_iso()
        s.flush()
        return _arc_dict(a)


def borrar_archivo(uid: int, espacio_id: str, archivo_id: str) -> None:
    with get_session() as s:
        _propio(s, espacio_id, uid)
        n = s.execute(delete(EspacioArchivo).where(EspacioArchivo.id == archivo_id,
                                                   EspacioArchivo.espacio_id == espacio_id)).rowcount
        if not n:
            raise ErrorEspacio(404, "Archivo no encontrado")


# ── memoria ─────────────────────────────────────────────────────────────────
def _nueva_memoria(s, espacio_id: str, texto: str, origen: str, aprobada: bool) -> EspacioMemoria:
    n = s.execute(select(func.count()).select_from(EspacioMemoria)
                  .where(EspacioMemoria.espacio_id == espacio_id)).scalar_one()
    if n >= MAX_MEMORIA:
        raise ErrorEspacio(409, f"La memoria admite {MAX_MEMORIA} notas")
    m = EspacioMemoria(id=_id("mem"), espacio_id=espacio_id, texto=texto, origen=origen,
                       aprobada=1 if aprobada else 0, created_at=now_iso())
    s.add(m)
    s.flush()
    return m


def anadir_memoria(uid: int, espacio_id: str, texto: str) -> dict[str, Any]:
    texto = _texto(texto, 500, "Nota", obligatorio=True)
    with get_session() as s:
        _propio(s, espacio_id, uid)
        return _mem_dict(_nueva_memoria(s, espacio_id, texto, "usuario", True))


def aprobar_memoria(uid: int, espacio_id: str, memoria_id: str) -> dict[str, Any]:
    with get_session() as s:
        _propio(s, espacio_id, uid)
        m = s.get(EspacioMemoria, memoria_id)
        if not m or m.espacio_id != espacio_id:
            raise ErrorEspacio(404, "Nota no encontrada")
        m.aprobada = 1
        return _mem_dict(m)


def borrar_memoria(uid: int, espacio_id: str, memoria_id: str) -> None:
    with get_session() as s:
        _propio(s, espacio_id, uid)
        n = s.execute(delete(EspacioMemoria).where(EspacioMemoria.id == memoria_id,
                                                   EspacioMemoria.espacio_id == espacio_id)).rowcount
        if not n:
            raise ErrorEspacio(404, "Nota no encontrada")


# ── contexto para el modelo ─────────────────────────────────────────────────
def _contexto(s, e: Espacio) -> str:
    partes = [f"[ESPACIO «{e.nombre}»] Esta conversación pertenece a un espacio del usuario."]
    if e.descripcion:
        partes.append(f"De qué trata: {e.descripcion}")
    if e.instrucciones:
        partes.append(f"Instrucciones del usuario para este espacio (síguelas siempre):\n{e.instrucciones}")
    memoria = s.execute(select(EspacioMemoria.texto).where(EspacioMemoria.espacio_id == e.id,
                                                           EspacioMemoria.aprobada == 1)
                        .order_by(EspacioMemoria.created_at)).scalars().all()
    if memoria:
        partes.append("Lo que debes recordar:\n" + "\n".join(f"- {m}" for m in memoria))
    if e.repo:
        partes.append(f"Repositorio del espacio: {e.repo}")
    archivos = s.execute(select(EspacioArchivo).where(EspacioArchivo.espacio_id == e.id)
                         .order_by(EspacioArchivo.created_at)).scalars().all()
    resto = CONTEXTO_ARCHIVOS_CHARS
    for a in archivos:
        if resto <= 0:
            partes.append(f"(Archivo «{a.nombre}» omitido: no cabe en el contexto)")
            continue
        cuerpo = a.contenido[:resto]
        resto -= len(cuerpo)
        corte = "\n[…recortado]" if len(cuerpo) < len(a.contenido) else ""
        partes.append(f"<archivo nombre=\"{a.nombre}\">\n{cuerpo}{corte}\n</archivo>")
    return "\n\n".join(partes)


def contexto_de(uid: int, espacio_id: str) -> str:
    with get_session() as s:
        return _contexto(s, _propio(s, espacio_id, uid))


def espacio_de_conversacion(uid: int, conversation_id: str) -> str | None:
    with get_session() as s:
        c = s.get(Conversation, conversation_id)
        return c.espacio_id if c and c.user_id == uid else None


def asignar_conversacion(uid: int, conversation_id: str, espacio_id: str) -> None:
    """Mete la conversación en el espacio si aún no está en ninguno."""
    with get_session() as s:
        _propio(s, espacio_id, uid)
        c = s.get(Conversation, conversation_id)
        if c and c.user_id == uid and not c.espacio_id:
            c.espacio_id = espacio_id


# ── agentes ─────────────────────────────────────────────────────────────────
def _validar_agente(datos: dict[str, Any], parcial: bool = False) -> dict[str, Any]:
    v: dict[str, Any] = {}
    if not parcial or "nombre" in datos:
        v["nombre"] = _texto(datos.get("nombre"), 80, "Nombre", obligatorio=True)
    if not parcial or "tarea" in datos:
        v["tarea"] = _texto(datos.get("tarea"), 4000, "Tarea", obligatorio=True)
    if not parcial or "dias" in datos:
        v["dias"] = _dias(datos.get("dias"))
    if not parcial or "hora" in datos:
        hora = (datos.get("hora") or "").strip()
        if not HORA.match(hora):
            raise ErrorEspacio(400, "La hora va como HH:MM")
        v["hora"] = hora
    if not parcial or "zona" in datos:
        zona = (datos.get("zona") or "UTC").strip()
        _zona(zona)
        v["zona"] = zona
    if "internet" in datos:
        v["internet"] = 1 if datos.get("internet") else 0
    if "pausado" in datos:
        v["pausado"] = 1 if datos.get("pausado") else 0
    return v


def crear_agente(uid: int, espacio_id: str, datos: dict[str, Any]) -> dict[str, Any]:
    v = _validar_agente(datos)
    ts = now_iso()
    with get_session() as s:
        e = _propio(s, espacio_id, uid)
        n = s.execute(select(func.count()).select_from(EspacioAgente)
                      .where(EspacioAgente.espacio_id == e.id)).scalar_one()
        if n >= MAX_AGENTES:
            raise ErrorEspacio(409, f"Un espacio admite {MAX_AGENTES} agentes")
        a = EspacioAgente(
            id=_id("age"), espacio_id=e.id, user_id=uid, nombre=v["nombre"], tarea=v["tarea"],
            dias=",".join(str(d) for d in v["dias"]), hora=v["hora"], zona=v["zona"],
            internet=v.get("internet", 0), pausado=0,
            proxima_at=proxima_ejecucion(v["dias"], v["hora"], v["zona"]).isoformat(),
            created_at=ts, updated_at=ts)
        s.add(a)
        e.updated_at = ts
        s.flush()
        return _age_dict(a)


def obtener_agente(uid: int, agente_id: str) -> dict[str, Any]:
    with get_session() as s:
        a = _agente_propio(s, agente_id, uid)
        e = s.get(Espacio, a.espacio_id)
        ejecs = s.execute(select(EspacioEjecucion).where(EspacioEjecucion.agente_id == a.id)
                          .order_by(desc(EspacioEjecucion.inicio)).limit(30)).scalars().all()
        d = _age_dict(a, ejecs[0] if ejecs else None)
        d["espacio"] = {"id": e.id, "nombre": e.nombre}
        d["ejecuciones"] = [_eje_dict(x) for x in ejecs]
        return d


def editar_agente(uid: int, agente_id: str, datos: dict[str, Any]) -> dict[str, Any]:
    v = _validar_agente(datos, parcial=True)
    with get_session() as s:
        a = _agente_propio(s, agente_id, uid)
        for k in ("nombre", "tarea", "hora", "zona", "internet", "pausado"):
            if k in v:
                setattr(a, k, v[k])
        if "dias" in v:
            a.dias = ",".join(str(d) for d in v["dias"])
        dias = [int(d) for d in a.dias.split(",") if d != ""]
        a.proxima_at = None if a.pausado else proxima_ejecucion(dias, a.hora, a.zona).isoformat()
        a.updated_at = now_iso()
        return _age_dict(a)


def borrar_agente(uid: int, agente_id: str) -> None:
    with get_session() as s:
        a = _agente_propio(s, agente_id, uid)
        s.execute(delete(EspacioEjecucion).where(EspacioEjecucion.agente_id == a.id))
        s.delete(a)


def obtener_ejecucion(uid: int, ejecucion_id: str) -> dict[str, Any]:
    with get_session() as s:
        x = s.get(EspacioEjecucion, ejecucion_id)
        if not x or x.user_id != uid:
            raise ErrorEspacio(404, "Ejecución no encontrada")
        return _eje_dict(x, completo=True)


# ── ejecuciones (las usa core/gateway/agentes.py) ───────────────────────────
def reclamar_pendientes(ahora: datetime | None = None, limite: int = 10) -> list[str]:
    """Agentes cuya hora llegó. Cada uno se reclama moviendo `proxima_at` a la
    siguiente con un UPDATE condicionado: si hay dos réplicas, solo una gana."""
    ahora = ahora or datetime.now(timezone.utc)
    ganados: list[str] = []
    with get_session() as s:
        due = s.execute(select(EspacioAgente).where(EspacioAgente.pausado == 0,
                                                    EspacioAgente.proxima_at.is_not(None),
                                                    EspacioAgente.proxima_at <= ahora.isoformat())
                        .order_by(EspacioAgente.proxima_at).limit(limite)).scalars().all()
        for a in due:
            dias = [int(d) for d in a.dias.split(",") if d != ""]
            try:
                sig = proxima_ejecucion(dias, a.hora, a.zona, ahora).isoformat()
            except ErrorEspacio:
                sig = None
            n = s.execute(update(EspacioAgente)
                          .where(EspacioAgente.id == a.id, EspacioAgente.proxima_at == a.proxima_at)
                          .values(proxima_at=sig)).rowcount
            if n:
                ganados.append(a.id)
    return ganados


def iniciar_ejecucion(agente_id: str, origen: str, uid: int | None = None) -> tuple[dict[str, Any], str] | None:
    """Abre una ejecución y devuelve (agente, id). None si ya hay una en curso
    o el agente no existe (o no es de `uid`)."""
    with get_session() as s:
        a = s.get(EspacioAgente, agente_id)
        if not a or (uid is not None and a.user_id != uid):
            raise ErrorEspacio(404, "Agente no encontrado")
        limite = (datetime.now(timezone.utc) - EJECUCION_MAX).isoformat()
        # Las colgadas (reinicio a mitad) se cierran como fallidas.
        s.execute(update(EspacioEjecucion).where(EspacioEjecucion.agente_id == a.id,
                                                 EspacioEjecucion.estado == "curso",
                                                 EspacioEjecucion.inicio < limite)
                  .values(estado="error", error="Se interrumpió (reinicio del servidor)", fin=now_iso()))
        en_curso = s.execute(select(func.count()).select_from(EspacioEjecucion)
                             .where(EspacioEjecucion.agente_id == a.id,
                                    EspacioEjecucion.estado == "curso")).scalar_one()
        if en_curso:
            return None
        x = EspacioEjecucion(id=_id("eje"), agente_id=a.id, user_id=a.user_id, estado="curso",
                             origen=origen, inicio=now_iso())
        s.add(x)
        s.flush()
        return {"id": a.id, "user_id": a.user_id, "espacio_id": a.espacio_id, "nombre": a.nombre,
                "tarea": a.tarea, "internet": bool(a.internet),
                "contexto": _contexto(s, s.get(Espacio, a.espacio_id))}, x.id


def ultimos_resultados(agente_id: str, n: int = 3) -> list[dict[str, Any]]:
    """Resúmenes de las últimas ejecuciones terminadas: así el agente no repite."""
    with get_session() as s:
        xs = s.execute(select(EspacioEjecucion).where(EspacioEjecucion.agente_id == agente_id,
                                                      EspacioEjecucion.estado.in_(("hecho", "espera")))
                       .order_by(desc(EspacioEjecucion.inicio)).limit(n)).scalars().all()
        return [{"inicio": x.inicio, "resumen": json.loads(x.resumen_json) if x.resumen_json else None}
                for x in xs]


def cerrar_ejecucion(ejecucion_id: str, *, estado: str, resultado: str | None = None,
                     resumen: dict[str, Any] | None = None, error: str | None = None,
                     modelo: str | None = None, tokens: int = 0,
                     memoria_propuesta: list[str] | None = None) -> None:
    with get_session() as s:
        x = s.get(EspacioEjecucion, ejecucion_id)
        if not x:
            return
        x.estado, x.resultado, x.error, x.modelo, x.tokens = estado, resultado, error, modelo, tokens
        x.resumen_json = json.dumps(resumen, ensure_ascii=False) if resumen else None
        x.fin = now_iso()
        a = s.get(EspacioAgente, x.agente_id)
        if a and memoria_propuesta:
            existentes = set(s.execute(select(EspacioMemoria.texto)
                                       .where(EspacioMemoria.espacio_id == a.espacio_id)).scalars())
            for t in memoria_propuesta[:3]:
                t = (t or "").strip()[:500]
                if t and t not in existentes:
                    try:
                        _nueva_memoria(s, a.espacio_id, t, "agente", False)
                    except ErrorEspacio:
                        break
