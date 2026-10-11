"""Cuánto razona el chat cuando el cliente no lo pide: decisión sin llamar al
modelo, para que un saludo no pague decenas de segundos de razonamiento."""
from __future__ import annotations

import re
import unicodedata
from typing import Literal

Nivel = Literal[False, "low", True]

PALABRAS_CORTO = 8
PALABRAS_LARGO = 60

# Web y móvil anteponen el texto de los adjuntos así (ver attachments.js).
_SEPARADOR_ADJUNTOS = "\n\n---\n\n"

_CODIGO = re.compile(
    r"```|Traceback \(most recent|\bat [\w.$]+\(|\w*(Error|Exception):|^\s*(def|class|function|func|import|const|SELECT)\b",
    re.MULTILINE,
)
_CALCULO = re.compile(r"\d\s*[-+*/^=<>%×÷]\s*\d|\d+\s*(x|por|entre|elevado a)\s*\d+")
_CALCULO_DIFICIL = re.compile(r"[∫∑√∂]|\b(integral|derivada|limite|matriz|ecuacion|probabilidad|demostracion)\w*")
_ANALISIS = re.compile(
    r"\b(por ?que|explica\w*|compara\w*|demuestra\w*|resuelve|resolver|depura\w*|debug\w*|"
    r"disen\w*|planifica\w*|analiza\w*|optimiza\w*|refactoriza\w*|paso a paso|razona\w*|deduce|"
    r"why|explain\w*|compare|prove|solve|design|plan|analy[sz]e|optimi[sz]e|refactor|step by step)\b"
)


_CHARLA = frozenset(
    "hola buenas buenos dias tardes noches hey hi hello gracias muchas mil thanks thank you ok okay vale "
    "si no claro perfecto genial bien muy todo como estas esta que tal adios chao bye nos vemos de nada "
    "entendido listo excelente super good great nice cool yes sure np".split()
)


def _plano(texto: str) -> str:
    sin_tildes = unicodedata.normalize("NFKD", texto.lower())
    return "".join(c for c in sin_tildes if not unicodedata.combining(c))


def _ultima_pregunta(messages: list[dict]) -> tuple[str, bool] | None:
    ultimo = next((m for m in reversed(messages) if m.get("role") == "user"), None)
    if ultimo is None:
        return None
    texto = str(ultimo.get("content") or "")
    adjuntos = bool(ultimo.get("images"))
    if texto.startswith("--- ") and _SEPARADOR_ADJUNTOS in texto:
        texto = texto.rsplit(_SEPARADOR_ADJUNTOS, 1)[1]
        adjuntos = True
    return texto, adjuntos


def podria_necesitar_internet(messages: list[dict]) -> bool:
    """Si merece la pena preguntar al planificador de búsquedas (web_search
    auto): una cuenta, código o un saludo nunca dependen de internet."""
    pregunta = _ultima_pregunta(messages)
    if pregunta is None:
        return False
    texto, _ = pregunta
    if _CODIGO.search(texto):
        return False
    plano = _plano(texto)
    palabras = re.findall(r"[a-zñ]+", plano)
    if len(palabras) <= PALABRAS_CORTO and all(p in _CHARLA for p in palabras):
        return False
    return not (_CALCULO.search(plano) and len(plano.split()) <= 12)


def nivel_de_razonamiento(messages: list[dict]) -> Nivel:
    pregunta = _ultima_pregunta(messages)
    if pregunta is None:
        return "low"
    texto, adjuntos = pregunta
    if _CODIGO.search(texto):
        return True
    plano = _plano(texto)
    palabras = len(plano.split())
    if palabras > PALABRAS_LARGO or _ANALISIS.search(plano) or _CALCULO_DIFICIL.search(plano):
        return True
    if _CALCULO.search(plano):
        return "low"
    if adjuntos:
        return "low"
    if palabras <= PALABRAS_CORTO and not re.search(r"\d", plano):
        return False
    return "low"
