"""Comandos propios: .lixbon/commands/*.md del proyecto y ~/.lixbon/commands/."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lixbon_cli.commands import expand_custom_command, load_custom_commands  # noqa: E402


def test_carga_del_proyecto_y_del_usuario_sin_pisar_los_del_cli(tmp_path):
    home = tmp_path / "home"
    ws = tmp_path / "ws"
    (home / "commands").mkdir(parents=True)
    (ws / ".lixbon" / "commands").mkdir(parents=True)
    (home / "commands" / "review.md").write_text("# Revisar cambios\nRevisa el diff y señala bugs.\n", encoding="utf-8")
    (ws / ".lixbon" / "commands" / "Test Fix.md").write_text("Arregla los tests que fallan: $ARGUMENTS", encoding="utf-8")
    (ws / ".lixbon" / "commands" / "help.md").write_text("no debe cargarse", encoding="utf-8")
    found = load_custom_commands(ws, home)
    assert set(found) == {"review", "test-fix"}
    assert found["review"]["desc"] == "Revisar cambios"
    assert found["review"]["body"] == "Revisa el diff y señala bugs."
    assert found["test-fix"]["desc"].startswith("prompt de")


def test_expande_argumentos():
    assert expand_custom_command("Arregla: $ARGUMENTS", "login") == "Arregla: login"
    assert expand_custom_command("Revisa el diff.", "") == "Revisa el diff."
    assert expand_custom_command("Revisa el diff.", "solo src") == "Revisa el diff.\n\nsolo src"
