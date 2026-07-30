"""Espaciado del transcript durante el streaming.

Regresión: con la barra de estado fija (fila fuera de la región de scroll,
DECSTBM) rich creía disponer de una fila más de la que hay. El render del Live
se pasaba de alto, la terminal scrolleaba dentro de la región y el borrado
`cursor-up × alto` del Live dejaba de cuadrar: la respuesta acababa pegada al
fondo con un hueco enorme encima.
"""
import sys
from pathlib import Path

import pytest

CLI_DIR = Path(__file__).resolve().parents[1]
if str(CLI_DIR) not in sys.path:
    sys.path.insert(0, str(CLI_DIR))

pytest.importorskip("rich")

from rich.console import Console, Group  # noqa: E402
from rich.markdown import Markdown  # noqa: E402

from lixbon_cli import term  # noqa: E402
from lixbon_cli.theme import make_console, pad  # noqa: E402
from lixbon_cli.ui import Tail  # noqa: E402

TEXTO_LARGO = "\n\n".join(f"{i}. " + "palabra " * 30 for i in range(1, 25))


@pytest.fixture
def sin_barra():
    """La fila reservada y la Console son globales: se dejan como estaban."""
    console = make_console()
    previo = (term._status_rows, console._width, console._height)
    term._status_rows = 0
    yield
    term._status_rows, console._width, console._height = previo


def _alto(renderable, width=80):
    console = Console(width=width)
    return len(console.render_lines(renderable, console.options.update(width=width), pad=False))


def _texto(renderable, width=80):
    console = Console(width=width)
    lines = console.render_lines(renderable, console.options.update(width=width), pad=False)
    return "".join(seg.text for line in lines for seg in line)


def test_tail_acota_el_alto():
    bloque = pad(Group(Markdown(TEXTO_LARGO)))
    completo = _alto(bloque)
    assert completo > 30, "el texto de prueba debe desbordar cualquier pantalla"
    for limite in (4, 10, 20):
        assert _alto(Tail(bloque, limite)) == limite


def test_tail_no_recorta_lo_que_ya_cabe():
    bloque = pad(Group(Markdown("una línea")))
    assert _alto(Tail(bloque, 50)) == _alto(bloque)


def test_tail_devuelve_el_final_no_el_principio():
    # Mientras el modelo escribe, lo que interesa leer es la cola.
    bloque = pad(Group(Markdown(TEXTO_LARGO)))
    console = Console(width=80)
    lines = console.render_lines(bloque, console.options.update(width=80), pad=False)
    esperado = "".join(seg.text for line in lines[-3:] for seg in line)
    assert _texto(Tail(bloque, 3)) == esperado


def test_tail_sin_newline_final():
    # Un salto de línea al final sumaría una fila al alto que mide el Live.
    bloque = pad(Group(Markdown(TEXTO_LARGO)))
    console = Console(width=80)
    segmentos = list(console.render(Tail(bloque, 5), console.options.update(width=80)))
    assert segmentos and not segmentos[-1].text.endswith("\n")


def test_console_descuenta_la_fila_de_la_barra(sin_barra):
    console = make_console()
    real = Console.size.fget(console).height
    assert console.size.height == real
    term._status_rows = 40
    assert console.size.height == real - 1


def test_console_size_sigue_siendo_asignable(sin_barra):
    console = make_console()
    console.size = (70, 30)  # rich ajusta el ancho en Windows; se mira el alto
    assert console.size.height == 30
    term._status_rows = 40
    assert console.size.height == 29
