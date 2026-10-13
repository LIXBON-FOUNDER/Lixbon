import pytest

from core.inference.esfuerzo import nivel_de_razonamiento, pide_datos_actuales, podria_necesitar_internet


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
    "resuelve 2x + 3 = 11",
    "calcula la integral de x^2 entre 0 y 3",
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
    "Cual es el resultado de 2×2+5",
    "cuánto es 37 * 41",
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


def test_el_texto_de_los_adjuntos_no_cuenta_como_mensaje_largo():
    adjunto = "--- Imagen adjunta: foto.jpg (descrita por un modelo de visión) ---\n" + "detalle " * 200
    assert nivel_de_razonamiento(_u(adjunto + "\n\n---\n\nDescribe esta imagen")) == "low"
    assert nivel_de_razonamiento(_u(adjunto + "\n\n---\n\n¿Por qué falla?")) is True


@pytest.mark.parametrize("texto", ["hola", "Hola! ¿cómo estás?", "muchas gracias", "Cual es el resultado de 2×2+5", "cuánto es 37 * 41",
                                   "arregla esto:\n```js\nconst a = 1\n```"])
def test_no_hace_falta_planificar_la_busqueda(texto):
    assert podria_necesitar_internet(_u(texto)) is False


@pytest.mark.parametrize("texto", ["¿Quién ganó el mundial de 2022?", "precio del dólar en México hoy", "clima en Lima",
                                   "explica la diferencia entre TCP y UDP"])
def test_puede_hacer_falta_buscar(texto):
    assert podria_necesitar_internet(_u(texto)) is True


@pytest.mark.parametrize("texto", ["precio del dolar en colombia hoy", "¿Cuál es la cotización del euro?",
                                   "últimas noticias de Chile", "clima en Bogotá", "latest version of React"])
def test_lo_que_cambia_con_el_tiempo_se_busca_siempre(texto):
    assert pide_datos_actuales(_u(texto)) is True


@pytest.mark.parametrize("texto", ["explica la diferencia entre TCP y UDP", "hola", "que es lixbon.com?",
                                   "arregla esto:\n```py\nprecio = 1\n```"])
def test_lo_estable_lo_decide_el_planificador(texto):
    assert pide_datos_actuales(_u(texto)) is False
