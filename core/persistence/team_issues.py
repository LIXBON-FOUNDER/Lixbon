"""
team_issues.py — Las issues propias de Lixbon Team.

Viven dentro de un proyecto de Team (el «equipo» en pantalla): estados,
etiquetas, ciclos, iniciativas (los «Proyectos» de la interfaz), issues,
comentarios, actividad y vínculos con ramas y PR. Sustituye a Linear: de él solo
queda el importador de una vez.

Como en `team_queries`, la autorización vive en la consulta: todo lo que
recibe un `uid` comprueba que es miembro del proyecto antes de tocar nada, y
todo devuelve diccionarios con la forma del cable.
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import case, delete, func, select
from sqlalchemy.exc import IntegrityError

from core.persistence.database import get_session
from core.persistence.models import (
    TeamCiclo,
    TeamEstado,
    TeamEtiqueta,
    TeamIniciativa,
    TeamIssue,
    TeamIssueActividad,
    TeamIssueComentario,
    TeamIssueEtiqueta,
    TeamIssueVinculo,
    TeamMiembro,
    TeamProyecto,
)
from core.persistence.queries import now_iso

TIPOS_ESTADO = ("backlog", "pendiente", "en_curso", "revision", "hecho", "cancelado")
CERRADOS = ("hecho", "cancelado")
ESTADOS_INICIATIVA = ("planificado", "en_camino", "en_riesgo", "hecho")
ESCALAS = ("ninguna", "fib", "tallas")
TIPOS_VINCULO = ("rama", "pr", "commit")
ROLES_AGENTE = ("explorador", "implementador", "revisor", "escalado")

ESTADOS_POR_DEFECTO = (
    ("Backlog", "#5E5E59", "backlog"),
    ("Por hacer", "#85857F", "pendiente"),
    ("En curso", "#8EC5FF", "en_curso"),
    ("En revisión", "#E8C872", "revision"),
    ("Hecho", "#86D694", "hecho"),
    ("Cancelado", "#F08C7C", "cancelado"),
)
ETIQUETAS_POR_DEFECTO = (("Bug", "#F08C7C"), ("Mejora", "#86D694"), ("Tarea", "#B5B5AF"))

CONFIG_POR_DEFECTO: dict[str, Any] = {
    "ciclos": {"activos": False, "semanas": 2, "dia_inicio": 0},   # 0 = lunes
    "estimacion": "fib",
    "automatismos": {"rama": True, "pr": True, "agentes": True},
}

COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")
DIA = re.compile(r"^\d{4}-\d{2}-\d{2}$")
PREFIJO = re.compile(r"^[A-Z][A-Z0-9]{0,4}$")


class ErrorIssues(Exception):
    """Un fallo que el router traduce a HTTP: (código, mensaje en español)."""

    def __init__(self, codigo: int, detalle: str) -> None:
        super().__init__(detalle)
        self.codigo = codigo
        self.detalle = detalle


def _id(prefijo: str) -> str:
    return f"{prefijo}_{uuid.uuid4().hex[:12]}"


def _hoy() -> date:
    return datetime.now(timezone.utc).date()


def prefijo_de(nombre: str) -> str:
    """«Lixbon Desktop» → «LD»; «Gateway» → «GAT». Siempre algo válido."""
    palabras = [p for p in re.split(r"[^A-Za-z0-9]+", _sin_tildes(nombre)) if p]
    if len(palabras) >= 2:
        pref = "".join(p[0] for p in palabras[:3])
    elif palabras:
        pref = palabras[0][:3]
    else:
        pref = "ISS"
    pref = pref.upper()
    return pref if PREFIJO.match(pref) else "ISS"


def _sin_tildes(t: str) -> str:
    import unicodedata
    return "".join(c for c in unicodedata.normalize("NFD", t or "") if unicodedata.category(c) != "Mn")


def _config(p: TeamProyecto) -> dict[str, Any]:
    try:
        guardada = json.loads(p.issues_config) if p.issues_config else {}
    except ValueError:
        guardada = {}
    cfg = json.loads(json.dumps(CONFIG_POR_DEFECTO))
    for k, v in (guardada or {}).items():
        if isinstance(v, dict) and isinstance(cfg.get(k), dict):
            cfg[k].update(v)
        else:
            cfg[k] = v
    return cfg


def _miembro(s, proyecto_id: str, uid: int) -> TeamMiembro | None:
    return s.get(TeamMiembro, (proyecto_id, uid))


def _exigir_miembro(s, proyecto_id: str, uid: int, lider: bool = False) -> TeamProyecto:
    p = s.get(TeamProyecto, proyecto_id)
    m = _miembro(s, proyecto_id, uid) if p else None
    if not p or not m:
        raise ErrorIssues(404, "No existe ese proyecto.")
    if lider and m.rol != "lider":
        raise ErrorIssues(403, "Solo el líder puede hacer esto.")
    return p


def _issue_de(s, issue_id: str, uid: int) -> tuple[TeamIssue, TeamProyecto]:
    i = s.get(TeamIssue, issue_id)
    if not i or i.borrado_en:
        raise ErrorIssues(404, "No existe esa issue.")
    p = _exigir_miembro(s, i.proyecto_id, uid)
    return i, p


def miembros(proyecto_id: str) -> list[int]:
    with get_session() as s:
        return list(s.scalars(select(TeamMiembro.usuario_id).where(TeamMiembro.proyecto_id == proyecto_id)))


# ── Tablero: estados, etiquetas, ciclos, iniciativas, ajustes ──────────────

def asegurar_tablero(s, p: TeamProyecto, config: dict[str, Any] | None = None,
                     etiquetas: list[str] | None = None) -> None:
    """Un proyecto sin estados no puede tener issues: si le faltan (proyectos
    anteriores a esta versión, o recién creados) se le ponen los de siempre."""
    hay = s.scalar(select(func.count()).select_from(TeamEstado).where(TeamEstado.proyecto_id == p.id))
    if not hay:
        for n, (nombre, color, tipo) in enumerate(ESTADOS_POR_DEFECTO):
            s.add(TeamEstado(id=_id("es"), proyecto_id=p.id, nombre=nombre, color=color,
                             tipo=tipo, orden=float(n)))
        nombres = etiquetas if etiquetas is not None else [e[0] for e in ETIQUETAS_POR_DEFECTO]
        colores = {n.lower(): c for n, c in ETIQUETAS_POR_DEFECTO}
        paleta = ["#C6D66E", "#8EC5FF", "#E8C872", "#C3B4FF", "#86D694", "#F08C7C", "#B5B5AF"]
        for n, nombre in enumerate(x.strip() for x in nombres if x and x.strip()):
            s.add(TeamEtiqueta(id=_id("et"), proyecto_id=p.id, nombre=nombre[:40],
                               color=colores.get(nombre.lower(), paleta[n % len(paleta)])))
    if not p.issues_prefijo:
        p.issues_prefijo = prefijo_de(p.nombre)
    if config is not None:
        p.issues_config = json.dumps(_config_limpia(config, _config(p)))
    elif not p.issues_config:
        p.issues_config = json.dumps(CONFIG_POR_DEFECTO)
    s.flush()
    _asegurar_ciclos(s, p)


def _config_limpia(nueva: dict[str, Any], actual: dict[str, Any]) -> dict[str, Any]:
    cfg = json.loads(json.dumps(actual))
    c = nueva.get("ciclos")
    if isinstance(c, dict):
        if "activos" in c:
            cfg["ciclos"]["activos"] = bool(c["activos"])
        if "semanas" in c:
            sem = int(c["semanas"])
            if sem not in (1, 2, 3, 4):
                raise ErrorIssues(422, "Los ciclos duran de 1 a 4 semanas.")
            cfg["ciclos"]["semanas"] = sem
        if "dia_inicio" in c:
            dia = int(c["dia_inicio"])
            if not 0 <= dia <= 6:
                raise ErrorIssues(422, "El día de inicio va de 0 (lunes) a 6 (domingo).")
            cfg["ciclos"]["dia_inicio"] = dia
    if "estimacion" in nueva:
        if nueva["estimacion"] not in ESCALAS:
            raise ErrorIssues(422, "Escala de estimación desconocida.")
        cfg["estimacion"] = nueva["estimacion"]
    a = nueva.get("automatismos")
    if isinstance(a, dict):
        for k in ("rama", "pr", "agentes"):
            if k in a:
                cfg["automatismos"][k] = bool(a[k])
    return cfg


def _asegurar_ciclos(s, p: TeamProyecto) -> None:
    """Con ciclos activos siempre existen el ciclo de hoy y el siguiente, y lo
    que no se terminó en un ciclo ya cerrado pasa solo al de hoy."""
    cfg = _config(p)["ciclos"]
    if not cfg.get("activos"):
        return
    hoy = _hoy()
    dur = timedelta(weeks=int(cfg.get("semanas") or 2))
    ciclos = list(s.scalars(select(TeamCiclo).where(TeamCiclo.proyecto_id == p.id)
                            .order_by(TeamCiclo.numero)))
    if not ciclos:
        inicio = hoy - timedelta(days=(hoy.weekday() - int(cfg.get("dia_inicio") or 0)) % 7)
        c = TeamCiclo(id=_id("ci"), proyecto_id=p.id, numero=1, empieza=inicio.isoformat(),
                      termina=(inicio + dur - timedelta(days=1)).isoformat())
        s.add(c)
        ciclos.append(c)
    # Hasta cubrir hoy y uno más.
    while date.fromisoformat(ciclos[-1].termina) < hoy + dur:
        ult = ciclos[-1]
        ini = date.fromisoformat(ult.termina) + timedelta(days=1)
        c = TeamCiclo(id=_id("ci"), proyecto_id=p.id, numero=ult.numero + 1,
                      empieza=ini.isoformat(), termina=(ini + dur - timedelta(days=1)).isoformat())
        s.add(c)
        ciclos.append(c)
    s.flush()
    actual = next((c for c in ciclos if c.empieza <= hoy.isoformat() <= c.termina), None)
    if not actual:
        return
    pasados = [c.id for c in ciclos if c.termina < hoy.isoformat()]
    if pasados:
        abiertos = select(TeamEstado.id).where(TeamEstado.proyecto_id == p.id,
                                               TeamEstado.tipo.not_in(CERRADOS))
        for i in s.scalars(select(TeamIssue).where(
                TeamIssue.proyecto_id == p.id, TeamIssue.ciclo_id.in_(pasados),
                TeamIssue.borrado_en.is_(None), TeamIssue.estado_id.in_(abiertos))):
            _registrar(s, i, None, "ciclo_id", i.ciclo_id, actual.id)
            i.ciclo_id = actual.id


def _estado_salida(e: TeamEstado) -> dict[str, Any]:
    return {"id": e.id, "nombre": e.nombre, "color": e.color, "tipo": e.tipo, "orden": e.orden}


def _etiqueta_salida(e: TeamEtiqueta) -> dict[str, Any]:
    return {"id": e.id, "nombre": e.nombre, "color": e.color}


def _ciclo_salida(c: TeamCiclo) -> dict[str, Any]:
    return {"id": c.id, "numero": c.numero, "empieza": c.empieza, "termina": c.termina}


def _iniciativa_salida(x: TeamIniciativa) -> dict[str, Any]:
    return {"id": x.id, "nombre": x.nombre, "color": x.color, "responsable_id": x.responsable_id,
            "objetivo": x.objetivo, "estado": x.estado, "creado_en": x.creado_en}


def tablero_salida(s, p: TeamProyecto) -> dict[str, Any]:
    """Lo que va en el bootstrap de cada proyecto: todo lo que hace falta para
    pintar el tablero salvo las issues, que se piden aparte."""
    asegurar_tablero(s, p)
    estados = s.scalars(select(TeamEstado).where(TeamEstado.proyecto_id == p.id)
                        .order_by(TeamEstado.orden))
    etiquetas = s.scalars(select(TeamEtiqueta).where(TeamEtiqueta.proyecto_id == p.id)
                          .order_by(TeamEtiqueta.nombre))
    ciclos = s.scalars(select(TeamCiclo).where(TeamCiclo.proyecto_id == p.id)
                       .order_by(TeamCiclo.numero.desc()).limit(12))
    inis = s.scalars(select(TeamIniciativa).where(TeamIniciativa.proyecto_id == p.id)
                     .order_by(TeamIniciativa.creado_en))
    return {
        "prefijo": p.issues_prefijo,
        "config": _config(p),
        "estados": [_estado_salida(e) for e in estados],
        "etiquetas": [_etiqueta_salida(e) for e in etiquetas],
        "ciclos": sorted((_ciclo_salida(c) for c in ciclos), key=lambda c: c["numero"]),
        "iniciativas": [_iniciativa_salida(x) for x in inis],
    }


def preparar_proyecto(proyecto_id: str, prefijo: str | None, config: dict[str, Any] | None,
                      etiquetas: list[str] | None) -> None:
    """Lo que elige el asistente de «Nuevo equipo» en su paso Issues."""
    with get_session() as s:
        p = s.get(TeamProyecto, proyecto_id)
        if prefijo:
            p.issues_prefijo = _prefijo_valido(prefijo)
        asegurar_tablero(s, p, config=config or {}, etiquetas=etiquetas)


def _prefijo_valido(prefijo: str) -> str:
    limpio = _sin_tildes(prefijo).strip().upper()
    if not PREFIJO.match(limpio):
        raise ErrorIssues(422, "El identificador son de 1 a 5 letras o números y empieza por letra.")
    return limpio


def editar_ajustes(proyecto_id: str, uid: int, cambios: dict[str, Any]) -> None:
    with get_session() as s:
        p = _exigir_miembro(s, proyecto_id, uid, lider=True)
        asegurar_tablero(s, p)
        if cambios.get("prefijo"):
            p.issues_prefijo = _prefijo_valido(cambios["prefijo"])
        resto = {k: v for k, v in cambios.items() if k in ("ciclos", "estimacion", "automatismos")}
        if resto:
            p.issues_config = json.dumps(_config_limpia(resto, _config(p)))
            s.flush()
            _asegurar_ciclos(s, p)


def _color(c: str | None, por_defecto: str) -> str:
    if c is None:
        return por_defecto
    if not COLOR.match(c):
        raise ErrorIssues(422, "El color va como #RRGGBB.")
    return c.upper()


def crear_estado(proyecto_id: str, uid: int, nombre: str, tipo: str, color: str | None) -> None:
    if tipo not in TIPOS_ESTADO:
        raise ErrorIssues(422, "Tipo de estado desconocido.")
    with get_session() as s:
        _exigir_miembro(s, proyecto_id, uid, lider=True)
        mayor = s.scalar(select(func.max(TeamEstado.orden)).where(TeamEstado.proyecto_id == proyecto_id))
        s.add(TeamEstado(id=_id("es"), proyecto_id=proyecto_id, nombre=nombre.strip()[:40],
                         color=_color(color, "#85857F"), tipo=tipo, orden=(mayor or 0) + 1))


def editar_estado(estado_id: str, uid: int, cambios: dict[str, Any]) -> str:
    with get_session() as s:
        e = s.get(TeamEstado, estado_id)
        if not e:
            raise ErrorIssues(404, "No existe ese estado.")
        _exigir_miembro(s, e.proyecto_id, uid, lider=True)
        if cambios.get("nombre"):
            e.nombre = cambios["nombre"].strip()[:40]
        if "color" in cambios:
            e.color = _color(cambios["color"], e.color)
        if "orden" in cambios and cambios["orden"] is not None:
            e.orden = float(cambios["orden"])
        return e.proyecto_id


def borrar_estado(estado_id: str, uid: int, mover_a: str | None) -> str:
    """Un estado con issues no se borra sin decir adónde van; y siempre tiene
    que quedar al menos un estado abierto y uno cerrado."""
    with get_session() as s:
        e = s.get(TeamEstado, estado_id)
        if not e:
            raise ErrorIssues(404, "No existe ese estado.")
        _exigir_miembro(s, e.proyecto_id, uid, lider=True)
        resto = list(s.scalars(select(TeamEstado).where(TeamEstado.proyecto_id == e.proyecto_id,
                                                        TeamEstado.id != e.id)))
        if not any(x.tipo in CERRADOS for x in resto) or not any(x.tipo not in CERRADOS for x in resto):
            raise ErrorIssues(409, "Tiene que quedar al menos un estado abierto y uno cerrado.")
        con_issues = s.scalar(select(func.count()).select_from(TeamIssue).where(
            TeamIssue.estado_id == e.id, TeamIssue.borrado_en.is_(None)))
        if con_issues:
            destino = next((x for x in resto if x.id == mover_a), None)
            if not destino:
                raise ErrorIssues(409, "Ese estado tiene issues: elige a qué estado pasan.")
            for i in s.scalars(select(TeamIssue).where(TeamIssue.estado_id == e.id)):
                _registrar(s, i, uid, "estado_id", i.estado_id, destino.id)
                i.estado_id = destino.id
        s.delete(e)
        return e.proyecto_id


def crear_etiqueta(proyecto_id: str, uid: int, nombre: str, color: str | None) -> dict[str, Any]:
    with get_session() as s:
        _exigir_miembro(s, proyecto_id, uid)
        e = TeamEtiqueta(id=_id("et"), proyecto_id=proyecto_id, nombre=nombre.strip()[:40],
                         color=_color(color, "#B5B5AF"))
        s.add(e)
        s.flush()
        return _etiqueta_salida(e)


def editar_etiqueta(etiqueta_id: str, uid: int, cambios: dict[str, Any]) -> str:
    with get_session() as s:
        e = s.get(TeamEtiqueta, etiqueta_id)
        if not e:
            raise ErrorIssues(404, "No existe esa etiqueta.")
        _exigir_miembro(s, e.proyecto_id, uid, lider=True)
        if cambios.get("nombre"):
            e.nombre = cambios["nombre"].strip()[:40]
        if "color" in cambios:
            e.color = _color(cambios["color"], e.color)
        return e.proyecto_id


def borrar_etiqueta(etiqueta_id: str, uid: int) -> str:
    with get_session() as s:
        e = s.get(TeamEtiqueta, etiqueta_id)
        if not e:
            raise ErrorIssues(404, "No existe esa etiqueta.")
        _exigir_miembro(s, e.proyecto_id, uid, lider=True)
        s.execute(delete(TeamIssueEtiqueta).where(TeamIssueEtiqueta.etiqueta_id == e.id))
        s.delete(e)
        return e.proyecto_id


def crear_iniciativa(proyecto_id: str, uid: int, datos: dict[str, Any]) -> str:
    with get_session() as s:
        _exigir_miembro(s, proyecto_id, uid)
        x = TeamIniciativa(id=_id("in"), proyecto_id=proyecto_id, nombre=datos["nombre"].strip()[:60],
                           color=_color(datos.get("color"), "#8EC5FF"), creado_en=now_iso())
        _aplicar_iniciativa(s, x, datos)
        s.add(x)
        return x.id


def _aplicar_iniciativa(s, x: TeamIniciativa, datos: dict[str, Any]) -> None:
    if "responsable_id" in datos:
        r = datos["responsable_id"]
        if r is not None and not _miembro(s, x.proyecto_id, r):
            raise ErrorIssues(422, "El responsable tiene que ser del equipo.")
        x.responsable_id = r
    if "objetivo" in datos:
        o = datos["objetivo"]
        if o is not None and not DIA.match(o):
            raise ErrorIssues(422, "La fecha objetivo va como AAAA-MM-DD.")
        x.objetivo = o
    if datos.get("estado"):
        if datos["estado"] not in ESTADOS_INICIATIVA:
            raise ErrorIssues(422, "Estado de proyecto desconocido.")
        x.estado = datos["estado"]


def editar_iniciativa(iniciativa_id: str, uid: int, datos: dict[str, Any]) -> str:
    with get_session() as s:
        x = s.get(TeamIniciativa, iniciativa_id)
        if not x:
            raise ErrorIssues(404, "No existe ese proyecto.")
        _exigir_miembro(s, x.proyecto_id, uid)
        if datos.get("nombre"):
            x.nombre = datos["nombre"].strip()[:60]
        if "color" in datos:
            x.color = _color(datos["color"], x.color)
        _aplicar_iniciativa(s, x, datos)
        return x.proyecto_id


def borrar_iniciativa(iniciativa_id: str, uid: int) -> tuple[str, list[str]]:
    """Las issues se quedan; solo pierden el proyecto."""
    with get_session() as s:
        x = s.get(TeamIniciativa, iniciativa_id)
        if not x:
            raise ErrorIssues(404, "No existe ese proyecto.")
        _exigir_miembro(s, x.proyecto_id, uid, lider=True)
        tocadas = []
        for i in s.scalars(select(TeamIssue).where(TeamIssue.iniciativa_id == x.id)):
            i.iniciativa_id = None
            tocadas.append(i.id)
        s.delete(x)
        return x.proyecto_id, tocadas


# ── Issues ─────────────────────────────────────────────────────────────────

def _registrar(s, i: TeamIssue, actor: int | None, campo: str, antes: Any, despues: Any) -> None:
    s.add(TeamIssueActividad(issue_id=i.id, actor_id=actor, campo=campo,
                             antes=None if antes is None else str(antes),
                             despues=None if despues is None else str(despues), en=now_iso()))


def _resumenes(s, issues: list[TeamIssue], prefijo: str) -> list[dict[str, Any]]:
    """La forma de lista de una issue, con los contadores que pinta la tarjeta
    (subtareas, comentarios, vínculos) sacados en consultas agrupadas."""
    ids = [i.id for i in issues]
    if not ids:
        return []
    etqs: dict[str, list[str]] = {}
    for iid, eid in s.execute(select(TeamIssueEtiqueta.issue_id, TeamIssueEtiqueta.etiqueta_id)
                              .where(TeamIssueEtiqueta.issue_id.in_(ids))):
        etqs.setdefault(iid, []).append(eid)
    coments = dict(s.execute(select(TeamIssueComentario.issue_id, func.count())
                             .where(TeamIssueComentario.issue_id.in_(ids))
                             .group_by(TeamIssueComentario.issue_id)).all())
    cerrados = select(TeamEstado.id).where(TeamEstado.tipo.in_(CERRADOS))
    subt: dict[str, list[int]] = {}
    for padre, total, hechas in s.execute(
            select(TeamIssue.padre_id, func.count(),
                   func.sum(case((TeamIssue.estado_id.in_(cerrados), 1), else_=0)))
            .where(TeamIssue.padre_id.in_(ids), TeamIssue.borrado_en.is_(None))
            .group_by(TeamIssue.padre_id)):
        subt[padre] = [int(total or 0), int(hechas or 0)]
    vinc: dict[str, list[TeamIssueVinculo]] = {}
    for v in s.scalars(select(TeamIssueVinculo).where(TeamIssueVinculo.issue_id.in_(ids))
                       .order_by(TeamIssueVinculo.creado_en)):
        vinc.setdefault(v.issue_id, []).append(v)
    salida = []
    for i in issues:
        vs = vinc.get(i.id, [])
        rama = next((v for v in reversed(vs) if v.tipo == "rama"), None)
        pr = next((v for v in reversed(vs) if v.tipo == "pr"), None)
        total, hechas = subt.get(i.id, [0, 0])
        salida.append({
            "id": i.id, "proyecto_id": i.proyecto_id, "numero": i.numero,
            "clave": f"{prefijo}-{i.numero}", "titulo": i.titulo,
            "estado_id": i.estado_id, "prioridad": i.prioridad, "estimacion": i.estimacion,
            "asignado_id": i.asignado_id, "agente_rol": i.agente_rol,
            "ciclo_id": i.ciclo_id, "iniciativa_id": i.iniciativa_id, "padre_id": i.padre_id,
            "fecha_limite": i.fecha_limite, "orden": i.orden,
            "etiquetas": etqs.get(i.id, []),
            "subtareas": {"total": total, "hechas": hechas},
            "comentarios": int(coments.get(i.id, 0)),
            "vinculos": len(vs),
            "rama": rama.ref if rama else None,
            "pr": {"ref": pr.ref, "estado": pr.estado, "url": pr.url} if pr else None,
            "creado_por": i.creado_por, "creado_en": i.creado_en,
            "actualizado_en": i.actualizado_en, "cerrado_en": i.cerrado_en,
        })
    return salida


def listar_issues(proyecto_id: str, uid: int) -> list[dict[str, Any]]:
    """Todas las abiertas y las cerradas de los últimos 90 días: lo que cabe en
    un tablero y en el avance de los ciclos. Lo más viejo se busca aparte."""
    with get_session() as s:
        p = _exigir_miembro(s, proyecto_id, uid)
        asegurar_tablero(s, p)
        corte = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat()
        issues = list(s.scalars(select(TeamIssue).where(
            TeamIssue.proyecto_id == proyecto_id, TeamIssue.borrado_en.is_(None),
            (TeamIssue.cerrado_en.is_(None)) | (TeamIssue.cerrado_en >= corte),
        ).order_by(TeamIssue.orden, TeamIssue.numero)))
        return _resumenes(s, issues, p.issues_prefijo)


def resumen(issue_id: str) -> dict[str, Any] | None:
    with get_session() as s:
        i = s.get(TeamIssue, issue_id)
        if not i:
            return None
        p = s.get(TeamProyecto, i.proyecto_id)
        return _resumenes(s, [i], p.issues_prefijo)[0]


def _estado_valido(s, proyecto_id: str, estado_id: str | None) -> TeamEstado:
    if estado_id:
        e = s.get(TeamEstado, estado_id)
        if not e or e.proyecto_id != proyecto_id:
            raise ErrorIssues(422, "Ese estado no es de este equipo.")
        return e
    e = s.scalars(select(TeamEstado).where(TeamEstado.proyecto_id == proyecto_id,
                                           TeamEstado.tipo == "pendiente")
                  .order_by(TeamEstado.orden)).first()
    return e or s.scalars(select(TeamEstado).where(TeamEstado.proyecto_id == proyecto_id)
                          .order_by(TeamEstado.orden)).first()


def _validar_campos(s, i: TeamIssue, datos: dict[str, Any]) -> None:
    """Comprueba que cada referencia es de este mismo equipo: un id de otro
    proyecto metido a mano no puede colar datos ajenos en el tablero."""
    pid = i.proyecto_id
    if "prioridad" in datos and datos["prioridad"] not in (0, 1, 2, 3, 4):
        raise ErrorIssues(422, "La prioridad va de 0 (sin) a 4 (urgente).")
    if datos.get("asignado_id") is not None and not _miembro(s, pid, datos["asignado_id"]):
        raise ErrorIssues(422, "Solo se asigna a gente del equipo.")
    if datos.get("agente_rol") is not None and datos["agente_rol"] not in ROLES_AGENTE:
        raise ErrorIssues(422, "Rol de agente desconocido.")
    if datos.get("ciclo_id") is not None:
        c = s.get(TeamCiclo, datos["ciclo_id"])
        if not c or c.proyecto_id != pid:
            raise ErrorIssues(422, "Ese ciclo no es de este equipo.")
    if datos.get("iniciativa_id") is not None:
        x = s.get(TeamIniciativa, datos["iniciativa_id"])
        if not x or x.proyecto_id != pid:
            raise ErrorIssues(422, "Ese proyecto no es de este equipo.")
    if datos.get("padre_id") is not None:
        padre = s.get(TeamIssue, datos["padre_id"])
        if not padre or padre.proyecto_id != pid or padre.borrado_en:
            raise ErrorIssues(422, "La issue padre no es de este equipo.")
        if padre.id == i.id or padre.padre_id == i.id:
            raise ErrorIssues(422, "Una issue no puede colgar de sí misma.")
    if datos.get("fecha_limite") is not None and not DIA.match(datos["fecha_limite"]):
        raise ErrorIssues(422, "La fecha límite va como AAAA-MM-DD.")
    if datos.get("estimacion") is not None and not 0 <= int(datos["estimacion"]) <= 100:
        raise ErrorIssues(422, "Estimación fuera de rango.")


def _poner_etiquetas(s, i: TeamIssue, ids: list[str], actor: int | None, registrar: bool = True) -> None:
    validas = set(s.scalars(select(TeamEtiqueta.id).where(TeamEtiqueta.proyecto_id == i.proyecto_id,
                                                          TeamEtiqueta.id.in_(ids or []))))
    if set(ids or []) - validas:
        raise ErrorIssues(422, "Alguna etiqueta no es de este equipo.")
    antes = set(s.scalars(select(TeamIssueEtiqueta.etiqueta_id).where(TeamIssueEtiqueta.issue_id == i.id)))
    if antes == validas:
        return
    s.execute(delete(TeamIssueEtiqueta).where(TeamIssueEtiqueta.issue_id == i.id))
    for eid in validas:
        s.add(TeamIssueEtiqueta(issue_id=i.id, etiqueta_id=eid))
    if registrar:
        _registrar(s, i, actor, "etiquetas", ",".join(sorted(antes)), ",".join(sorted(validas)))


CAMPOS = ("titulo", "descripcion", "estado_id", "prioridad", "estimacion", "asignado_id",
          "agente_rol", "ciclo_id", "iniciativa_id", "padre_id", "fecha_limite", "orden")


def crear_issue(proyecto_id: str, uid: int, datos: dict[str, Any]) -> str:
    titulo = (datos.get("titulo") or "").strip()
    if not titulo:
        raise ErrorIssues(422, "La issue necesita un título.")
    for _ in range(3):
        try:
            with get_session() as s:
                p = _exigir_miembro(s, proyecto_id, uid)
                asegurar_tablero(s, p)
                estado = _estado_valido(s, proyecto_id, datos.get("estado_id"))
                p.issues_contador = (p.issues_contador or 0) + 1
                ts = now_iso()
                menor = s.scalar(select(func.min(TeamIssue.orden)).where(
                    TeamIssue.proyecto_id == proyecto_id, TeamIssue.estado_id == estado.id))
                i = TeamIssue(id=_id("is"), proyecto_id=proyecto_id, numero=p.issues_contador,
                              titulo=titulo[:200], descripcion=(datos.get("descripcion") or "")[:20000],
                              estado_id=estado.id, prioridad=0, orden=(menor or 0) - 1,
                              creado_por=uid, creado_en=ts, actualizado_en=ts,
                              cerrado_en=ts if estado.tipo in CERRADOS else None)
                _validar_campos(s, i, datos)
                for k in ("prioridad", "estimacion", "asignado_id", "agente_rol", "ciclo_id",
                          "iniciativa_id", "padre_id", "fecha_limite"):
                    if datos.get(k) is not None:
                        setattr(i, k, datos[k])
                s.add(i)
                s.flush()
                if datos.get("etiquetas"):
                    _poner_etiquetas(s, i, datos["etiquetas"], uid, registrar=False)
                _registrar(s, i, uid, "creada", None, i.titulo)
                return i.id
        except IntegrityError:
            continue   # dos altas a la vez con el mismo número: se reintenta con el siguiente
    raise ErrorIssues(409, "No se pudo numerar la issue; prueba otra vez.")


def editar_issue(issue_id: str, uid: int | None, datos: dict[str, Any]) -> str:
    """Campo a campo, con actividad por cada cambio. Gana el último que escribe."""
    with get_session() as s:
        if uid is None:
            i = s.get(TeamIssue, issue_id)
            if not i or i.borrado_en:
                raise ErrorIssues(404, "No existe esa issue.")
        else:
            i, _ = _issue_de(s, issue_id, uid)
        _validar_campos(s, i, datos)
        for k in CAMPOS:
            if k not in datos:
                continue
            nuevo = datos[k]
            if k == "titulo":
                nuevo = (nuevo or "").strip()[:200]
                if not nuevo:
                    raise ErrorIssues(422, "La issue necesita un título.")
            if k == "descripcion":
                nuevo = (nuevo or "")[:20000]
            if k == "estado_id":
                e = _estado_valido(s, i.proyecto_id, nuevo)
                nuevo = e.id
                if e.tipo in CERRADOS and not i.cerrado_en:
                    i.cerrado_en = now_iso()
                elif e.tipo not in CERRADOS:
                    i.cerrado_en = None
            if getattr(i, k) == nuevo:
                continue
            if k not in ("orden", "descripcion"):
                _registrar(s, i, uid, k, getattr(i, k), nuevo)
            elif k == "descripcion":
                _registrar(s, i, uid, k, None, None)
            setattr(i, k, nuevo)
        if "etiquetas" in datos:
            _poner_etiquetas(s, i, datos["etiquetas"] or [], uid)
        i.actualizado_en = now_iso()
        return i.proyecto_id


def borrar_issue(issue_id: str, uid: int) -> str:
    """Lápida: la issue desaparece de todas partes, pero su número no se
    reutiliza y su historial se queda."""
    with get_session() as s:
        i, _ = _issue_de(s, issue_id, uid)
        i.borrado_en = now_iso()
        _registrar(s, i, uid, "borrada", None, None)
        for hija in s.scalars(select(TeamIssue).where(TeamIssue.padre_id == i.id)):
            hija.padre_id = None
        return i.proyecto_id


def detalle(issue_id: str, uid: int) -> dict[str, Any]:
    with get_session() as s:
        i, p = _issue_de(s, issue_id, uid)
        base = _resumenes(s, [i], p.issues_prefijo)[0]
        hijas = list(s.scalars(select(TeamIssue).where(TeamIssue.padre_id == i.id,
                                                      TeamIssue.borrado_en.is_(None))
                               .order_by(TeamIssue.numero)))
        coms = list(s.scalars(select(TeamIssueComentario).where(TeamIssueComentario.issue_id == i.id)
                              .order_by(TeamIssueComentario.creado_en)))
        act = list(s.scalars(select(TeamIssueActividad).where(TeamIssueActividad.issue_id == i.id)
                             .order_by(TeamIssueActividad.en.desc(), TeamIssueActividad.id.desc())
                             .limit(100)))
        vins = list(s.scalars(select(TeamIssueVinculo).where(TeamIssueVinculo.issue_id == i.id)
                              .order_by(TeamIssueVinculo.creado_en)))
        estados = list(s.scalars(select(TeamEstado).where(TeamEstado.proyecto_id == i.proyecto_id)
                                 .order_by(TeamEstado.orden)))
        return {
            **base,
            "descripcion": i.descripcion,
            "estado": next((_estado_salida(e) for e in estados if e.id == i.estado_id), None),
            "estados": [_estado_salida(e) for e in estados],
            "subtareas_lista": _resumenes(s, hijas, p.issues_prefijo),
            "comentarios_lista": [_comentario_salida(c) for c in coms],
            "actividad": [
                {"id": a.id, "actor_id": a.actor_id, "campo": a.campo, "antes": a.antes,
                 "despues": a.despues, "en": a.en}
                for a in reversed(act)
            ],
            "vinculos_lista": [_vinculo_salida(v) for v in vins],
        }


def _comentario_salida(c: TeamIssueComentario) -> dict[str, Any]:
    return {"id": c.id, "issue_id": c.issue_id, "autor_id": c.autor_id, "texto": c.texto,
            "de_agente": c.de_agente, "creado_en": c.creado_en, "editado_en": c.editado_en}


def _vinculo_salida(v: TeamIssueVinculo) -> dict[str, Any]:
    return {"id": v.id, "tipo": v.tipo, "ref": v.ref, "estado": v.estado, "url": v.url,
            "creado_en": v.creado_en}


def comentar(issue_id: str, uid: int, texto: str, de_agente: str | None) -> tuple[str, dict[str, Any]]:
    texto = (texto or "").strip()
    if not texto:
        raise ErrorIssues(422, "El comentario está vacío.")
    if de_agente is not None and de_agente not in ROLES_AGENTE:
        raise ErrorIssues(422, "Rol de agente desconocido.")
    with get_session() as s:
        i, _ = _issue_de(s, issue_id, uid)
        c = TeamIssueComentario(id=_id("co"), issue_id=i.id, autor_id=uid, texto=texto[:20000],
                                de_agente=de_agente, creado_en=now_iso())
        s.add(c)
        i.actualizado_en = now_iso()
        s.flush()
        return i.proyecto_id, _comentario_salida(c)


def borrar_comentario(comentario_id: str, uid: int) -> tuple[str, str]:
    with get_session() as s:
        c = s.get(TeamIssueComentario, comentario_id)
        if not c:
            raise ErrorIssues(404, "No existe ese comentario.")
        i, _ = _issue_de(s, c.issue_id, uid)
        if c.autor_id != uid:
            raise ErrorIssues(403, "Solo quien lo escribió puede borrarlo.")
        s.delete(c)
        return i.proyecto_id, i.id


def vincular(issue_id: str, uid: int | None, tipo: str, ref: str, estado: str | None,
             url: str | None) -> str:
    """Rama, PR o commit. Repetir el mismo vínculo solo actualiza su estado, y
    los automatismos del equipo mueven la issue: abrir un PR la pasa a revisión
    y fusionarlo, a hecho."""
    if tipo not in TIPOS_VINCULO:
        raise ErrorIssues(422, "Tipo de vínculo desconocido.")
    ref = (ref or "").strip()[:200]
    if not ref:
        raise ErrorIssues(422, "Falta la referencia.")
    if url and not url.startswith("https://"):
        raise ErrorIssues(422, "Solo enlaces https.")
    with get_session() as s:
        if uid is None:
            i = s.get(TeamIssue, issue_id)
            if not i or i.borrado_en:
                raise ErrorIssues(404, "No existe esa issue.")
            p = s.get(TeamProyecto, i.proyecto_id)
        else:
            i, p = _issue_de(s, issue_id, uid)
        v = s.scalars(select(TeamIssueVinculo).where(TeamIssueVinculo.issue_id == i.id,
                                                    TeamIssueVinculo.tipo == tipo,
                                                    TeamIssueVinculo.ref == ref)).first()
        if v:
            v.estado = estado or v.estado
            v.url = url or v.url
        else:
            s.add(TeamIssueVinculo(id=_id("vi"), issue_id=i.id, tipo=tipo, ref=ref, estado=estado,
                                   url=url, creado_en=now_iso()))
            _registrar(s, i, uid, "vinculo", None, f"{tipo}:{ref}")
        auto = _config(p)["automatismos"]
        destino = None
        if tipo == "rama" and auto.get("rama"):
            destino = "en_curso"
        if tipo == "pr" and auto.get("pr"):
            destino = {"abierto": "revision", "fusionado": "hecho"}.get(estado or "")
        if destino:
            actual = s.get(TeamEstado, i.estado_id)
            orden = list(TIPOS_ESTADO)
            # Solo hacia delante: un PR abierto no devuelve a revisión algo ya hecho.
            if actual and actual.tipo not in CERRADOS and orden.index(destino) > orden.index(actual.tipo):
                e = s.scalars(select(TeamEstado).where(TeamEstado.proyecto_id == i.proyecto_id,
                                                       TeamEstado.tipo == destino)
                              .order_by(TeamEstado.orden)).first()
                if e:
                    _registrar(s, i, uid, "estado_id", i.estado_id, e.id)
                    i.estado_id = e.id
                    if e.tipo in CERRADOS:
                        i.cerrado_en = now_iso()
        i.actualizado_en = now_iso()
        return i.proyecto_id


def buscar_por_clave(uid: int, clave: str) -> dict[str, Any] | None:
    """«LXB-12» → la issue, si es de un equipo del usuario. Es lo que usan el
    chat para desplegar tarjetas y el IDE para ligar ramas."""
    m = re.match(r"^([A-Za-z][A-Za-z0-9]{0,4})-(\d+)$", (clave or "").strip())
    if not m:
        return None
    with get_session() as s:
        for p in s.scalars(select(TeamProyecto).join(TeamMiembro, TeamMiembro.proyecto_id == TeamProyecto.id)
                           .where(TeamMiembro.usuario_id == uid,
                                  TeamProyecto.issues_prefijo == m.group(1).upper())):
            i = s.scalars(select(TeamIssue).where(TeamIssue.proyecto_id == p.id,
                                                  TeamIssue.numero == int(m.group(2)),
                                                  TeamIssue.borrado_en.is_(None))).first()
            if i:
                return _resumenes(s, [i], p.issues_prefijo)[0]
    return None



# ── GitHub ─────────────────────────────────────────────────────────────────

def secreto_webhook(proyecto_id: str, uid: int, rotar: bool = False) -> dict[str, Any]:
    """El secreto con el que GitHub firma los avisos de este equipo. Solo lo ve
    el líder, que es quien lo pega en GitHub; rotarlo invalida el anterior."""
    import secrets as _secrets
    with get_session() as s:
        p = _exigir_miembro(s, proyecto_id, uid, lider=True)
        if rotar or not p.github_webhook_secreto:
            p.github_webhook_secreto = _secrets.token_hex(24)
        return {"secreto": p.github_webhook_secreto, "repo": p.github_repo}


def webhook_de(proyecto_id: str) -> dict[str, Any] | None:
    with get_session() as s:
        p = s.get(TeamProyecto, proyecto_id)
        if not p:
            return None
        return {"secreto": p.github_webhook_secreto, "repo": p.github_repo, "prefijo": p.issues_prefijo}


def issues_por_claves(proyecto_id: str, prefijo: str, textos: list[str]) -> list[str]:
    """Las issues de este equipo nombradas en unos textos («LXB-12», o
    «lxb-12» dentro de una rama como lx/lxb-12-macos)."""
    if not prefijo:
        return []
    patron = re.compile(rf"(?<![A-Za-z0-9]){re.escape(prefijo)}-(\d+)(?![0-9])", re.IGNORECASE)
    numeros = {int(m.group(1)) for t in textos if t for m in patron.finditer(t)}
    if not numeros:
        return []
    with get_session() as s:
        return list(s.scalars(select(TeamIssue.id).where(
            TeamIssue.proyecto_id == proyecto_id, TeamIssue.numero.in_(numeros),
            TeamIssue.borrado_en.is_(None))))
