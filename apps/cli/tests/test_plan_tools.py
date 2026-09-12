"""outline, todo, ask_user y el modo plan del agente."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lixbon_cli import agent  # noqa: E402
from lixbon_cli.theme import make_console  # noqa: E402


def test_outline_python_y_js(tmp_path):
    (tmp_path / "a.py").write_bytes(b"import os\n\nclass Foo:\n    def bar(self):\n        pass\n\nasync def main():\n    pass\n")
    out = agent.tool_outline(tmp_path, "a.py")
    assert out.startswith("a.py: 8 líneas")
    assert "    3  class Foo:" in out and "    4      def bar(self):" in out and "    7  async def main():" in out
    (tmp_path / "b.js").write_bytes(b"export function f() {}\nconst g = async (x) => x;\nclass K {\n  run() {\n  }\n}\n")
    out = agent.tool_outline(tmp_path, "b.js")
    assert "export function f()" in out and "const g = async" in out and "class K" in out and "run()" in out
    (tmp_path / "n.txt").write_bytes(b"hola")
    assert "sin esqueleto" in agent.tool_outline(tmp_path, "n.txt")


def test_todo_normaliza_y_guarda_en_sesion():
    session: dict = {}
    out = agent.tool_todo(session, make_console(), [
        {"text": "leer", "status": "done"}, "escribir", {"text": "", "status": "doing"}, {"text": "probar", "status": "raro"},
    ])
    assert session["todo"] == [
        {"text": "leer", "status": "done"}, {"text": "escribir", "status": "pending"}, {"text": "probar", "status": "pending"},
    ]
    assert out.startswith("Lista actualizada: 1/3 hechos.")
    assert agent.tool_todo(session, make_console(), "no").startswith("[ERROR]")


def test_ask_user_usa_el_callback_o_avisa():
    session = {"ask_user": lambda q, opts: f"{q}|{opts}"}
    assert agent.tool_ask_user(session, "¿DB?", ["sqlite", "pg"]) == "Respuesta del usuario: ¿DB?|['sqlite', 'pg']"
    assert "no respondió" in agent.tool_ask_user({"ask_user": lambda q, o: None}, "¿?", None)
    assert "no disponible" in agent.tool_ask_user({}, "¿?", None)
    assert "no disponible" in agent.tool_ask_user({"ask_user": lambda q, o: "x", "remote": object()}, "¿?", None)


def test_modo_plan_bloquea_escrituras_y_deja_leer(tmp_path):
    (tmp_path / "a.txt").write_bytes(b"hola")
    session = {"plan_mode": True, "auto_approve": True, "turn_stats": {"actions": 0, "files": set(), "adds": 0, "dels": 0}}
    console = make_console()
    out = agent._approve_and_run(console, tmp_path, session, "write_file", {"path": "n.txt", "content": "x"})
    assert out.startswith("[modo plan]") and not (tmp_path / "n.txt").exists()
    out = agent._approve_and_run(console, tmp_path, session, "run_command", {"command": "echo hola"})
    assert out.startswith("[modo plan]")
    assert agent._approve_and_run(console, tmp_path, session, "read_file", {"path": "a.txt"}) == "hola"


def test_el_system_prompt_lleva_el_modo_plan(tmp_path):
    from test_agent_context import _FakeStream  # noqa: F401

    stream = _FakeStream(["Plan: 1) x"])
    session = {"native_tools": True, "auto_approve": True, "context_window": 8192, "plan_mode": True}
    agent.run_agent_turn([{"role": "user", "content": "mejora el login"}], tmp_path, session, stream)
    assert "MODO PLAN" in stream.calls[0][0]["content"]
    session["plan_mode"] = False
    stream = _FakeStream(["ok"])
    agent.run_agent_turn([{"role": "user", "content": "x"}], tmp_path, session, stream)
    assert "MODO PLAN" not in stream.calls[0][0]["content"]
    assert "`todo`" in stream.calls[0][0]["content"]
