"""
context.py — Ajuste del historial a la ventana de contexto de Ollama.

Ollama no falla cuando el prompt desborda `num_ctx`: descarta el principio
(system prompt incluido) y, si además el modelo razona antes de responder,
puede no quedar sitio para la respuesta y devolver vacío. Aquí se recortan los
mensajes más antiguos ANTES de enviar, reservando espacio para la respuesta.
La estimación de tokens es conservadora (sin tokenizador): ~3 caracteres por
token, que en español y en código queda por encima de lo real.
"""
from __future__ import annotations

import logging

logger = logging.getLogger("lixbon.context")

DEFAULT_NUM_CTX = 4096
CHARS_PER_TOKEN = 3
TOKENS_PER_MESSAGE = 6
# Fracción de la ventana que se deja libre para razonar + responder.
RESERVE_RATIO = 0.4
RESERVE_MIN = 1024


def estimate_tokens(messages: list[dict]) -> int:
    total = 0
    for m in messages:
        contenido = m.get("content")
        if isinstance(contenido, list):
            contenido = " ".join(str(p.get("text", "")) for p in contenido if isinstance(p, dict))
        total += len(str(contenido or "")) // CHARS_PER_TOKEN + TOKENS_PER_MESSAGE
    return total


def fit_messages(messages: list[dict], num_ctx: int | None) -> list[dict]:
    """Conserva los mensajes `system` y los más recientes que quepan en el
    presupuesto. El último mensaje del usuario se manda siempre, aunque por sí
    solo no quepa (un adjunto enorme): recortarlo a ciegas sería peor."""
    ventana = int(num_ctx or DEFAULT_NUM_CTX)
    presupuesto = ventana - max(RESERVE_MIN, int(ventana * RESERVE_RATIO))
    if estimate_tokens(messages) <= presupuesto:
        return messages

    sistema = [m for m in messages if m.get("role") == "system"]
    resto = [m for m in messages if m.get("role") != "system"]
    usado = estimate_tokens(sistema)
    conservados: list[dict] = []
    for i, m in enumerate(reversed(resto)):
        coste = estimate_tokens([m])
        if i > 0 and usado + coste > presupuesto:
            break
        conservados.append(m)
        usado += coste
    conservados.reverse()

    # Un `tool` sin su `assistant` con tool_calls delante rompe el formato.
    while conservados and conservados[0].get("role") == "tool":
        conservados.pop(0)

    descartados = len(resto) - len(conservados)
    if descartados:
        logger.info(
            f"[context] {descartados} mensaje(s) antiguos fuera: ~{estimate_tokens(messages)} tokens "
            f"contra num_ctx={ventana} (presupuesto {presupuesto})"
        )
    return sistema + conservados
