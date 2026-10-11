import pytest

from core.inference.esfuerzo import nivel_de_razonamiento


def _u(texto, **extra):
    return [{"role": "user", "content": texto, **extra}]


@pytest.mark.parametrize("texto", ["hola", "Hola!", "gracias", "ok", "buenos días, ¿cómo estás?",
                                   "hi there", "¿cuál es la capital de Francia?"])
def test_lo_conversacional_no_razona(texto):
    assert nivel_de_razonamiento(_u(texto)) is False


@pytest.mark.parametrize("texto", [
    "¿Por qué el cielo es azul?",
    "explica la diferencia entre TCP y UDP",
    "compara React con Vue",
    "cuánto es 37 * 41",
    "resuelve 2x + 3 = 11",
    "why does this fail",
    "falla esto:\n```py\nprint(1/0)\n```",
    "Traceback (most recent call last):\n  File x",
    "TypeError: undefined is not a function",
    "palabra " * 70,
])
def test_lo_que_pide_pensar_razona(texto):
    assert nivel_de_razonamiento(_u(texto)) is True


@pytest.mark.parametrize("texto", [
    "dame ideas de nombres para una cafetería en la playa",
    "en 2024 qué pasó",
    "escribe un poema corto sobre el mar y la luna llena",
])
def test_lo_intermedio_razona_poco(texto):
    assert nivel_de_razonamiento(_u(texto)) == "low"


def test_una_imagen_no_es_un_saludo():
    assert nivel_de_razonamiento(_u("¿qué es esto?", images=["b64"])) == "low"


def test_mira_solo_el_ultimo_mensaje_del_usuario():
    mensajes = [
        {"role": "user", "content": "explica la relatividad paso a paso"},
        {"role": "assistant", "content": "…"},
        {"role": "user", "content": "gracias"},
        {"role": "assistant", "content": ""},
    ]
    assert nivel_de_razonamiento(mensajes) is False


def test_sin_mensaje_del_usuario():
    assert nivel_de_razonamiento([{"role": "system", "content": "x"}]) == "low"
