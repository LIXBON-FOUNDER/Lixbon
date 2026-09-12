"""multi_edit, insert_at_line y permisos por prefijo de comando."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lixbon_cli import agent  # noqa: E402
from lixbon_cli.diffs import compute_change  # noqa: E402


def test_multi_edit_aplica_en_orden_y_reporta_fallos(tmp_path):
    f = tmp_path / "a.py"
    f.write_bytes(b"x = 1\ny = 2\nz = 3\n")
    out = agent.tool_multi_edit(tmp_path, "a.py", [
        {"old_text": "x = 1", "new_text": "x = 10"}, {"old_text": "z = 3", "new_text": "z = 30"},
    ])
    assert out.startswith("Archivo editado: a.py (2 ediciones")
    assert f.read_bytes() == b"x = 10\ny = 2\nz = 30\n"
    out = agent.tool_multi_edit(tmp_path, "a.py", [
        {"old_text": "y = 2", "new_text": "y = 20"}, {"old_text": "no existe", "new_text": "q"},
    ])
    assert out.startswith("[ERROR] Edición 2 de 2") and "Ya se aplicaron las 1 anteriores" in out
    assert b"y = 20" in f.read_bytes()
    assert agent.tool_multi_edit(tmp_path, "a.py", []).startswith("[ERROR]")


def test_insert_at_line_conserva_finales_de_linea(tmp_path):
    f = tmp_path / "a.txt"
    f.write_bytes(b"uno\r\ndos\r\n")
    out = agent.tool_insert_at_line(tmp_path, "a.txt", 2, "medio")
    assert "1 líneas insertadas en la línea 2" in out
    assert f.read_bytes() == b"uno\r\nmedio\r\ndos\r\n"
    agent.tool_insert_at_line(tmp_path, "a.txt", 0, "fin\n")
    assert f.read_bytes() == b"uno\r\nmedio\r\ndos\r\nfin\r\n"
    change = compute_change(tmp_path, "insert_at_line", {"path": "a.txt", "line": 1, "content": "cero\n"}, agent.resolve_safe_path)
    assert change.new_text.startswith("cero\nuno")


def test_compute_change_previsualiza_multi_edit(tmp_path):
    (tmp_path / "a.txt").write_bytes(b"a b c")
    change = compute_change(tmp_path, "multi_edit", {"path": "a.txt", "edits": [
        {"old_text": "a", "new_text": "A"}, {"old_text": "c", "new_text": "C"}]}, agent.resolve_safe_path)
    assert change.new_text == "A b C"


def test_prefijo_y_permiso_de_comandos():
    assert agent.command_prefix("npm test -- --watch") == "npm test"
    assert agent.command_prefix("pytest -q") == "pytest"
    assert agent.command_prefix("git -C x status") == "git"
    assert agent.command_prefix("") == ""
    allowed = ["npm test", "pytest"]
    assert agent.command_allowed("npm test -- --ci", allowed)
    assert agent.command_allowed("pytest tests/ -q && npm test", allowed)
    assert not agent.command_allowed("npm test && rm -rf x", allowed)
    assert not agent.command_allowed("npm install", allowed)
    assert not agent.command_allowed("npm", allowed)
    assert not agent.command_allowed("pytest | tee log; curl x", allowed)
