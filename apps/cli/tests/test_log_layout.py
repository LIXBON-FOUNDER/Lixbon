"""Registro del agente: aire entre acciones, pasos sin repetir la lista y
resultado en una sola línea."""
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rich.console import Console  # noqa: E402

from lixbon_cli import agent  # noqa: E402
from lixbon_cli.ui import air, render_action, render_output  # noqa: E402


class _Console(Console):
    def __init__(self):
        super().__init__(file=io.StringIO(), width=80, force_terminal=False, color_system=None)
        self.last_blank = True

    def print(self, *objects, **kwargs):
        self.last_blank = not objects or all(o == "" for o in objects)
        super().print(*objects, **kwargs)

    @property
    def text(self):
        return self.file.getvalue()


def test_cada_accion_lleva_aire_por_encima_sin_duplicarlo():
    c = _Console()
    c.print("usuario")
    render_action(c, "leyó", "a.py", readonly=True)
    render_action(c, "editó", "a.py")
    air(c)
    air(c)
    lines = c.text.splitlines()
    assert lines[0] == "usuario" and lines[1] == ""
    assert sum(1 for l in lines if l == "") == 3  # una por acción + una final


def test_pasos_repite_la_lista_solo_si_cambia():
    c = _Console()
    session = {"todo": None, "turn_stats": {"actions": 0, "files": set(), "adds": 0, "dels": 0}}
    agent.tool_todo(session, c, [{"text": "uno", "status": "doing"}, {"text": "dos"}])
    assert "2 pasos" in c.text and "dos" in c.text
    agent.tool_todo(session, c, [{"text": "uno", "status": "done"}, {"text": "dos", "status": "doing"}])
    tail = c.text.splitlines()[-1]
    assert "pasos" in tail and "1/2" in tail and "dos" in tail
    assert c.text.count("uno") == 1  # la lista no se repitió


def test_resumen_del_resultado_quita_la_ruta():
    assert agent._result_summary("Archivo editado: src/a.py (1 reemplazo en la línea 8)") == "1 reemplazo en la línea 8"
    assert agent._result_summary("Movido: a → b") == "Movido: a → b"


def test_salida_de_comando_muestra_cabeza_y_devuelve_la_ultima():
    c = _Console()
    last = render_output(c, "a\nb\nc\nd\ne\n35 passed in 0.4s\n")
    assert last == "35 passed in 0.4s"
    assert "a" in c.text and "2 líneas más" in c.text and "35 passed" not in c.text
    assert render_output(c, "") == ""
