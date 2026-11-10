"""
Bucle del agente de GitHub en el servidor: el modelo pide herramientas, el
gateway las ejecuta con el token del usuario y le devuelve el resultado, hasta
que responde sin pedir nada más.

Al cliente le llegan, en el mismo stream SSE del chat:
  - los deltas de texto y razonamiento (formato OpenAI, como siempre),
  - `lixbon_tool`: {id, name, target, status: running|done|error}, para la
    línea de progreso,
  - `lixbon_github_confirm`: en modo manual, la acción que espera al usuario.
    El turno se congela en la BD (connector_pending_actions) y el stream
    termina; la siguiente petición con `github.resolve` lo retoma.

La política de permisos NO depende del prompt: `decidir` se aplica a cada
llamada antes de ejecutarla.
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any

from starlette.concurrency import run_in_threadpool

from core.connectors import github_tools as gt
from core.connectors.github import PROVIDER, Cliente
from core.persistence import connectors as store
from core.persistence.queries import log_audit_event

logger = logging.getLogger("lixbon.connectors.agente")

MAX_PASOS = 12


@dataclass
class Turno:
    """Lo que el llamador necesita al terminar para persistir y cobrar."""
    texto: str = ""
    # Suma de todos los pasos (lo que se cobra). Cada paso reenvía el
    # contexto entero, pero lo que ya estaba en la caché KV de Ollama llega
    # en cached_tokens y se cobra con descuento (core/billing).
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0
    # Tamaño del contexto tras el último paso y su reparto por categoría.
    contexto: int = 0
    desglose: dict[str, int] = field(default_factory=dict)
    pendiente: str | None = None            # id de la acción que espera confirmación
    acciones: list[dict[str, Any]] = field(default_factory=list)


def _sse(obj: dict[str, Any]) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


def _delta(chat_id: str, model: str, *, content: str = "", reasoning: str = "",
           finish: str | None = None) -> str:
    delta: dict[str, Any] = {}
    if content:
        delta["content"] = content
    if reasoning:
        delta["reasoning_content"] = reasoning
    return _sse({"id": chat_id, "object": "chat.completion.chunk", "created": int(time.time()),
                 "model": model, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})


def _args(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    try:
        val = json.loads(raw or "{}")
        return val if isinstance(val, dict) else {}
    except (TypeError, ValueError):
        return {}


def _llamadas(collector: dict[str, Any]) -> list[dict[str, Any]]:
    """tool_calls del paso, normalizados a {id, name, args}."""
    out = []
    for c in collector.get("tool_calls") or []:
        fn = c.get("function") or {}
        if fn.get("name"):
            out.append({"id": c.get("id") or f"call_{uuid.uuid4().hex[:8]}",
                        "name": fn["name"], "args": _args(fn.get("arguments"))})
    return out


class Agente:
    """Un turno del agente. `paso` es el stream del modelo (inyectado para
    poder probar el bucle sin Ollama): recibe (messages, tools, collector) y
    devuelve los chunks SSE de stream_chat_openai."""

    def __init__(self, *, user_id: int, conversation_id: str | None, ctx: gt.Contexto, model: str,
                 paso: Callable[[list[dict], list[dict] | None, dict], AsyncIterator[str]],
                 cliente: Cliente | None = None, ip: str | None = None, num_ctx: int | None = None):
        self.user_id = user_id
        self.conversation_id = conversation_id
        self.ctx = ctx
        self.model = model
        self.paso = paso
        self.cli = cliente or Cliente(user_id)
        self.ip = ip
        self.num_ctx = num_ctx
        self.turno = Turno()
        self.chat_id = f"chatcmpl-{uuid.uuid4()}"
        self._separar = False
        self._pasos = 0

    # ── stream del modelo ────────────────────────────────────────────────────

    async def _paso(self, messages: list[dict], tools: list[dict] | None,
                    collector: dict[str, Any]) -> AsyncIterator[str]:
        """Reemite el texto; se queda los tool_calls y el fin. El razonamiento
        NO viaja al cliente (la web solo enseña «Pensando»): se guarda para
        devolvérselo al modelo en el paso siguiente."""
        self._pasos += 1
        # La línea de trabajo vuelve a «Pensando» en cada vuelta al modelo;
        # la primera ya la pinta el cliente mientras no hay texto.
        pensar = {"id": f"pensar-{self._pasos}", "name": "thinking", "target": ""}
        yield _sse({"lixbon_tool": {**pensar, "status": "running"}})
        pensando = True
        razonamiento: list[str] = []
        async for chunk in self.paso(messages, tools, collector):
            if chunk.startswith(":"):
                yield chunk  # keep-alive
                continue
            if not chunk.startswith("data: {"):
                continue
            try:
                data = json.loads(chunk[6:])
            except ValueError:
                continue
            delta = ((data.get("choices") or [{}])[0].get("delta") or {})
            texto = delta.get("content") or ""
            pensado = delta.get("reasoning_content") or ""
            if pensado:
                razonamiento.append(pensado)
            if texto and self._separar and self.turno.texto and not self.turno.texto.endswith("\n\n"):
                texto = "\n\n" + texto
            if texto:
                self._separar = False
                self.turno.texto += texto
            if texto:
                if pensando:
                    pensando = False
                    yield _sse({"lixbon_tool": {**pensar, "status": "done"}})
                yield _delta(self.chat_id, self.model, content=texto)
        collector["thinking"] = "".join(razonamiento)
        entrada = int(collector.get("prompt_tokens") or 0)
        salida = int(collector.get("completion_tokens") or 0)
        self.turno.prompt_tokens += entrada
        self.turno.completion_tokens += salida
        self.turno.cached_tokens += int(collector.get("cached_tokens") or 0)
        if entrada:
            self.turno.contexto = entrada + salida
            self.turno.desglose = collector.get("breakdown") or {}

    # ── herramientas ─────────────────────────────────────────────────────────

    async def _ejecutar(self, messages: list[dict], call: dict[str, Any]) -> AsyncIterator[str]:
        nombre, args = call["name"], call["args"]
        evento = {"id": call["id"], "name": nombre, "target": gt.objetivo(nombre, args)}
        yield _sse({"lixbon_tool": {**evento, "status": "running"}})
        resultado = await gt.ejecutar(self.cli, self.ctx, nombre, args)
        ok = "error" not in resultado
        yield _sse({"lixbon_tool": {**evento, "status": "done" if ok else "error"}})
        if nombre in gt.NOMBRES_ESCRITURA:
            self.turno.acciones.append({"tool": nombre, "ok": ok, **{k: v for k, v in resultado.items()
                                                                    if k in ("url", "number", "branch", "commit")}})
            await run_in_threadpool(
                log_audit_event, "github_action", user_id=self.user_id, ip_address=self.ip,
                tool=nombre, repo=self.ctx.repo, mode=self.ctx.modo, ok=ok,
                error=resultado.get("error") if not ok else None,
            )
        messages.append({"role": "tool", "tool_name": nombre, "content": gt.resultado_para_modelo(resultado)})

    async def _procesar(self, messages: list[dict], calls: list[dict[str, Any]],
                        aprobada: bool | None = None) -> AsyncIterator[str]:
        """Ejecuta las llamadas en orden. Si una necesita confirmación, congela
        el turno y para. `aprobada` es la respuesta del usuario a la PRIMERA
        llamada de `calls` (al retomar)."""
        for i, call in enumerate(calls):
            if i == 0 and aprobada is not None:
                decision: str = "permitir" if aprobada else "rechazada"
                motivo = None
            else:
                decision, motivo = gt.decidir(self.ctx, call["name"], call["args"])

            if decision == "denegar":
                yield _sse({"lixbon_tool": {"id": call["id"], "name": call["name"],
                                            "target": gt.objetivo(call["name"], call["args"]), "status": "error"}})
                messages.append({"role": "tool", "tool_name": call["name"],
                                 "content": json.dumps({"error": motivo, "denied": True}, ensure_ascii=False)})
            elif decision == "rechazada":
                messages.append({"role": "tool", "tool_name": call["name"], "content": json.dumps(
                    {"rejected": True, "message": "El usuario rechazó esta acción. No la repitas igual: "
                                                  "pregúntale qué prefiere o sigue con lo demás."},
                    ensure_ascii=False)})
            elif decision == "confirmar":
                resumen = gt.resumen_confirmacion(self.ctx, call["name"], call["args"])
                accion_id = await run_in_threadpool(
                    store.create_pending_action, self.user_id, PROVIDER, self.conversation_id,
                    self.ctx.as_dict(), messages, calls[i:],
                )
                self.turno.pendiente = accion_id
                yield _sse({"lixbon_github_confirm": {"id": accion_id, **resumen}})
                return
            else:
                async for chunk in self._ejecutar(messages, call):
                    yield chunk
            self._separar = True

    # ── bucle ────────────────────────────────────────────────────────────────

    async def _bucle(self, messages: list[dict]) -> AsyncIterator[str]:
        tools = gt.herramientas(self.ctx.modo, self.ctx.puede_escribir)
        for _ in range(MAX_PASOS):
            collector: dict[str, Any] = {}
            async for chunk in self._paso(messages, tools, collector):
                yield chunk
            calls = _llamadas(collector)
            if not calls:
                return
            messages.append({
                "role": "assistant",
                "content": collector.get("content") or "",
                **({"thinking": collector["thinking"]} if collector.get("thinking") else {}),
                "tool_calls": [{"function": {"name": c["name"], "arguments": c["args"]}} for c in calls],
            })
            async for chunk in self._procesar(messages, calls):
                yield chunk
            if self.turno.pendiente:
                return
        # Tope de pasos: una última vuelta sin herramientas para que no se
        # quede a medias sin decir nada.
        messages.append({"role": "system", "content": (
            "Has llegado al límite de pasos de este turno. No llames más herramientas: resume lo que hiciste, "
            "lo que falta y cómo seguir.")})
        async for chunk in self._paso(messages, None, {}):
            yield chunk

    async def _cerrar(self) -> AsyncIterator[str]:
        # Uso del turno entero (todos los pasos) y el contexto del último:
        # la web enseña ambos en el detalle del anillo.
        t = self.turno
        if t.prompt_tokens or t.completion_tokens:
            yield _sse({
                "id": self.chat_id, "object": "chat.completion.chunk", "model": self.model, "choices": [],
                "usage": {"prompt_tokens": t.prompt_tokens, "completion_tokens": t.completion_tokens,
                          "total_tokens": t.prompt_tokens + t.completion_tokens,
                          "prompt_tokens_details": {"cached_tokens": t.cached_tokens}},
                "lixbon_context": {"num_ctx": self.num_ctx or 4096, "used": t.contexto,
                                   "breakdown": t.desglose, "steps": self._pasos},
            })
        yield _delta(self.chat_id, self.model, finish="stop")

    async def iniciar(self, historial: list[dict]) -> AsyncIterator[str]:
        messages = [{"role": "system", "content": gt.instrucciones(self.ctx)}, *historial]
        ultimo_usuario = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=None)
        if ultimo_usuario is not None:
            messages.insert(ultimo_usuario, {"role": "system", "content": gt.recordatorio(self.ctx)})
        if self.conversation_id:
            # Un mensaje nuevo deja sin sentido la acción que esperaba respuesta.
            await run_in_threadpool(store.discard_pending_for_conversation, self.user_id, self.conversation_id)
        async for chunk in self._bucle(messages):
            yield chunk
        async for chunk in self._cerrar():
            yield chunk

    async def retomar(self, pendiente: dict[str, Any], aprobada: bool) -> AsyncIterator[str]:
        messages = list(pendiente["transcript"])
        async for chunk in self._procesar(messages, pendiente["calls"], aprobada=aprobada):
            yield chunk
        if not self.turno.pendiente:
            async for chunk in self._bucle(messages):
                yield chunk
        async for chunk in self._cerrar():
            yield chunk
