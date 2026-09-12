"""Adjuntos con `@`: búsqueda en el workspace y archivos de texto en el mensaje."""
import sys
from pathlib import Path

CLI_DIR = Path(__file__).resolve().parents[1]
if str(CLI_DIR) not in sys.path:
    sys.path.insert(0, str(CLI_DIR))

from lixbon_cli import commands  # noqa: E402
from lixbon_cli.agent import _group_reads  # noqa: E402
from lixbon_cli.commands import (  # noqa: E402
    attachments_block,
    parse_attachments,
    search_workspace,
    wants_completion,
)


def _workspace(tmp_path: Path) -> Path:
    (tmp_path / "src" / "utils").mkdir(parents=True)
    (tmp_path / "src" / "utils" / "parser.py").write_text("x = 1\n", encoding="utf-8")
    (tmp_path / "src" / "parse_args.py").write_text("y = 2\n", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "parser.js").write_text("", encoding="utf-8")
    (tmp_path / ".env").write_text("SECRET=1", encoding="utf-8")
    (tmp_path / "logo.png").write_bytes(b"\x89PNG")
    commands._index_cache.clear()
    return tmp_path


def test_busca_en_todo_el_arbol_y_ordena_por_nombre(tmp_path):
    ws = _workspace(tmp_path)
    found = [rel for rel, _dir, _size in search_workspace(ws, "par")]
    assert found[:2] == ["src/parse_args.py", "src/utils/parser.py"]
    assert not any(rel.startswith("node_modules") for rel in found)


def test_los_ocultos_solo_salen_si_se_piden(tmp_path):
    ws = _workspace(tmp_path)
    assert ".env" not in [rel for rel, *_ in search_workspace(ws, "")]
    assert ".env" in [rel for rel, *_ in search_workspace(ws, ".e")]


def test_wants_completion():
    assert wants_completion("/mo")
    assert wants_completion("/model qw")
    assert not wants_completion("/mode agent")
    assert wants_completion("mira @src/pa")
    assert not wants_completion("hola")


def test_archivo_de_texto_se_adjunta_y_la_imagen_va_aparte(tmp_path):
    ws = _workspace(tmp_path)
    clean, images, files, errors = parse_attachments(
        "revisa @src/utils/parser.py y @logo.png; saluda a @gabriel", ws)
    assert clean == "revisa src/utils/parser.py y logo.png; saluda a @gabriel"
    assert [p.name for p in images] == ["logo.png"]
    assert files == [("src/utils/parser.py", "x = 1\n")]
    assert errors == []


def test_bloque_de_adjuntos_usa_una_valla_mas_larga_si_hace_falta():
    block = attachments_block([("a.md", "```python\nprint(1)\n```\n")])
    assert block.startswith("Archivo adjunto `a.md`:\n````\n")
    assert block.endswith("\n````")


def test_lecturas_seguidas_van_juntas():
    calls = [{"tool": "read_file"}, {"tool": "read_file"}, {"tool": "search"},
             {"tool": "read_file"}]
    assert [len(group) for group in _group_reads(calls)] == [2, 1, 1]
