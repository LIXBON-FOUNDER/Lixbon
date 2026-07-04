"""
Módulo de embeddings y delegación inteligente usando Ollama local.
- Genera embeddings con nomic-embed-text (POST /api/embed)
- Clasifica solicitudes con un modelo chat ligero de Ollama
- Enruta la solicitud al modelo más adecuado según reglas determinísticas
"""

import json
from typing import Any

import httpx

EMBED_MODEL = "nomic-embed-text"

# Modelos preferidos ordenados de mayor a menor capacidad
_PLAN_MODELS = [
    "llama3.1:8b", "llama3.2:3b", "phi4:latest",
    "mistral:latest", "deepseek-r1:7b", "llama3.2:1b",
]
_AUTO_MODELS = [
    "llama3.2:1b", "phi3:mini", "llama3.2:3b", "llama3.1:8b",
]

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
    model: str = EMBED_MODEL,
    headers: dict | None = None,
) -> list[float]:
    """Genera el embedding vía core.inference (Ollama directo o proxy del nodo)."""
    from core.inference.ollama import embed
    return await embed(base_url, text, model, headers=headers)


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


# ─── Router ────────────────────────────────────────────────────────────────

def route_request(
    classification: dict[str, Any],
    available_models: list[str],
) -> dict[str, Any]:
    """
    Reglas determinísticas para seleccionar el modelo y estrategia.
    No requiere IA: es lógica pura basada en la clasificación.
    """
    risk = classification.get("riskLevel", "low")
    complexity = float(classification.get("complexity", 0.5))
    intent = str(classification.get("intent", "learn"))

    def pick(preferred: list[str]) -> str:
        for m in preferred:
            if m in available_models:
                return m
        return available_models[0] if available_models else "llama3.1:8b"

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
            "model": pick(_AUTO_MODELS),
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
            "model": pick(_PLAN_MODELS),
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
        "model": pick(_PLAN_MODELS),
        "timeout": 90,
        "priority": "normal",
        "system_prompt": (
            "Eres un arquitecto de software experto. Analiza en profundidad la solicitud, "
            "considera múltiples opciones con sus pros y contras, y proporciona un plan "
            "de implementación detallado con pasos claros y consideraciones de riesgo."
        ),
    }


def pick_classifier_model(available_models: list[str]) -> str:
    """
    Selecciona el modelo más ligero disponible para clasificar solicitudes.
    Prioriza modelos rápidos para minimizar latencia de clasificación.
    """
    light_models = ["llama3.2:1b", "phi3:mini", "llama3.2:3b", "llama3.1:8b"]
    for m in light_models:
        if m in available_models:
            return m
    return available_models[0] if available_models else "llama3.1:8b"
