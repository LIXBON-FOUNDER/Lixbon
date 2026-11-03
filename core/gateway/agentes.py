"""
Ejecuta los agentes programados de los Espacios.

Un bucle en el gateway mira cada 30 s qué agentes tocan
(`espacios.reclamar_pendientes`, que reparte bien entre réplicas) y lanza
cada ejecución como una tarea. La ejecución es un turno del modelo con el
contexto del espacio (instrucciones, memoria, archivos), la tarea, lo que
salió las últimas veces y, si el agente lo tiene activado, una búsqueda en
internet. El modelo responde en JSON: el resultado para leer y un resumen
(lo que hizo, lo que hay que tener en cuenta, los siguientes pasos). Se cobra
como cualquier turno del chat web del usuario.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from core.billing.quota import ensure_can_chat, record_session_week_tokens, record_tokens
from core.gateway import deps
from core.gateway.model_router import model_for_request, target_or_503
from core.gateway.utils import fetch_models
from core.inference import websearch
from core.inference.ollama import chat as ollama_chat
from core.inference.roles import resolve_catalog_id, resolve_num_ctx
from core.persistence import espacios as store
from core.persistence.queries import get_plan_for_user, record_model_usage, record_service_usage

logger = logging.getLogger("lixbon.agentes")

INTERVALO = 30
DIAS = ("lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo")

INSTRUCCIONES = """Eres un agente de Lixbon que trabaja solo, sin nadie delante, en un horario que fijó el usuario.
Haz la tarea con lo que tienes: el contexto del espacio, los resultados de búsqueda si los hay y lo que hiciste las últimas veces (no repitas lo mismo si no hace falta).
No puedes publicar, enviar ni cambiar nada fuera de Lixbon: entrega el trabajo hecho (textos, listas, borradores, análisis) para que el usuario lo use.
Si te falta algo imprescindible, no lo inventes: dilo en "tener_en_cuenta" y marca "necesita_usuario": true.

Responde SOLO con un objeto JSON con esta forma:
{
  "resultado": "el trabajo completo en Markdown",
  "hizo": ["frases cortas de lo que hiciste"],
  "tener_en_cuenta": ["avisos o datos que el usuario debe saber (puede ir vacío)"],
  "siguientes": ["lo que conviene hacer después (puede ir vacío)"],
  "necesita_usuario": false,
  "memoria": ["algo estable que convenga recordar en próximas ejecuciones (normalmente vacío)"]
}
"hizo" cuenta el trabajo como se lo contarías al usuario («Propuso 2 posts para el viernes»), nunca el formato de la respuesta.
Escribe en el idioma de la tarea."""


def _lista(v: Any, n: int = 6) -> list[str]:
    if isinstance(v, str):
        v = [v]
    if not isinstance(v, list):
        return []
    return [str(x).strip()[:400] for x in v if str(x).strip()][:n]


def interpretar(texto: str) -> dict[str, Any]:
    """El JSON del modelo, tolerante: si no es JSON, todo el texto es el resultado."""
    t = (texto or "").strip()
    if t.startswith("```"):
        t = t.strip("`")
        t = t[t.find("\n") + 1:] if "\n" in t else t
    ini, fin = t.find("{"), t.rfind("}")
    datos: dict[str, Any] = {}
    if ini != -1 and fin > ini:
        try:
            datos = json.loads(t[ini:fin + 1])
        except ValueError:
            datos = {}
    if not isinstance(datos, dict) or not datos.get("resultado"):
        return {"resultado": texto.strip(), "hizo": [], "tener_en_cuenta": [], "siguientes": [],
                "necesita_usuario": False, "memoria": []}
    return {
        "resultado": str(datos.get("resultado") or "").strip(),
        "hizo": _lista(datos.get("hizo")),
        "tener_en_cuenta": _lista(datos.get("tener_en_cuenta")),
        "siguientes": _lista(datos.get("siguientes")),
        "necesita_usuario": bool(datos.get("necesita_usuario")),
        "memoria": _lista(datos.get("memoria"), 3),
    }


def _modelo_disponible(catalogo: list[dict[str, Any]], model: str) -> str:
    """El modelo del rol `chat` si está en el catálogo; si no, el primero que
    haya. El chat web elige entre los del catálogo, pero el agente no tiene
    selector: con un rol apuntando a un modelo que nadie sirve, fallaba siempre."""
    if resolve_catalog_id(catalogo, model):
        return model
    ids = [m.get("id") for m in catalogo
           if m.get("id") and not str(m["id"]).startswith("error:")
           and (not m.get("capabilities") or "completion" in m["capabilities"])]
    return ids[0] if ids else model


def _anteriores(previas: list[dict[str, Any]]) -> str:
    lineas = []
    for p in previas:
        r = p.get("resumen") or {}
        hizo = "; ".join(r.get("hizo") or []) or "(sin resumen)"
        lineas.append(f"- {p['inicio'][:16].replace('T', ' ')} UTC: {hizo}")
    return "Lo que hiciste las últimas veces:\n" + "\n".join(lineas) if lineas else ""


async def ejecutar(agente_id: str, origen: str = "horario", uid: int | None = None) -> str | None:
    """Corre una ejecución y la deja cerrada. Devuelve su id, o None si ya
    había una en curso."""
    abierta = await run_in_threadpool(store.iniciar_ejecucion, agente_id, origen, uid)
    if not abierta:
        return None
    ag, eje_id = abierta
    asyncio.create_task(_correr(ag, eje_id))
    return eje_id


async def _correr(ag: dict[str, Any], eje_id: str) -> None:
    uid = ag["user_id"]
    model = None
    try:
        model, role = await model_for_request(None, "chat", None)
        catalogo = await fetch_models()
        model = _modelo_disponible(catalogo, model)
        plan = await run_in_threadpool(get_plan_for_user, uid)
        await run_in_threadpool(ensure_can_chat, uid, plan, model)
        base, headers, _ = target_or_503(model, afinidad=f"user:{uid}")
        num_ctx = resolve_num_ctx(None, role.num_ctx, catalogo, model)

        ahora = datetime.now(timezone.utc)
        tarea = (f"Hoy es {DIAS[ahora.weekday()]} {ahora.strftime('%d/%m/%Y')} ({ahora.strftime('%H:%M')} UTC).\n\n"
                 f"Tarea del agente «{ag['nombre']}»:\n{ag['tarea']}")
        sistema = [INSTRUCCIONES, ag["contexto"]]
        previas = _anteriores(await run_in_threadpool(store.ultimos_resultados, ag["id"]))
        if previas:
            sistema.append(previas)
        tokens_in = tokens_out = cached = 0

        if ag["internet"]:
            async def _preguntar(msgs: list[dict]) -> str:
                nonlocal tokens_in, tokens_out
                r = await ollama_chat(base, model, msgs, headers=headers, client=deps.http_client_chat,
                                      keep_alive=role.keep_alive, format="json", think=False, num_ctx=num_ctx)
                tokens_in += int(r.get("prompt_eval_count") or 0)
                tokens_out += int(r.get("eval_count") or 0)
                return (r.get("message") or {}).get("content", "")

            consultas = await websearch.plan_queries([{"role": "user", "content": tarea}], _preguntar)
            fuentes = await websearch.research(consultas) if consultas else []
            sistema.append(websearch.build_context(ag["tarea"], fuentes, consultas))

        mensajes = [{"role": "system", "content": "\n\n".join(sistema)}, {"role": "user", "content": tarea}]
        inicio = time.perf_counter()
        resp = await ollama_chat(base, model, mensajes, headers=headers, client=deps.http_client_chat,
                                 keep_alive=role.keep_alive, format="json", think=False, num_ctx=num_ctx)
        tokens_in += int(resp.get("prompt_eval_count") or 0)
        tokens_out += int(resp.get("eval_count") or 0)
        cached += int(resp.get("prompt_eval_cached_count") or 0)
        datos = interpretar((resp.get("message") or {}).get("content", ""))

        def _cobrar() -> None:
            record_model_usage(uid, model, tokens_in, tokens_out, int((time.perf_counter() - inicio) * 1000))
            record_service_usage(uid, "web", tokens_in + tokens_out)
            record_tokens(uid, tokens_in + tokens_out)
            record_session_week_tokens(uid, model, tokens_in, tokens_out, cached)
        await run_in_threadpool(_cobrar)

        if not datos["resultado"]:
            raise RuntimeError("El modelo no devolvió nada")
        await run_in_threadpool(
            lambda: store.cerrar_ejecucion(
                eje_id, estado="espera" if datos["necesita_usuario"] else "hecho",
                resultado=datos["resultado"],
                resumen={k: datos[k] for k in ("hizo", "tener_en_cuenta", "siguientes")},
                modelo=model, tokens=tokens_in + tokens_out, memoria_propuesta=datos["memoria"]))
        logger.info(f"[agentes] {ag['id']} terminó ({tokens_in + tokens_out} tokens)")
    except Exception as exc:  # noqa: BLE001 — una ejecución fallida no tumba el bucle
        if isinstance(exc, HTTPException):
            d = exc.detail
            motivo = d.get("message") if isinstance(d, dict) else str(d)
        else:
            motivo = str(exc) or exc.__class__.__name__
        logger.warning(f"[agentes] {ag['id']} falló: {motivo}")
        await run_in_threadpool(lambda: store.cerrar_ejecucion(eje_id, estado="error", error=motivo[:500],
                                                               modelo=model))


async def _bucle() -> None:
    while True:
        try:
            for agente_id in await run_in_threadpool(store.reclamar_pendientes):
                try:
                    await ejecutar(agente_id, "horario")
                except Exception as exc:  # noqa: BLE001
                    logger.warning(f"[agentes] no se pudo lanzar {agente_id}: {exc}")
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[agentes] error en el bucle: {exc}")
        await asyncio.sleep(INTERVALO)


def iniciar_programador() -> asyncio.Task:
    return asyncio.create_task(_bucle(), name="agentes-programados")
