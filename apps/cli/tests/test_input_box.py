"""La caja de entrada del prompt.

Su alto depende de una combinación concreta de opciones de prompt_toolkit: con
`complete_while_typing` la librería reserva SIEMPRE el hueco del menú y la caja
pasa de tres filas a doce. Es un detalle interno de la librería, así que se fija
aquí en vez de dejarlo a la vista de quien lea el loop.
"""

import sys
from pathlib import Path

import pytest

CLI_DIR = Path(__file__).resolve().parents[1]
if str(CLI_DIR) not in sys.path:
    sys.path.insert(0, str(CLI_DIR))

pytest.importorskip("prompt_toolkit")

from lixbon_cli import ui  # noqa: E402
from lixbon_cli.term import g  # noqa: E402
from lixbon_cli.ui import INPUT_PLACEHOLDER, input_box_kwargs, round_frame_border  # noqa: E402


def _box_height(**extra) -> int:
    """Filas que pide la caja vacía.

    Se mide dentro de `pre_run`: el layout solo se puede consultar con la
    aplicación en marcha (hay controles que registran tareas en el loop).
    """
    from prompt_toolkit import PromptSession
    from prompt_toolkit.application import create_app_session
    from prompt_toolkit.completion import WordCompleter
    from prompt_toolkit.input import create_pipe_input
    from prompt_toolkit.output import DummyOutput

    # show_frame se fuerza: en una consola sin unicode la caja se apaga sola y
    # aquí lo que se mide es la caja.
    options = {**input_box_kwargs(), "show_frame": True, **extra}
    measured = {}
    with create_pipe_input() as pipe, create_app_session(input=pipe, output=DummyOutput()):
        session = PromptSession(completer=WordCompleter(["/model"]), **options)

        def pre_run():
            measured["rows"] = session.app.layout.container.preferred_height(80, 24).preferred

        pipe.send_text("\n")
        session.prompt(pre_run=pre_run)
    return measured["rows"]


def test_caja_en_reposo_mide_tres_filas():
    """Borde, una línea de texto y borde. Ni una fila más."""
    assert _box_height() == 3


def test_complete_while_typing_dispararia_el_alto():
    """Guarda del motivo por el que la opción está apagada."""
    assert _box_height(complete_while_typing=True) > 3


def test_el_prompt_es_un_punto_con_aire():
    options = input_box_kwargs()
    assert [text for _style, text in options["message"]] == [" ", f"{g('dot')} "]
    # La continuación ocupa lo mismo que el prompt: una línea larga sigue
    # alineada con el texto y no con el borde de la caja.
    assert len(options["prompt_continuation"](0, 1, 0)) == 3
    assert options["placeholder"][0][1] == INPUT_PLACEHOLDER
    # Al enviar, la caja se borra y el mensaje se reimprime como burbuja.
    assert options["erase_when_done"] is True


def test_esquinas_redondas(monkeypatch):
    from prompt_toolkit.widgets.base import Border

    monkeypatch.setattr(ui, "UNICODE_OK", True)
    round_frame_border()
    assert (Border.TOP_LEFT, Border.TOP_RIGHT) == ("╭", "╮")
    assert (Border.BOTTOM_LEFT, Border.BOTTOM_RIGHT) == ("╰", "╯")
