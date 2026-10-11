"""Cuánto razona el chat cuando el cliente no lo pide: decisión sin llamar al
modelo, para que un saludo no pague decenas de segundos de razonamiento."""
from __future__ import annotations

import re
import unicodedata
from typing import Literal

Nivel = Literal[False, "low", True]

PALABRAS_CORTO = 8
PALABRAS_LARGO = 60

_CODIGO = re.compile(
    r"```|Traceback \(most recent|\bat [\w.$]+\(|\w*(Error|Exception):|^\s*(def|class|function|func|import|const|SELECT)\b",
    re.MULTILINE,
)
_CALCULO = re.compile(r"\d\s*[-+*/^=<>%]\s*\d|\d+\s*(x|por|entre|elevado a)\s*\d+|[∫∑√]")
_ANALISIS = re.compile(
    r"\b(por ?que|explica\w*|compara\w*|demuestra\w*|calcula\w*|resuelve|resolver|depura\w*|debug\w*|"
    r"disen\w*|planifica\w*|analiza\w*|optimiza\w*|refactoriza\w*|paso a paso|razona\w*|deduce|"
    r"why|explain\w*|compare|prove|calculate|solve|design|plan|analy[sz]e|optimi[sz]e|refactor|step by step)\b"
)


def _plano(texto: str) -> str:
    sin_tildes = unicodedata.normalize("NFKD", texto.lower())
    return "".join(c for c in sin_tildes if not unicodedata.combining(c))


def nivel_de_razonamiento(messages: list[dict]) -> Nivel:
    ultimo = next((m for m in reversed(messages) if m.get("role") == "user"), None)
    if ultimo is None:
        return "low"
    texto = str(ultimo.get("content") or "")
    if _CODIGO.search(texto):
        return True
    plano = _plano(texto)
    palabras = len(plano.split())
    if palabras > PALABRAS_LARGO or _CALCULO.search(plano) or _ANALISIS.search(plano):
        return True
    if ultimo.get("images"):
        return "low"
    if palabras <= PALABRAS_CORTO and not re.search(r"\d", plano):
        return False
    return "low"
