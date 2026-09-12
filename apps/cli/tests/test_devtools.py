"""Comandos en segundo plano, verificación tras editar, checkpoints (/undo)
y compactación del contexto."""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lixbon_cli import agent, checks, context  # noqa: E402

PY = f'"{sys.executable}"'


def test_background_read_y_stop(tmp_path):
    out = agent.execute_tool_call(tmp_path, "run_command", {
        "command": f'{PY} -c "import time,sys; print(\'listo\'); sys.stdout.flush(); time.sleep(30)"',
        "background": True,
    })
    assert out.startswith("[background p") and "en marcha" in out
    ident = out.split("]")[0].split()[1]
    visto = "listo" in out
    for _ in range(20):
        lectura = agent.tool_read_output(ident)
        visto = visto or "listo" in lectura
        if visto:
            break
        time.sleep(0.2)
    assert visto and "sigue en marcha" in lectura
    assert "(sin salida nueva)" in agent.tool_read_output(ident)
    assert agent.tool_stop_command(ident).startswith(f"[{ident}] detenido")
    assert agent.tool_read_output(ident).startswith("[ERROR]")


def test_background_que_termina_solo(tmp_path):
    out = agent.tool_run_background(tmp_path, f'{PY} -c "print(\'fin\')"')
    ident = out.split("]")[0].split()[1]
    lectura = agent.tool_read_output(ident, wait=5)
    assert "terminó con código 0" in lectura
    agent.tool_stop_command(ident)


def test_verificacion_python_detecta_error(tmp_path, monkeypatch):
    monkeypatch.setattr(checks.shutil, "which", lambda name: None)  # sin ruff: py_compile
    malo = tmp_path / "malo.py"
    malo.write_text("def x(:\n", encoding="utf-8")
    tool, errors = checks.verify_file(tmp_path, malo)
    assert tool == "py_compile" and "SyntaxError" in errors
    bueno = tmp_path / "bueno.py"
    bueno.write_text("x = 1\n", encoding="utf-8")
    assert checks.verify_file(tmp_path, bueno) == ("py_compile", "")
    assert checks.verify_file(tmp_path, tmp_path / "a.md") == ("", "")


def test_verify_after_amplia_el_resultado(tmp_path, monkeypatch):
    monkeypatch.setattr(checks.shutil, "which", lambda name: None)
    (tmp_path / "m.py").write_text("def x(:\n", encoding="utf-8")
    tool, errors, result = agent.verify_after(tmp_path, "edit_file", {"path": "m.py"}, "Archivo editado")
    assert tool == "py_compile" and errors
    assert result.startswith("Archivo editado\n[verificación py_compile]")
    assert agent.verify_after(tmp_path, "read_file", {"path": "m.py"}, "x") == ("", "", "x")


def test_checkpoints_y_undo(tmp_path):
    (tmp_path / "a.txt").write_bytes(b"original")
    session: dict = {}
    agent.snapshot_before(session, tmp_path, "edit_file", {"path": "a.txt"})
    agent.snapshot_before(session, tmp_path, "write_file", {"path": "nuevo.txt"})
    agent.snapshot_before(session, tmp_path, "read_file", {"path": "a.txt"})
    (tmp_path / "a.txt").write_bytes(b"cambiado")
    (tmp_path / "nuevo.txt").write_bytes(b"creado")
    assert [rel for rel, _ in session["checkpoints"]] == ["a.txt", "nuevo.txt"]
    hechos = agent.undo_checkpoints(tmp_path, session["checkpoints"])
    assert hechos == ["eliminado nuevo.txt", "restaurado a.txt"]
    assert (tmp_path / "a.txt").read_bytes() == b"original"
    assert not (tmp_path / "nuevo.txt").exists()


def test_compact_messages_resume_y_conserva_recientes():
    msgs = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"m{i}"} for i in range(10)]
    msgs.insert(5, {"role": "tool", "content": "TOOL", "tool_call_id": "1", "name": "x"})
    recibidos = []

    def ask(messages):
        recibidos.append(messages)
        return "RESUMEN"

    out = context.compact_messages(msgs, ask, keep_recent=4)
    assert out[0]["role"] == "user" and "RESUMEN" in out[0]["content"]
    assert out[1] == {"role": "assistant", "content": "Entendido, sigo desde ahí."}
    assert [m["content"] for m in out[2:]] == ["m6", "m7", "m8", "m9"]
    assert recibidos[0][-1]["content"] == context.COMPACT_PROMPT
    assert all(m["role"] != "tool" for m in recibidos[0])


def test_needs_compaction_por_ventana():
    msgs = [{"role": "user", "content": "x" * 4000}]
    assert context.needs_compaction(msgs, 1000)
    assert not context.needs_compaction(msgs, 100000)
