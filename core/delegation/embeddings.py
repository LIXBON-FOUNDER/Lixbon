"""
Módulo de embeddings y delegación inteligente usando Ollama local.
- Genera embeddings con el modelo del rol `embed` (POST /api/embed)
- Clasifica solicitudes con un modelo chat ligero del cluster
- Enruta la solicitud al modelo más adecuado según reglas determinísticas

Los candidatos se derivan de los modelos REALMENTE disponibles y de lo que
declaran saber hacer, no de una lista de nombres fija. Antes había literales
(`llama3.1:8b`, `phi4`…) con un fallback ciego a `"llama3.1:8b"`: si ninguno
estaba instalado, la delegación acababa llamando al primer modelo del catálogo
—que podía ser el de embeddings— o a un modelo inexistente, sin error claro.
"""

import json
from typing import Any, Iterable

import httpx

_CLASSIFIER_SYSTEM_PROMPT = """\
Eres un clasificador de solicitudes técnicas. Analiza la solicitud del usuario \
y responde ÚNICAMENTE con un JSON válido con este formato exacto (sin texto adicional):
{
  "intent": "deploy|debug|configure|learn|create_resource|optimize|integrate|monitor|maintain",
  "complexity": 0.5,
  "domain": "infra|backend|data|frontend|testing|security|billing",
  "riskLevel": "low|medium|high|critical",
  "requiresApproval": false
}"""


# ─── Embedding ─────────────────────────────────────────────────────────────

async def get_embedding(
    text: str,
    base_url: str,
    model: str,
    headers: dict | None = None,
    keep_alive: str | None = None,
) -> list[float]:
    """Genera el embedding vía core.inference (Ollama directo o proxy del nodo).
    `model` lo resuelve el llamador con el rol `embed` (no hay default aquí:
    así este módulo no depende de la config y se puede testear puro)."""
    from core.inference.ollama import embed
    return await embed(base_url, text, model, headers=headers, keep_alive=keep_alive)


# ─── Clasificación ─────────────────────────────────────────────────────────

async def classify_request(
    user_input: str,
    similar_tasks: list[dict],
    base_url: str,
    model: str,
    headers: dict | None = None,
) -> dict[str, Any]:
    """Clasifica la solicitud llamando a un modelo chat de Ollama como clasificador."""
    from core.inference.ollama import chat as inference_chat

    context = ""
    if similar_tasks:
        examples = "\n".join(
            f"- '{t['user_input']}' → intent:{t['intent']}, complexity:{t['complexity']}"
            for t in similar_tasks[:3]
        )
        context = f"\n\nEjemplos del historial del usuario:\n{examples}"

    prompt = f"Solicitud: {user_input}{context}"

    resp = await inference_chat(
        base_url, model,
        [
            {"role": "system", "content": _CLASSIFIER_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        headers=headers,
    )
    content = resp.get("message", {}).get("content", "{}").strip()

    # Extraer JSON aunque el modelo lo envuelva en markdown
    if "```" in content:
        parts = content.split("```")
        # El JSON está en la primera sección de código
        for part in parts[1:]:
            cleaned = part.lstrip("json").strip()
            if cleaned.startswith("{"):
                content = cleaned
                break

    try:
        return json.loads(content)
    except Exception:
        # Clasificación por defecto si el modelo no retornó JSON válido
        return {
            "intent": "learn",
            "complexity": 0.5,
            "domain": "backend",
            "riskLevel": "low",
            "requiresApproval": False,
        }


# ─── Candidatos ────────────────────────────────────────────────────────────
# El catálogo es lo que devuelve fetch_models(): dicts {"id", "capabilities"?,
# "size"?}. Se aceptan strings sueltos (⇒ capabilities desconocidas).

def _entries(catalog: Iterable[Any] | None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in catalog or []:
        if isinstance(item, str):
            out.append({"id": item})
        elif isinstance(item, dict) and item.get("id"):
            out.append(dict(item))
    return [e for e in out if not str(e["id"]).startswith("error:")]


def _grupos(catalog: Iterable[Any] | None) -> list[list[str]]:
    """Los aptos para razonar, agrupados por tramo de capacidad (mejor primero).

    Tramos: los que declaran `tools`, los que solo declaran `completion`, y los
    de capabilities desconocidas (node_agent viejo) — que no se descartan porque
    "desconocido" no es "no sirve". Los de solo `embedding` sí quedan fuera: un
    modelo de embeddings no puede responder un chat.
    """
    con_tools: list[str] = []
    con_completion: list[str] = []
    desconocidos: list[str] = []
    for e in _entries(catalog):
        caps = e.get("capabilities")
        nombre = str(e["id"])
        if not caps:
            desconocidos.append(nombre)
        elif "tools" in caps:
            con_tools.append(nombre)
        elif "completion" in caps:
            con_completion.append(nombre)
    return [g for g in (con_tools, con_completion, desconocidos) if g]


def rank_candidates(catalog: Iterable[Any] | None) -> list[str]:
    """Modelos aptos para razonar, del más al menos capaz (lista plana)."""
    return [m for grupo in _grupos(catalog) for m in grupo]


def pick_route_model(catalog: Iterable[Any] | None, tier: str = "heavy") -> str | None:
    """Modelo para la delegación. None si no hay ninguno apto.

    Ambos tiers eligen dentro del **mejor tramo de capacidad** disponible y solo
    bajan de tramo si está vacío; dentro del tramo decide el tamaño. Elegir el
    `light` del catálogo entero era peor que el bug que arregla: con lo instalado
    hoy salía `moondream` (1.7 GB, visión) a clasificar y a titular, cuando hay un
    `qwen3:4b` con `tools`. El tamaño desempata *entre pares*, no entre tramos.

    `heavy`: el más grande del mejor tramo (más parámetros ≈ mejor razonando).
    `light`: el más pequeño del mejor tramo — clasificar debe costar poco.
    """
    grupos = _grupos(catalog)
    if not grupos:
        return None
    mejor = grupos[0]
    tamanos = {str(e["id"]): int(e.get("size") or 0) for e in _entries(catalog)}
    if tier == "light":
        # Tamaño desconocido ⇒ inf/0 según el tier: nunca gana por defecto, y si
        # no se conoce ninguno todos empatan y manda el orden del catálogo.
        return min(mejor, key=lambda m: (tamanos.get(m) or float("inf"), mejor.index(m)))
    return max(mejor, key=lambda m: (tamanos.get(m) or 0, -mejor.index(m)))


# ─── Router ────────────────────────────────────────────────────────────────

def route_request(
    classification: dict[str, Any],
    catalog: Iterable[Any] | None,
    pinned_model: str | None = None,
) -> dict[str, Any]:
    """
    Reglas determinísticas para seleccionar el modelo y estrategia.
    No requiere IA: es lógica pura basada en la clasificación.

    `pinned_model`: si el rol `route` está fijado en BD/env, ese modelo gana en
    todas las ramas. `model` puede volver None: el llamador debe dar un error
    claro en vez de llamar a Ollama con un modelo vacío.
    """
    risk = classification.get("riskLevel", "low")
    complexity = float(classification.get("complexity", 0.5))
    intent = str(classification.get("intent", "learn"))

    def pick(tier: str) -> str | None:
        return pinned_model or pick_route_model(catalog, tier)

    if risk == "critical":
        return {
            "type": "DELEGUE",
            "model": None,
            "timeout": 0,
            "priority": "critical",
            "system_prompt": None,
            "message": "Operación de riesgo crítico. Requiere aprobación manual.",
        }

    if complexity < 0.3 and risk == "low":
        return {
            "type": "AUTO",
            "model": pick("light"),
            "timeout": 30,
            "priority": "normal",
            "system_prompt": (
                "Eres un asistente técnico rápido y directo. "
                "Responde en máximo 100 palabras. Sé conciso y preciso."
            ),
        }

    if intent in ("debug", "troubleshoot") or "error" in intent:
        return {
            "type": "DEBUG",
            "model": pick("heavy"),
            "timeout": 60,
            "priority": "high",
            "system_prompt": (
                "Eres un especialista en troubleshooting. Identifica la causa raíz, "
                "aísla el problema y proporciona pasos específicos y reproducibles para resolverlo."
            ),
        }

    # Por defecto: PLAN (estratégico y detallado)
    return {
        "type": "PLAN",
        "model": pick("heavy"),
        "timeout": 90,
        "priority": "normal",
        "system_prompt": (
            "Eres un arquitecto de software experto. Analiza en profundidad la solicitud, "
            "considera múltiples opciones con sus pros y contras, y proporciona un plan "
            "de implementación detallado con pasos claros y consideraciones de riesgo."
        ),
    }


def pick_classifier_model(catalog: Iterable[Any] | None) -> str | None:
    """
    Modelo más ligero disponible para clasificar solicitudes (y para generar
    títulos de conversación). None si no hay ninguno apto: el llamador decide
    qué error mostrar en vez de inventarse un nombre de modelo.
    """
    return pick_route_model(catalog, "light")
