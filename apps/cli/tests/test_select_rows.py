"""Maquetación del selector: cada fila cuadra al carácter.

`select_rows` es la rejilla que comparten /help, /model, /config y las
aprobaciones. Lo que se comprueba aquí es lo que se ve: la medida al margen
derecho, la fila marcada rellena de punta a punta, las cabeceras de grupo como
regla y el canal cuando el menú cuelga de una acción.
"""
import sys
from pathlib import Path

import pytest

CLI_DIR = Path(__file__).resolve().parents[1]
if str(CLI_DIR) not in sys.path:
    sys.path.insert(0, str(CLI_DIR))

pytest.importorskip("prompt_toolkit")

from lixbon_cli.term import g  # noqa: E402
from lixbon_cli.ui import Option, SelectLayout, select_rows  # noqa: E402

WIDTH = 60


def _lines(fragments):
    """Filas como (texto, estilos por celda), para medir y para ver el fondo."""
    rows, text, styles = [], "", []
    for style, chunk, *_ in fragments:
        if chunk == "\n":
            rows.append((text, styles))
            text, styles = "", []
            continue
        text += chunk
        styles += [style] * len(chunk)
    return rows


def _layout(**extra):
    base = dict(title="Modo de trabajo", hint="hint", detail="", searchable=False,
                total=3, width=WIDTH, label_width=12, max_visible=10)
    return SelectLayout(**{**base, **extra})


OPTIONS = [
    Option("agent", "agent", "lee y edita", badge="actual"),
    Option("ask", "ask", "solo conversa"),
    Option("delegate", "delegate"),
]


def _state(cursor=0, matches=None, query=""):
    return {"matches": matches or list(range(len(OPTIONS))), "cursor": cursor,
            "top": 0, "query": query, "accepted": False}


def test_toda_fila_con_medida_llega_al_margen():
    rows = _lines(select_rows(OPTIONS, _state(), _layout()))
    header, active, plain = rows[0], rows[1], rows[2]
    assert len(header[0]) == WIDTH and header[0].endswith("3 opciones")
    assert len(active[0]) == WIDTH and active[0].endswith("actual  ")
    # Sin canto la fila deja su hueco: la etiqueta cae bajo la marcada.
    assert plain[0].rstrip() == "    ask         solo conversa"
    assert active[0].index("agent") == plain[0].index("ask")


def test_fila_marcada_rellena_hasta_el_margen():
    rows = _lines(select_rows(OPTIONS, _state(cursor=0), _layout()))
    text, styles = rows[1]
    assert text.startswith(f"  {g('edge')} agent")
    # Del canto al final, todas las celdas llevan fondo (`sel.row*`).
    assert all(style.startswith("class:sel.row") for style in styles[3:])


def test_cabecera_de_grupo_es_una_regla():
    options = [Option("conversación", None, disabled=True), *OPTIONS]
    rows = _lines(select_rows(options, _state(cursor=1, matches=[0, 1, 2, 3]),
                              _layout(total=4)))
    text, styles = rows[1]
    assert text.startswith("  conversación ")
    assert len(text) == WIDTH and text.endswith(g("rule"))
    assert "class:sel.rule" in styles


def test_buscable_cuenta_coincidencias():
    rows = _lines(select_rows(OPTIONS, _state(matches=[0, 1], query="a"),
                              _layout(searchable=True)))
    assert rows[0][0].endswith("2 de 3")
    assert "  /a" in rows[0][0]


def test_detalle_manda_sobre_el_recuento():
    rows = _lines(select_rows(OPTIONS, _state(), _layout(detail="src/app.py · +12 -3")))
    assert rows[0][0].endswith("src/app.py · +12 -3")


def test_modo_canal_prefija_cada_fila():
    rows = _lines(select_rows(OPTIONS, _state(), _layout(rail_mode=True)))
    assert all(text.startswith(f"{g('rail')} ") for text, _styles in rows)
    assert all(styles[0] == "class:sel.rail" for _text, styles in rows)
