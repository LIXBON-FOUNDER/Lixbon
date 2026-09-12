"""/update: el CLI nuevo se lanza esperando al hijo (en Windows execv no
sustituye el proceso y el .cmd devolvía el control a cmd encima del CLI)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lixbon_cli import cli  # noqa: E402


def test_relaunch_espera_al_hijo_y_devuelve_su_codigo(tmp_path, monkeypatch):
    script = tmp_path / "nuevo.py"
    script.write_text("import sys; print('arranque', sys.argv[1:]); sys.exit(7)", encoding="utf-8")
    monkeypatch.setattr(cli.os, "name", "nt")
    assert cli.relaunch(script, ["chat", "--model", "x"]) == 7
