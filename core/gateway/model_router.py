"""
model_router.py — Resolución del modelo de cada petición HTTP.

`core/inference/roles.py` decide qué modelo sirve cada rol; este módulo aplica
esa decisión a una petición concreta y traduce los fallos a errores HTTP claros.

Precedencia:
  · rol `chat`  → `model` del request › `key_model` de la API key › rol
  · otros roles → `model` del request › rol

Un `model` explícito NUNCA se veta por capability: los clientes compatibles con
OpenAI siguen mandando el modelo que quieran y funcionando igual. Solo se
registra un WARNING cuando el modelo pedido no declara la capacidad del rol,
porque es la causa habitual de resultados raros (p. ej. pedir FIM a un modelo
sin `insert`).
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException

from core.gateway import deps
from core.gateway.utils import fetch_models
from core.inference.roles import (
    REQUIRED_CAPABILITY,
    RoleResolution,
    capabilities_of,
    resolve_role,
)
from core.orchestration.orchestrator import ModelUnavailable

logger = logging.getLogger("lixbon.models")


async def model_for_request(
    explicit: str | None,
    role: str,
    user_data: dict[str, Any] | None = None,
) -> tuple[str, RoleResolution]:
    """(modelo a usar, resolución del rol). Levanta 503 si no hay ninguno.

    El catálogo solo se consulta si hace falta: con un modelo explícito o un rol
    fijado en BD/env no se toca la red salvo para avisar de una incompatibilidad.
    """
    pedido = (explicit or "").strip()
    if not pedido and role == "chat" and user_data:
        # API key atada a un modelo: es el default natural de esa key.
        pedido = (user_data.get("key_model") or "").strip()

    catalog = await fetch_models()
    resolution = resolve_role(role, catalog)

    if pedido:
        required = REQUIRED_CAPABILITY.get(role)
        caps = capabilities_of(catalog, pedido)
        if required and caps is not None and required not in caps:
            logger.warning(
                f"[models] '{pedido}' no declara la capacidad '{required}' del rol "
                f"'{role}' (declara: {caps}). Se usa igualmente porque lo pidió el cliente."
            )
        return pedido, resolution

    if not resolution.model:
        raise HTTPException(status_code=503, detail={
            "code": "role_model_unavailable",
            "message": resolution.warning or (
                f"No hay ningún modelo disponible para el rol '{role}'."
            ),
            "role": role,
            "required_capability": REQUIRED_CAPABILITY.get(role),
        })
    return resolution.model, resolution


def target_or_503(model: str, strict: bool = True) -> tuple[str, dict, str]:
    """Destino de inferencia (base_url, headers, origen) o 503 claro.

    Antes, si ningún nodo tenía el modelo, la petición se enviaba al nodo de
    mayor score igualmente y el usuario veía el error crudo de Ollama. Ahora el
    gateway dice qué falta. Sin nodos online se sigue cayendo al Ollama local:
    ese es el camino de desarrollo, no un error.
    """
    try:
        return deps.orquestador.ollama_target(model, strict=strict)
    except ModelUnavailable as exc:
        raise HTTPException(status_code=503, detail={
            "code": "model_not_available",
            "message": (f"El modelo '{exc.model}' no está instalado en ningún nodo online. "
                        f"Descárgalo en el nodo (`ollama pull {exc.model}`) o elige otro."),
            "model": exc.model,
            "nodes_online": exc.nodes_online,
        }) from exc
