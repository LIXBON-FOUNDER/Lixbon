"""
Compactación de conversaciones largas.

Antes, cuando una conversación no cabía en la ventana, `fit_messages` quitaba
los mensajes más antiguos en CADA petición. Cada recorte cambia el principio
del prompt, y la caché KV de Ollama solo sirve mientras ese principio sea
idéntico: a partir de ahí, cada mensaje se procesaba entero desde cero (más
lento, más caro para el usuario y para nosotros) y además el modelo perdía lo
hablado al principio.

Ahora la parte antigua se resume UNA vez y se guarda. Las peticiones
siguientes mandan [system, resumen, mensajes recientes]: el principio queda
fijo y la caché vuelve a funcionar hasta la siguiente compactación.

El módulo no habla con Ollama ni con la BD: recibe `resumir` y devuelve qué
guardar, para poder probarlo sin nada de eso.
"""
from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from core.inference.context import PREFIJO_RESUMEN, RESERVE_MIN, RESERVE_RATIO, estimate_tokens

logger = logging.getLogger("lixbon.compaction")

# Tras compactar, lo reciente ocupa como mucho esta fracción del presupuesto:
# así queda margen para muchos mensajes antes de volver a compactar.
FRACCION_RECIENTE = 0.35
# Lo que se resume de una vez (resumen previo + tramo) cabe en esta fracción
# de la ventana; una historia más larga se resume por tramos.
FRACCION_TRAMO = 0.55
MIN_RECIENTES = 2

INSTRUCCIONES = (
    "Resume la conversación siguiente para poder continuarla sin el texto original. "
    "Conserva: el objetivo del usuario, decisiones tomadas, datos concretos (nombres, cifras, "
    "rutas de archivos, fragmentos de código importantes), preferencias que haya expresado y "
    "lo que quedó pendiente. Escribe en el idioma de la conversación, en viñetas breves, sin "
    "saludos ni comentarios sobre el resumen. Máximo unas 400 palabras."
)

Resumir = Callable[[str | None, list[dict]], Awaitable[tuple[str, dict[str, int]]]]


def presupuesto(num_ctx: int) -> int:
    return num_ctx - max(RESERVE_MIN, int(num_ctx * RESERVE_RATIO))


def huella(mensajes: list[dict]) -> str:
    """Huella del tramo resumido. Solo cuentan los mensajes del usuario: el
    cliente los reenvía tal cual se guardaron, mientras que el texto de las
    respuestas puede volver con pequeñas diferencias (formato, bloques que la
    web retira) y haría que el resumen no se aplicara nunca."""
    del_usuario = [str(m.get("content") or "") for m in mensajes if m.get("role") == "user"]
    datos = json.dumps([len(mensajes), del_usuario], ensure_ascii=False)
    return hashlib.sha256(datos.encode("utf-8")).hexdigest()


def mensaje_resumen(texto: str) -> dict:
    return {"role": "system", "content": f"{PREFIJO_RESUMEN}\n{texto.strip()}"}


@dataclass
class Resultado:
    messages: list[dict]
    # Si se generó un resumen nuevo: qué guardar y cuánto costó.
    guardar: dict[str, Any] | None = None
    uso: dict[str, int] = field(default_factory=dict)
    compactados: int = 0


def _separar(messages: list[dict]) -> tuple[list[dict], list[dict]]:
    """Los `system` iniciales (instrucciones fijas) y el resto."""
    i = 0
    while i < len(messages) and messages[i].get("role") == "system":
        i += 1
    return messages[:i], messages[i:]


def _corte(resto: list[dict], desde: int, objetivo: int) -> int | None:
    """Índice desde el que se conservan los mensajes recientes: los que quepan
    en `objetivo` tokens, al menos MIN_RECIENTES y empezando en un mensaje del
    usuario (no se parte un intercambio). None si no hay nada que resumir."""
    usado, k = 0, len(resto)
    while k > desde:
        coste = estimate_tokens([resto[k - 1]])
        if len(resto) - k >= MIN_RECIENTES and usado + coste > objetivo:
            break
        usado += coste
        k -= 1
    while k < len(resto) and resto[k].get("role") != "user":
        k += 1
    if k >= len(resto) or k <= desde:
        return None
    return k


async def compactar(messages: list[dict], num_ctx: int, guardado: dict[str, Any] | None,
                    resumir: Resumir) -> Resultado:
    """Aplica el resumen guardado (si sigue valiendo) y, si aun así no cabe,
    resume la parte antigua. Nunca lanza: si resumir falla, se devuelve lo que
    hay y `fit_messages` recorta como antes."""
    sistema, resto = _separar(messages)
    desde, previo = 0, None
    if guardado and 0 < guardado["upto"] < len(resto) and huella(resto[:guardado["upto"]]) == guardado["digest"]:
        desde, previo = int(guardado["upto"]), guardado["summary"]

    def armar(inicio: int, resumen: str | None) -> list[dict]:
        return sistema + ([mensaje_resumen(resumen)] if resumen else []) + resto[inicio:]

    actual = armar(desde, previo)
    limite = presupuesto(num_ctx)
    if estimate_tokens(actual) <= limite:
        return Resultado(actual)

    k = _corte(resto, desde, int(limite * FRACCION_RECIENTE))
    if k is None:
        return Resultado(actual)  # todo es reciente (un mensaje enorme): que recorte fit_messages

    uso_total = {"prompt_tokens": 0, "completion_tokens": 0, "cached_tokens": 0}
    resumen = previo
    tramo_max = int(num_ctx * FRACCION_TRAMO)
    i = desde
    try:
        while i < k:
            j = i
            base = estimate_tokens([mensaje_resumen(resumen)]) if resumen else 0
            while j < k and (j == i or base + estimate_tokens(resto[i:j + 1]) <= tramo_max):
                j += 1
            resumen, uso = await resumir(resumen, resto[i:j])
            for clave in uso_total:
                uso_total[clave] += int(uso.get(clave) or 0)
            if not (resumen or "").strip():
                raise ValueError("resumen vacío")
            i = j
    except Exception as exc:
        logger.warning(f"[compaction] no se pudo resumir ({exc}); se recorta como antes")
        return Resultado(actual, uso=uso_total)

    logger.info(f"[compaction] {k - desde} mensaje(s) resumidos (cubre {k} de {len(resto)})")
    return Resultado(
        armar(k, resumen),
        guardar={"summary": resumen.strip(), "upto": k, "digest": huella(resto[:k])},
        uso=uso_total,
        compactados=k - desde,
    )


def prompt_resumen(previo: str | None, tramo: list[dict]) -> list[dict]:
    """Mensajes para pedirle el resumen al modelo."""
    lineas = []
    if previo:
        lineas.append(f"Resumen de lo anterior:\n{previo.strip()}\n")
    for m in tramo:
        contenido = m.get("content")
        if isinstance(contenido, list):
            contenido = " ".join(str(p.get("text", "")) for p in contenido if isinstance(p, dict))
        quien = {"user": "Usuario", "assistant": "Asistente"}.get(m.get("role"), m.get("role") or "")
        lineas.append(f"{quien}: {contenido or ''}")
    return [
        {"role": "system", "content": INSTRUCCIONES},
        {"role": "user", "content": "\n\n".join(lineas)},
    ]
