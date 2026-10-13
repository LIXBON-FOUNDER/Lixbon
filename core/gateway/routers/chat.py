"""
Cubre: /v1/models, /v1/chat/completions, /v1/completions, /api/chat, /api/delegate

F2: TODA la inferencia se enruta por el orquestador (ollama_target), que elige
el mejor nodo GPU y cae al Ollama local del gateway solo si no hay nodos.
El streaming persiste el mensaje del asistente y los tokens al terminar.
"""
from __future__ import annotations
import json
import logging
import time
import uuid
from datetime import date
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from core.gateway import deps
from core.config import CHAT_THINK, OLLAMA_BASE_URL
from core.billing import credits
from core.billing.quota import (
    compute_credit_cost,
    credits_remaining,
    ensure_can_chat,
    ensure_can_use_visuals,
    quota_notice,
    record_session_week_tokens,
    record_tokens,
    resolve_model_weight,
)
from core.persistence.queries import (
    ensure_conversation,
    find_similar_tasks,
    get_plan_for_user,
    get_user_settings,
    record_model_usage,
    save_message,
    update_message,
    save_task_embedding,
)
from core.delegation.embeddings import classify_request, get_embedding, pick_classifier_model, route_request
from core.inference.ollama import (
    chat as ollama_chat,
    generate as ollama_generate,
    embed_many as ollama_embed_many,
    gradua_razonamiento,
    stream_chat_openai,
)
from core.inference import websearch
from core.security.auth import (
    api_key_required,
    session_or_api_key,
    validate_model_access,
    web_or_api_key_auth,
)
from core.gateway.utils import fetch_models
from core.gateway.model_router import model_for_request, target_or_503
from core.inference.aliases import public_catalog, to_public
from core.orchestration.orchestrator import ModelUnavailable
from core.inference.context import fit_messages
from core.inference.esfuerzo import nivel_de_razonamiento, pide_datos_actuales, podria_necesitar_internet
from core.inference.roles import REQUIRED_CAPABILITY, capabilities_of, resolve_all, resolve_num_ctx

logger = logging.getLogger("lixbon.chat")
router = APIRouter()


def _is_external_api(user_data: dict[str, Any], plan: dict[str, Any]) -> bool:
    """True cuando el tráfico se cobra con créditos prepago
    (credits.ensure_can_use_api) en vez de con el pool de sesión/semana:

    - Una API key: siempre créditos, sin importar el plan.
    - La sesión de desktop o CLI: créditos SOLO en el plan Free — decisión de
      negocio: el chat gratis sin comprar créditos es de web y móvil. Pro y
      Advance en esas apps sí comparten el pool de sesión/semana.
    - La web y el móvil: siempre el pool.
    """
    if user_data.get("auth_via") == "api_key":
        return True
    return user_data.get("client") in ("desktop", "cli") and plan.get("id") == "free"


class ChatMessage(BaseModel):
    role: str
    content: str = ""  # los mensajes 'assistant' con solo tool_calls van sin content
    # Imágenes en base64 (passthrough a Ollama para modelos multimodales).
    # No se persisten en el historial: solo viajan al modelo.
    images: list[str] | None = None
    # Tool-calling nativo (round-trip): el assistant devuelve tool_calls y el
    # cliente responde con role="tool". Passthrough a Ollama; no se persisten.
    tool_calls: list[dict] | None = None
    tool_call_id: str | None = None
    name: str | None = None
    # Razonamiento de un paso con tool_calls: los modelos thinking (qwen3,
    # gpt-oss) lo esperan de vuelta dentro del mismo turno; sin él repiten la
    # llamada que acaban de hacer. Passthrough a Ollama; no se persiste.
    thinking: str | None = None


class ChatCompletionRequest(BaseModel):
    # Opcional: si no llega, lo decide el rol `chat` del gateway (tabla
    # model_roles → MODEL_ROLE_CHAT → autodetección por capability).
    model: str | None = Field(None, description="Modelo de Ollama; vacío = el del rol chat")
    messages: list[ChatMessage]
    conversation_id: str | None = None
    title: str | None = None
    client_id: str | None = None
    stream: bool = False
    # Búsqueda web: True fuerza la investigación, "auto" deja que el modelo
    # decida si hace falta (planificador), False no busca.
    web_search: bool | Literal["auto"] = False
    # Origen (web/mobile/ide/cli): historial independiente por superficie.
    source: str | None = None
    # Ventana de contexto de Ollama. None ⇒ default de Ollama (4096). Subirla
    # evita que el modelo trunque en archivos/conversaciones grandes (aunque el
    # modelo soporte 256K, Ollama solo usa 4096 salvo que se le indique).
    num_ctx: int | None = None
    # Definiciones de funciones para tool-calling nativo (passthrough a Ollama).
    # None ⇒ comportamiento clásico (la web nunca las envía).
    tools: list[dict] | None = None
    tool_choice: Any | None = None
    # Razonamiento previo de los modelos thinking (qwen3, deepseek-r1…).
    # None ⇒ CHAT_THINK del entorno (apagado por defecto). Los niveles solo
    # los distingue gpt-oss; para los demás equivalen a True.
    think: bool | Literal["low", "medium", "high"] | None = None
    # Petición efímera (edición inline Ctrl+K del IDE): no crea conversación ni
    # guarda contenido, pero el uso se contabiliza/cobra igual. La web no lo envía.
    no_persist: bool = False


def _normalize_for_ollama(messages: list[dict]) -> list[dict]:
    """Adapta los mensajes OpenAI al formato que espera Ollama en /api/chat:
    los tool_calls llevan `arguments` como string JSON en OpenAI, pero Ollama
    los quiere como objeto. Se ignoran campos que Ollama no entiende."""
    out = []
    for m in messages:
        calls = m.get("tool_calls")
        if calls:
            fixed = []
            for c in calls:
                fn = (c.get("function") or {})
                args = fn.get("arguments", {})
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except Exception:
                        args = {}
                fixed.append({"function": {"name": fn.get("name", ""), "arguments": args}})
            m = {**m, "tool_calls": fixed}
            m.pop("tool_call_id", None)
            m.pop("name", None)
        out.append(m)
    return out


def _primer_paso(messages: list[dict]) -> bool:
    """El mensaje del usuario y no un paso intermedio del agente: en el
    protocolo de texto los resultados de herramientas también van como user."""
    if not messages or messages[-1].get("role") != "user":
        return False
    texto = str(messages[-1].get("content") or "")
    return not texto.startswith(("TOOL_RESULT", "Imágenes de los read_file"))


def _con_fecha(messages: list[dict]) -> list[dict]:
    """Sin la fecha real el modelo da por buena la de su corte («hoy es 2024»)."""
    nota = f"Hoy es {date.today().strftime('%d/%m/%Y')}."
    if messages and messages[0].get("role") == "system":
        return [{**messages[0], "content": f"{messages[0].get('content') or ''}\n\n{nota}"}, *messages[1:]]
    return [{"role": "system", "content": nota}, *messages]


class UIChatRequest(BaseModel):
    model: str | None = None
    message: str
    conversation_id: str | None = None
    title: str | None = None


class CompletionRequest(BaseModel):
    model: str | None = Field(None, description="Modelo de Ollama; vacío = el del rol chat")
    prompt: str
    conversation_id: str | None = None
    title: str | None = None
    client_id: str | None = None
    stream: bool = False


class DelegateRequest(BaseModel):
    user_input: str = Field(..., description="Solicitud del usuario en lenguaje natural")
    conversation_id: str | None = None


async def _routed_chat(model: str, messages: list[dict], num_ctx: int | None = None,
                       keep_alive: str | None = None, think: bool | str | None = None) -> tuple[dict[str, Any], str]:
    """
    Ejecuta un chat por el mejor nodo; si el nodo falla, fallback al Ollama local.
    Retorna (respuesta_ollama, origen).
    `keep_alive`: residencia en VRAM del rol (ver core/inference/roles.py).
    """
    base, headers, origen = target_or_503(model)
    try:
        resp = await ollama_chat(base, model, messages, headers=headers, client=deps.http_client_chat,
                                 num_ctx=num_ctx, keep_alive=keep_alive, think=think)
        return resp, origen
    except httpx.HTTPStatusError as exc:
        if origen == "local":
            raise HTTPException(status_code=502, detail=f"Error de Ollama: {exc.response.text}") from exc
        logger.warning(f"[chat] Nodo '{origen}' respondió error ({exc}); fallback local")
    except Exception as exc:
        if origen == "local":
            raise HTTPException(status_code=502, detail=f"No se pudo conectar con Ollama: {exc}") from exc
        logger.warning(f"[chat] Nodo '{origen}' inaccesible ({exc}); fallback local")

    try:
        resp = await ollama_chat(OLLAMA_BASE_URL, model, messages, client=deps.http_client_chat,
                                 num_ctx=num_ctx, keep_alive=keep_alive, think=think)
        return resp, "local-fallback"
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Sin nodos disponibles y sin Ollama local: {exc}") from exc


# Cada cuántos segundos se vuelca a BD el texto parcial de una respuesta en
# streaming. Un deploy (SIGTERM + SIGKILL) pierde como mucho este tramo.
CHECKPOINT_SECONDS = 4.0


def _persist_assistant(conv_id: str, model: str, text: str,
                       prompt_tokens: int, completion_tokens: int, latency_ms: int,
                       user_id: int | None = None, save_history: bool = True,
                       bill_credits: bool = False, message_id: int | None = None) -> None:
    if save_history:
        if message_id is not None:
            update_message(message_id, text, prompt_tokens, completion_tokens, latency_ms, record_usage=True)
        else:
            save_message(
                conv_id, "assistant", text,
                model=model,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                latency_ms=latency_ms,
            )
    elif user_id is not None:
        # Privacidad: sin historial no se persiste contenido, pero el uso
        # (tokens por modelo) sí se contabiliza.
        record_model_usage(user_id, model, prompt_tokens, completion_tokens, latency_ms)
    if user_id is not None:
        if bill_credits:
            # Tráfico de API key externa: se cobra del saldo prepago, no del pool de plan
            credits.debit_usage(user_id, model, prompt_tokens, completion_tokens)
        else:
            # Sesión web o app de primera parte: cuenta contra el pool de la cuenta
            record_tokens(user_id, prompt_tokens + completion_tokens)  # F5 legacy (stats + credits.py)
            record_session_week_tokens(user_id, model, prompt_tokens, completion_tokens)  # F8: gate real


def _caracteres_emitidos(chunk: str) -> int:
    if not chunk.startswith("data: {"):
        return 0
    try:
        choices = json.loads(chunk[6:]).get("choices") or [{}]
    except ValueError:
        return 0
    delta = choices[0].get("delta") or {}
    return len(delta.get("content") or "") + len(delta.get("reasoning_content") or "")


class WebSearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=400)
    limit: int = Field(5, ge=1, le=10)


@router.post("/api/websearch")
async def web_search_endpoint(
    payload: WebSearchRequest,
    user_data: dict[str, Any] = Depends(web_or_api_key_auth),
):
    """Búsqueda web para la herramienta `web_search` del CLI/IDE: mismos
    proveedores que el modo investigar del chat, sin pasar por el modelo."""
    results = await websearch.search(payload.query, payload.limit)
    return {
        "query": payload.query,
        "results": [{"title": r.get("title", ""), "url": r.get("url", ""),
                     "snippet": r.get("snippet", "")} for r in results],
        "providers": websearch.providers_configured(),
    }


def _sin_errores(catalog: list[Any]) -> list[Any]:
    """fetch_models() usa una entrada `error: …` como centinela interno cuando
    no hay ningún modelo alcanzable; a los clientes no les sirve como modelo."""
    return [e for e in catalog if not (isinstance(e, dict) and str(e.get("id", "")).startswith("error:"))]


@router.get("/v1/models")
async def models(user_data: dict[str, Any] = Depends(web_or_api_key_auth)):
    """Catálogo + `num_ctx` efectivo por modelo (lo que la web usa para el
    indicador de contexto)."""
    catalog = await fetch_models()
    chat_role = resolve_all(catalog)["chat"]
    data = []
    for entry in _sin_errores(catalog):
        if isinstance(entry, dict):
            entry = {**entry, "num_ctx": resolve_num_ctx(None, chat_role.num_ctx, catalog, entry.get("id")) or 4096}
            if "thinking" in (entry.get("capabilities") or []):
                entry["reasoning"] = "levels" if gradua_razonamiento(entry.get("model") or entry.get("id")) else "toggle"
        data.append(entry)
    return {"object": "list", "data": public_catalog(data, include_raw=user_data.get("role") == "admin")}


@router.get("/api/model-roles")
async def model_roles(user_data: dict[str, Any] = Depends(web_or_api_key_auth)):
    """Qué modelo sirve cada rol de inferencia ahora mismo.

    Los clientes lo usan para no adivinar: el IDE sabe qué modelo pedir para el
    autocompletado (y si debe desactivarlo porque ninguno soporta FIM) sin
    inventar heurísticos sobre el nombre del modelo. Incluye el catálogo para
    ahorrar un round-trip a /v1/models.
    """
    catalog = await fetch_models()
    roles = {}
    for r, res in resolve_all(catalog).items():
        d = res.as_dict()
        d["model"] = to_public(d.get("model"))
        roles[r] = d
    return {
        "roles": roles,
        "capability_by_role": REQUIRED_CAPABILITY,
        "models": _sin_errores(catalog),
    }


@router.post("/api/chat")
async def api_chat(
    payload: UIChatRequest,
    user_data: dict[str, Any] = Depends(session_or_api_key),
):
    """Chat desde el dashboard web. Enrutado por el orquestador (F2)."""
    model, role = await model_for_request(payload.model, "chat", user_data)
    plan = get_plan_for_user(user_data["id"])
    ensure_can_chat(user_data["id"], plan, model)  # F5: límites del plan
    save_history = get_user_settings(user_data["id"])["save_history"]

    conv_id = payload.conversation_id or str(uuid.uuid4())
    if save_history:
        if not ensure_conversation(conv_id, user_data["id"], payload.title, "dashboard", source="web"):
            raise HTTPException(status_code=404, detail="Conversación no encontrada")
        save_message(conv_id, "user", payload.message, model=model)

    started_at = time.perf_counter()
    ollama_resp, origen = await _routed_chat(model, [{"role": "user", "content": payload.message}],
                                            num_ctx=resolve_num_ctx(None, role.num_ctx, await fetch_models(), model),
                                            keep_alive=role.keep_alive)
    latency_ms = int((time.perf_counter() - started_at) * 1000)

    assistant_text = ollama_resp.get("message", {}).get("content", "")
    prompt_tokens = int(ollama_resp.get("prompt_eval_count") or 0)
    completion_tokens = int(ollama_resp.get("eval_count") or 0)
    _persist_assistant(conv_id, model, assistant_text, prompt_tokens, completion_tokens,
                       latency_ms, user_id=user_data["id"], save_history=save_history)

    return {
        "conversation_id": conv_id if save_history else None,
        "model": to_public(model),
        "node": origen,
        "message": assistant_text,
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
        "latency_ms": latency_ms,
    }


@router.post("/v1/chat/completions")
async def chat_completions(
    payload: ChatCompletionRequest,
    user_data: dict[str, Any] = Depends(web_or_api_key_auth),
):
    """Endpoint compatible con OpenAI — chat con modelos del cluster.
    `model` es opcional: sin él se usa el del rol `chat` del gateway."""
    model, role = await model_for_request(payload.model, "chat", user_data)
    validate_model_access(user_data, model)
    plan = get_plan_for_user(user_data["id"])
    is_api = _is_external_api(user_data, plan)
    bill_credits = False
    if is_api:
        # Pro/Advance usan su cuota del plan (no se cobra crédito, evita redundar
        # con lo que ya pagan); Gratuito o cuota agotada ⇒ prepago por créditos.
        bill_credits = credits.ensure_can_use_api(user_data["id"], plan, model) == "credits"
    else:
        if payload.source == "visuals":
            ensure_can_use_visuals(user_data, plan)
        ensure_can_chat(user_data["id"], plan, model)  # sesión/semana (F8) + rate limit
    save_history = get_user_settings(user_data["id"])["save_history"]
    if payload.no_persist:
        save_history = False  # edición inline: sin historial, pero se cobra el uso

    conv_id = payload.conversation_id or str(uuid.uuid4())
    # Origen: lo declara el cliente; si no, se infiere (web = sesión, resto = api)
    source = payload.source or ("web" if user_data.get("client") == "web" else "api")
    if save_history:
        if not ensure_conversation(conv_id, user_data["id"], payload.title, payload.client_id, source=source):
            raise HTTPException(status_code=404, detail="Conversación no encontrada")
        if payload.messages and payload.messages[-1].role == "user":
            save_message(conv_id, "user", payload.messages[-1].content, model=model)

    messages = [m.model_dump(exclude_none=True) for m in payload.messages]
    if payload.tools:
        messages = _normalize_for_ollama(messages)

    base, headers, origen = target_or_503(model)
    catalog = await fetch_models()
    num_ctx = resolve_num_ctx(payload.num_ctx, role.num_ctx, catalog, model)
    nivel = nivel_de_razonamiento(messages)
    think = payload.think if payload.think is not None else CHAT_THINK
    if think is None and not payload.tools:
        caps = capabilities_of(catalog, model)
        if caps is not None and "thinking" in caps:
            # Si el modelo no gradúa, el término medio es no razonar.
            think = nivel if nivel != "low" or gradua_razonamiento(model) else False
        elif nivel is False:
            # Ollama rechaza think=True en un modelo sin razonamiento, no False.
            think = False
    # Visuals apaga el razonamiento porque qwen3.5 escribía el HTML dentro del
    # thinking; gpt-oss separa bien ambos canales y diseña mejor razonando.
    if payload.source == "visuals" and think is False and "gpt-oss" in model.lower():
        think = "medium"

    # "Modo investigar": el modelo decide qué buscar, se busca y se inyecta el
    # contexto antes de responder.
    web_sources: list[dict] = []
    web_queries: list[str] = []
    web_mode = payload.web_search
    datos_actuales = web_mode == "auto" and pide_datos_actuales(messages)
    if web_mode == "auto" and payload.tools and not (datos_actuales and _primer_paso(messages)):
        # Con herramientas (agente) el modelo ya tiene `web_search` como tool
        # y decide él; el planificador solo duplicaría la búsqueda. Excepción:
        # una pregunta que depende del momento, porque los modelos pequeños no
        # llaman a web_search y contestan con datos de su fecha de corte.
        web_mode = False
    if web_mode == "auto" and not podria_necesitar_internet(messages):
        web_mode = False
    if web_mode and messages and messages[-1]["role"] == "user":
        p_model, p_base, p_headers, p_alive = model, base, headers, role.keep_alive
        # Solo si el admin fija el rol `route`: un modelo autodetectado distinto
        # del del chat podría desalojarlo de la VRAM y salir más caro.
        ruta = resolve_all(catalog)["route"]
        if ruta.model and ruta.model != model and ruta.source in ("db", "env"):
            try:
                p_base, p_headers, _ = target_or_503(ruta.model)
                p_model, p_alive = ruta.model, ruta.keep_alive
            except HTTPException:
                pass

        async def _preguntar(planner_messages: list[dict]) -> str:
            resp = await ollama_chat(p_base, p_model, planner_messages, headers=p_headers,
                                     client=deps.http_client_chat, keep_alive=p_alive,
                                     format="json", think=False)
            return (resp.get("message") or {}).get("content", "")

        web_queries = await websearch.plan_queries(
            messages, _preguntar, optional=web_mode == "auto" and not datos_actuales,
        )
        if web_queries:
            web_sources = await websearch.research(web_queries)
            context = websearch.build_context(messages[-1]["content"], web_sources, web_queries)
            messages.insert(len(messages) - 1, {"role": "system", "content": context})

    if not web_queries and source in ("web", "mobile") and not payload.tools:
        messages = _con_fecha(messages)

    messages = fit_messages(messages, num_ctx)
    started_at = time.perf_counter()
    logger.info(f"[chat] model='{model}' ({role.source}) stream={payload.stream} "
                f"target={origen} web={web_mode} think={think}")

    if payload.stream:
        uid = user_data["id"]
        # Cupo de sesión/semana: solo el tráfico que va contra el pool del plan.
        restante = None if is_api else await run_in_threadpool(credits_remaining, uid, plan)
        peso = resolve_model_weight(model) if restante is not None else None
        prompt_est = sum(len(str(m.get("content") or "")) for m in messages) // 4

        async def _stream_and_persist():
            collector: dict[str, Any] = {}
            streamed_something = False
            message_id: int | None = None
            guardado = ""
            ultimo_checkpoint = time.perf_counter()
            salida = 0  # caracteres de texto y razonamiento ya emitidos
            sin_cupo = False
            persistido = False

            async def _checkpoint() -> None:
                # Texto parcial a BD: si el gateway muere a mitad (deploy), la
                # respuesta no desaparece del historial.
                nonlocal message_id, guardado, ultimo_checkpoint
                if not save_history:
                    return
                texto = "".join(collector.get("parts") or [])
                if texto == guardado or not texto:
                    return
                if time.perf_counter() - ultimo_checkpoint < CHECKPOINT_SECONDS:
                    return
                try:
                    if message_id is None:
                        message_id = await run_in_threadpool(
                            save_message, conv_id, "assistant", texto, model, 0, 0, 0, False,
                        )
                    else:
                        await run_in_threadpool(update_message, message_id, texto)
                    guardado = texto
                    ultimo_checkpoint = time.perf_counter()
                except Exception as exc:
                    logger.warning(f"[stream] checkpoint del mensaje falló: {exc}")

            async def _bombear(gen):
                # El [DONE] de Ollama se retiene: antes va el aviso de cupo.
                nonlocal streamed_something, salida, sin_cupo
                try:
                    async for chunk in gen:
                        if chunk.startswith("data: [DONE]"):
                            continue
                        streamed_something = True
                        salida += _caracteres_emitidos(chunk)
                        yield chunk
                        await _checkpoint()
                        if restante is not None and compute_credit_cost(peso, prompt_est, salida // 4) >= restante:
                            sin_cupo = True
                            return
                finally:
                    # Cerrar el generador corta también la petición a Ollama.
                    await gen.aclose()

            def _persistir() -> None:
                # Sin el chunk final de Ollama (corte por cupo, botón de detener)
                # no hay recuento real: se cobra la estimación, no cero.
                nonlocal persistido
                if persistido:
                    return
                persistido = True
                text = collector.get("content", "")
                if not text and not salida:
                    return
                _persist_assistant(
                    conv_id, model, text,
                    collector.get("prompt_tokens") or prompt_est,
                    collector.get("completion_tokens") or salida // 4,
                    int((time.perf_counter() - started_at) * 1000),
                    user_id=uid,
                    save_history=save_history and bool(text),
                    bill_credits=bill_credits,
                    message_id=message_id,
                )

            # Primero, las fuentes (si hubo búsqueda) para que el UI las muestre.
            if web_queries:
                yield f"data: {json.dumps({'lixbon_sources': web_sources, 'lixbon_queries': web_queries})}\n\n"
            try:
                try:
                    async for chunk in _bombear(stream_chat_openai(
                            base, model, messages, headers=headers, collector=collector,
                            tools=payload.tools, num_ctx=num_ctx, keep_alive=role.keep_alive, think=think)):
                        yield chunk
                except Exception as exc:
                    # Fallback local solo si el nodo falló ANTES de emitir contenido
                    # (reintentar a mitad de stream duplicaría texto en el cliente)
                    if origen != "local" and not streamed_something:
                        logger.warning(f"[stream] Nodo '{origen}' falló ({exc}); fallback local")
                        async for chunk in _bombear(stream_chat_openai(
                                OLLAMA_BASE_URL, model, messages, collector=collector, tools=payload.tools,
                                num_ctx=num_ctx, keep_alive=role.keep_alive, think=think)):
                            yield chunk
                    else:
                        logger.error(f"[stream] Falló el streaming ({exc})")
                        raise
                await run_in_threadpool(_persistir)
                aviso = None if is_api else await run_in_threadpool(quota_notice, uid, plan)
                if sin_cupo:
                    logger.info(f"[chat] respuesta cortada por cupo (user={uid})")
                    final = {"choices": [{"index": 0, "delta": {}, "finish_reason": "length"}],
                             "lixbon_quota": aviso or {"state": "exhausted", "message": "Agotaste tu cupo."}}
                    yield f"data: {json.dumps(final, ensure_ascii=False)}\n\n"
                elif aviso:
                    yield f"data: {json.dumps({'choices': [], 'lixbon_quota': aviso}, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"
            finally:
                _persistir()

        return StreamingResponse(_stream_and_persist(), media_type="text/event-stream")

    # Modo sin streaming
    ollama_resp, origen = await _routed_chat(model, messages, num_ctx=num_ctx,
                                            keep_alive=role.keep_alive, think=think)
    latency_ms = int((time.perf_counter() - started_at) * 1000)
    assistant_text = ollama_resp.get("message", {}).get("content", "")
    prompt_tokens = int(ollama_resp.get("prompt_eval_count") or 0)
    completion_tokens = int(ollama_resp.get("eval_count") or 0)
    _persist_assistant(conv_id, model, assistant_text, prompt_tokens, completion_tokens,
                       latency_ms, user_id=user_data["id"], save_history=save_history,
                       bill_credits=bill_credits)

    return JSONResponse({
        "id": f"chatcmpl-{uuid.uuid4().hex[:16]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": to_public(model),
        "conversation_id": conv_id if save_history else None,
        "node": origen,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": assistant_text},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
        "latency_ms": latency_ms,
        "lixbon_quota": None if is_api else quota_notice(user_data["id"], plan),
    })


@router.post("/v1/completions")
async def completions(
    payload: CompletionRequest,
    user_data: dict[str, Any] = Depends(api_key_required),
):
    """Endpoint compatible con OpenAI — text completions. Solo API key (Bearer):
    Pro/Advance usan su cuota del plan; Gratuito o cuota agotada, créditos prepago."""
    model, role = await model_for_request(payload.model, "chat", user_data)
    validate_model_access(user_data, model)
    plan = get_plan_for_user(user_data["id"])
    bill_credits = credits.ensure_can_use_api(user_data["id"], plan, model) == "credits"
    save_history = get_user_settings(user_data["id"])["save_history"]

    conv_id = payload.conversation_id or str(uuid.uuid4())
    if save_history:
        if not ensure_conversation(conv_id, user_data["id"], payload.title, payload.client_id, source="api"):
            raise HTTPException(status_code=404, detail="Conversación no encontrada")
        save_message(conv_id, "user", payload.prompt, model=model)

    started_at = time.perf_counter()
    ollama_resp, origen = await _routed_chat(
        model, [{"role": "user", "content": payload.prompt}],
        num_ctx=resolve_num_ctx(None, role.num_ctx, await fetch_models(), model), keep_alive=role.keep_alive,
    )
    latency_ms = int((time.perf_counter() - started_at) * 1000)
    assistant_text = ollama_resp.get("message", {}).get("content", "")
    prompt_tokens = int(ollama_resp.get("prompt_eval_count") or 0)
    completion_tokens = int(ollama_resp.get("eval_count") or 0)
    _persist_assistant(conv_id, model, assistant_text, prompt_tokens, completion_tokens,
                       latency_ms, user_id=user_data["id"], save_history=save_history,
                       bill_credits=bill_credits)

    return JSONResponse({
        "id": f"cmpl-{uuid.uuid4().hex[:16]}",
        "object": "text_completion",
        "created": int(time.time()),
        "model": to_public(model),
        "conversation_id": conv_id if save_history else None,
        "node": origen,
        "choices": [{"index": 0, "text": assistant_text, "finish_reason": "stop"}],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
        "latency_ms": latency_ms,
    })


# En inglés a propósito: los modelos de visión pequeños (moondream, llava…)
# están entrenados casi todo en inglés y devuelven basura con prompts en otros
# idiomas. La descripción resultante la consume un modelo multilingüe (qwen…),
# así que el idioma de salida no importa; se pide transcribir el texto TAL CUAL
# (preservando su idioma original).
DEFAULT_VISION_PROMPT = (
    "Describe this image in maximum detail so another AI that cannot see it can "
    "fully understand and work with its content. Transcribe ALL visible text and "
    "code EXACTLY as written, preserving the original language and formatting. "
    "Describe UI elements, layout, colors, any error or message, and every "
    "relevant detail. Respond ONLY with the description, no preamble."
)


def available_vision_model(preferred: str, catalog: list[dict]) -> str | None:
    """`preferred` si algún nodo online lo sirve; si no, el primer modelo del
    catálogo con capacidad `vision` que sí esté servido."""
    candidatos = [preferred] + [
        str(e.get("id")) for e in catalog
        if isinstance(e, dict) and "vision" in (e.get("capabilities") or []) and e.get("id") != preferred
    ]
    for candidato in candidatos:
        try:
            deps.orquestador.ollama_target(candidato, strict=True)
            return candidato
        except ModelUnavailable:
            continue
        except Exception:
            return candidato  # sin nodos: Ollama local, que decida él
    return None


class VisionDescribeRequest(BaseModel):
    # Vacío = el del rol `vision` (autodetectado por capability `vision`).
    model: str | None = Field(None, description="Modelo de visión; vacío = el del rol vision")
    images: list[str] = Field(..., description="Imágenes en base64")
    prompt: str | None = None


@router.post("/api/vision/describe")
async def vision_describe(
    payload: VisionDescribeRequest,
    user_data: dict[str, Any] = Depends(web_or_api_key_auth),
):
    """Sub-agente de visión: un modelo multimodal DESCRIBE la(s) imagen(es) en
    texto para que un modelo de solo-texto (qwen…) pueda razonar sobre ellas.
    No persiste historial; se cobra como cualquier inferencia."""
    if not payload.images:
        raise HTTPException(status_code=400, detail="No se adjuntaron imágenes")
    model, role = await model_for_request(payload.model, "vision")
    if not payload.model:
        # El rol suele apuntar a un modelo pequeño (moondream); si su nodo está
        # apagado, cualquier modelo online que declare `vision` sirve mejor
        # que un 503.
        model = available_vision_model(model, await fetch_models()) or model
    validate_model_access(user_data, model)
    plan = get_plan_for_user(user_data["id"])
    bill_credits = False
    if _is_external_api(user_data, plan):
        bill_credits = credits.ensure_can_use_api(user_data["id"], plan, model) == "credits"
    else:
        ensure_can_chat(user_data["id"], plan, model)

    messages = [{
        "role": "user",
        "content": (payload.prompt or DEFAULT_VISION_PROMPT),
        "images": payload.images,
    }]
    started_at = time.perf_counter()
    # Describir no necesita razonar: con thinking, qwen3.5 tardaba tanto que el
    # proxy cortaba la petición y el móvil mostraba "Sin conexión".
    resp, origen = await _routed_chat(model, messages, num_ctx=resolve_num_ctx(None, role.num_ctx, await fetch_models(), model),
                                      keep_alive=role.keep_alive, think=False)
    latency_ms = int((time.perf_counter() - started_at) * 1000)
    description = resp.get("message", {}).get("content", "").strip()
    prompt_tokens = int(resp.get("prompt_eval_count") or 0)
    completion_tokens = int(resp.get("eval_count") or 0)

    # Uso/cobro (sin persistir contenido: las imágenes no se guardan)
    if user_data.get("id") is not None:
        if bill_credits:
            credits.debit_usage(user_data["id"], model, prompt_tokens, completion_tokens)
        else:
            record_tokens(user_data["id"], prompt_tokens + completion_tokens)
            record_session_week_tokens(user_data["id"], model, prompt_tokens, completion_tokens)

    return {
        "description": description,
        "model": to_public(model),
        "node": origen,
        "latency_ms": latency_ms,
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }


class FimRequest(BaseModel):
    # Vacío = el del rol `fim`, que exige capability `insert`. Si ningún modelo
    # la declara el gateway responde 503 role_model_unavailable en vez de
    # autocompletar con el modelo de chat (que devolvería prosa o razonamiento).
    model: str | None = Field(None, description="Modelo con FIM; vacío = el del rol fim")
    prefix: str = ""  # texto ANTES del cursor
    suffix: str = ""  # texto DESPUÉS del cursor
    max_tokens: int = 96
    num_ctx: int | None = None
    stop: list[str] | None = None


@router.post("/api/fim")
async def fim_complete(
    payload: FimRequest,
    user_data: dict[str, Any] = Depends(web_or_api_key_auth),
):
    """Autocompletado fill-in-the-middle (ghost text del IDE). Devuelve la
    continuación que va en la posición del cursor entre `prefix` y `suffix`.
    No persiste historial; se contabiliza/cobra como cualquier inferencia."""
    model, role = await model_for_request(payload.model, "fim")
    validate_model_access(user_data, model)
    plan = get_plan_for_user(user_data["id"])
    bill_credits = False
    if _is_external_api(user_data, plan):
        bill_credits = credits.ensure_can_use_api(user_data["id"], plan, model) == "credits"
    else:
        ensure_can_chat(user_data["id"], plan, model)

    options: dict[str, Any] = {"num_predict": max(1, min(int(payload.max_tokens), 512))}
    num_ctx = resolve_num_ctx(payload.num_ctx, role.num_ctx, await fetch_models(), model)
    if num_ctx:
        options["num_ctx"] = int(num_ctx)
    if payload.stop:
        options["stop"] = payload.stop

    base, headers, origen = target_or_503(model)
    started_at = time.perf_counter()
    try:
        resp = await ollama_generate(base, model, payload.prefix, payload.suffix,
                                     options=options, headers=headers, client=deps.http_client_chat,
                                     keep_alive=role.keep_alive)
    except Exception as exc:
        if origen == "local":
            raise HTTPException(status_code=502, detail=f"FIM falló: {exc}") from exc
        logger.warning(f"[fim] Nodo '{origen}' falló ({exc}); fallback local")
        resp = await ollama_generate(OLLAMA_BASE_URL, model, payload.prefix, payload.suffix,
                                     options=options, client=deps.http_client_chat,
                                     keep_alive=role.keep_alive)

    completion = resp.get("response", "")
    prompt_tokens = int(resp.get("prompt_eval_count") or 0)
    completion_tokens = int(resp.get("eval_count") or 0)
    latency_ms = int((time.perf_counter() - started_at) * 1000)

    if user_data.get("id") is not None:
        if bill_credits:
            credits.debit_usage(user_data["id"], model, prompt_tokens, completion_tokens)
        else:
            record_tokens(user_data["id"], prompt_tokens + completion_tokens)
            record_session_week_tokens(user_data["id"], model, prompt_tokens, completion_tokens)

    return {
        "completion": completion,
        "model": to_public(model),
        "node": origen,
        "latency_ms": latency_ms,
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }


class EmbedRequest(BaseModel):
    model: str | None = Field(None, description="Modelo de embeddings; vacío = el del rol embed")
    input: list[str] = Field(default_factory=list)


@router.post("/api/embed")
async def embed_texts(
    payload: EmbedRequest,
    user_data: dict[str, Any] = Depends(web_or_api_key_auth),
):
    """Embeddings en lote para el índice del codebase (RAG del IDE). No valida el
    modelo contra el plan (los modelos de embedding no están en la lista de chat).
    Se contabiliza el uso; si el modelo no tiene tarifa, el cobro se omite."""
    if not payload.input:
        raise HTTPException(status_code=400, detail="input vacío")

    model, role = await model_for_request(payload.model, "embed")
    plan = get_plan_for_user(user_data["id"])
    bill_credits = False
    if _is_external_api(user_data, plan):
        bill_credits = credits.ensure_can_use_api(user_data["id"], plan, model) == "credits"

    base, headers, origen = target_or_503(model)
    try:
        resp = await ollama_embed_many(base, model, payload.input,
                                       headers=headers, client=deps.http_client_chat,
                                       keep_alive=role.keep_alive)
    except Exception as exc:
        if origen == "local":
            raise HTTPException(status_code=502, detail=f"Embeddings fallaron: {exc}") from exc
        logger.warning(f"[embed] Nodo '{origen}' falló ({exc}); fallback local")
        resp = await ollama_embed_many(OLLAMA_BASE_URL, model, payload.input,
                                       client=deps.http_client_chat, keep_alive=role.keep_alive)

    embeddings = resp.get("embeddings", []) or []
    prompt_tokens = int(resp.get("prompt_eval_count") or 0)
    if user_data.get("id") is not None and prompt_tokens:
        try:
            if bill_credits:
                credits.debit_usage(user_data["id"], model, prompt_tokens, 0)
            else:
                record_tokens(user_data["id"], prompt_tokens)
                record_session_week_tokens(user_data["id"], model, prompt_tokens, 0)
        except Exception as exc:  # tarifa ausente para el modelo de embedding: no romper
            logger.warning(f"[embed] cobro omitido ({exc})")

    return {"embeddings": embeddings, "model": to_public(model), "node": origen}


@router.post("/api/delegate")
async def delegate_request(
    payload: DelegateRequest,
    user_data: dict[str, Any] = Depends(session_or_api_key),
):
    """
    Delegación inteligente. Todo el pipeline (embedding, clasificación y ejecución)
    se enruta por el orquestador hacia el mejor nodo GPU (F2).
    """
    user_id = user_data["id"]
    plan = get_plan_for_user(user_id)
    ensure_can_chat(user_id, plan)  # F5: cuenta el mensaje; el modelo se decide después

    started_at = time.perf_counter()

    catalog = await fetch_models()
    roles = resolve_all(catalog)
    embed_role, route_role = roles["embed"], roles["route"]

    # Destino para las tareas auxiliares (embedding + clasificación): el mejor nodo disponible
    aux_base, aux_headers, _ = deps.orquestador.ollama_target()

    embedding = []
    if embed_role.model:
        try:
            embedding = await get_embedding(payload.user_input, aux_base, embed_role.model,
                                            headers=aux_headers, keep_alive=embed_role.keep_alive)
        except Exception:
            embedding = []

    similar_tasks = find_similar_tasks(user_id, embedding) if embedding else []
    # El clasificador y el ejecutor salen del rol `route`: si está fijado manda
    # ese modelo, y si no se elige por capability entre los realmente instalados.
    pinned = route_role.model if route_role.source in ("db", "env") else None
    classifier_model = pinned or pick_classifier_model(catalog)
    classification = {
        "intent": "learn", "complexity": 0.5, "domain": "backend",
        "riskLevel": "low", "requiresApproval": False,
    }
    if classifier_model:
        try:
            classification = await classify_request(
                payload.user_input, similar_tasks, aux_base, classifier_model, headers=aux_headers
            )
        except Exception:
            pass
    routing = route_request(classification, catalog, pinned_model=pinned)

    response_text = ""
    success = False
    if routing["type"] == "DELEGUE":
        response_text = routing["message"]
        success = True
    else:
        if not routing.get("model"):
            raise HTTPException(status_code=503, detail={
                "code": "role_model_unavailable",
                "message": "No hay ningún modelo disponible para responder. "
                           "Comprueba que el nodo GPU esté online y tenga modelos instalados.",
                "role": "route",
            })
        messages = [
            {"role": "system", "content": routing["system_prompt"]},
            {"role": "user", "content": payload.user_input},
        ]
        try:
            resp, _ = await _routed_chat(routing["model"], messages,
                                         keep_alive=route_role.keep_alive)
            response_text = resp.get("message", {}).get("content", "")
            success = True
        except Exception as exc:
            response_text = f"Error al ejecutar el modelo: {exc}"

    execution_ms = int((time.perf_counter() - started_at) * 1000)
    save_task_embedding(
        user_id=user_id,
        user_input=payload.user_input,
        classification=classification,
        router_used=routing["type"],
        model_called=routing.get("model"),
        response_summary=response_text[:500],
        success=success,
        embedding=embedding,
    )

    return {
        "response": response_text,
        "classification": classification,
        "routing": {"type": routing["type"], "model": routing.get("model")},
        "similar_tasks": similar_tasks[:3],
        "execution_time_ms": execution_ms,
    }
