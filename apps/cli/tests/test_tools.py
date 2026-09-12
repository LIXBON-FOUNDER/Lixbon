"""Herramientas del agente: listado, búsqueda por nombre y contenido, edición
tolerante a espacios, comandos con timeout real y lectura de URLs."""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lixbon_cli import agent  # noqa: E402
from lixbon_cli.agent import (  # noqa: E402
    READ_ONLY_TOOLS,
    TOOL_SCHEMAS,
    TOOL_SPECS,
    execute_tool_call,
    tool_edit_file,
    tool_find_files,
    tool_list_files,
    tool_run_command,
    tool_search,
)


def _ws(tmp_path: Path) -> Path:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_bytes(b"def main():\n    total = 1\n    return total\n")
    (tmp_path / "src" / "util.js").write_bytes(b"const Total = 2;\n")
    (tmp_path / "node_modules" / "x").mkdir(parents=True)
    (tmp_path / "node_modules" / "x" / "index.js").write_text("total\n", encoding="utf-8")
    (tmp_path / "README.md").write_bytes(b"# demo\n")
    return tmp_path


def test_catalogo_y_esquemas_coinciden():
    nombres = {name for name, _args, _desc in TOOL_SPECS}
    assert nombres == {t["function"]["name"] for t in TOOL_SCHEMAS}
    assert READ_ONLY_TOOLS <= nombres


def test_list_files_muestra_tamanos_y_omite_ruido(tmp_path):
    ws = _ws(tmp_path)
    plano = tool_list_files(ws, ".")
    assert "[D] src/ (2 entradas)" in plano and "[F] README.md (7 B)" in plano
    assert "node_modules/ (omitida)" in plano and "index.js" not in plano
    arbol = tool_list_files(ws, ".", recursive=True)
    assert "[F] src/app.py" in arbol and "index.js" not in arbol


def test_find_files_por_nombre_y_por_ruta(tmp_path):
    ws = _ws(tmp_path)
    assert tool_find_files(ws, "*.py") == "src/app.py"
    assert tool_find_files(ws, "src/*.js") == "src/util.js"
    assert "node_modules" not in tool_find_files(ws, "*.js")
    assert tool_find_files(ws, "*.rs") == "(sin resultados)"


def test_search_literal_glob_e_ignore_case(tmp_path):
    ws = _ws(tmp_path)
    hits = tool_search(ws, "total")
    assert "src/app.py:2:" in hits and "util.js" not in hits and "node_modules" not in hits
    assert "src/util.js:1:" in tool_search(ws, "total", ignore_case=True)
    assert "app.py" not in tool_search(ws, "total", glob="*.js", ignore_case=True)
    assert "(sin resultados)" == tool_search(ws, "total = (")  # literal, no regex
    assert "src/app.py:2:" in tool_search(ws, r"total = \d", regex=True)


def test_search_fallback_python_igual_que_rg(tmp_path, monkeypatch):
    ws = _ws(tmp_path)

    def sin_rg(*a, **k):
        raise FileNotFoundError

    monkeypatch.setattr(agent.subprocess, "run", sin_rg)
    hits = tool_search(ws, "total", ignore_case=True, glob="*.js")
    assert hits == "src/util.js:1:const Total = 2;"


def test_edit_file_exacto_dice_la_linea(tmp_path):
    ws = _ws(tmp_path)
    out = tool_edit_file(ws, "src/app.py", "    return total\n", "    return total * 2\n")
    assert out == "Archivo editado: src/app.py (1 reemplazo en la línea 3)"


def test_edit_file_tolera_indentacion_distinta(tmp_path):
    ws = _ws(tmp_path)
    out = tool_edit_file(ws, "src/app.py", "total = 1\nreturn total", "total = 10\nreturn total")
    assert "línea 2" in out and "ignorando espacios" in out
    assert (ws / "src" / "app.py").read_text(encoding="utf-8") == "def main():\n    total = 10\n    return total\n"


def test_edit_file_tolera_espacios_finales_y_conserva_crlf(tmp_path):
    f = tmp_path / "a.txt"
    f.write_bytes(b"uno  \r\ndos\r\ntres\r\n")
    out = tool_edit_file(tmp_path, "a.txt", "uno\ndos", "uno\nDOS")
    assert "línea 1" in out
    assert f.read_bytes() == b"uno\r\nDOS\r\ntres\r\n"


def test_edit_file_ambiguo_o_ausente_falla_claro(tmp_path):
    f = tmp_path / "b.txt"
    f.write_text("x = 1\n  x = 1\n", encoding="utf-8")
    assert "aparece 2 veces" in tool_edit_file(tmp_path, "b.txt", "x = 1", "x = 2")
    assert "[ERROR] No se encontró" in tool_edit_file(tmp_path, "b.txt", "y = 9", "z")
    assert f.read_text(encoding="utf-8") == "x = 1\n  x = 1\n"


def test_run_command_exit_y_timeout(tmp_path):
    out = tool_run_command(tmp_path, f'"{sys.executable}" -c "print(\'hola\')"')
    assert out == "[EXIT 0] hola"
    started = time.monotonic()
    out = tool_run_command(tmp_path, f'"{sys.executable}" -c "import time; time.sleep(30)"', timeout=1)
    assert out.startswith("[TIMEOUT]") and time.monotonic() - started < 10


def test_read_file_binario_avisa(tmp_path):
    (tmp_path / "x.bin").write_bytes(b"\x00\x01\x02" * 100)
    out = execute_tool_call(tmp_path, "read_file", {"path": "x.bin"})
    assert out.startswith("[binario] x.bin")


def test_fetch_url_convierte_html_en_texto(monkeypatch):
    import io

    class Resp(io.BytesIO):
        headers = {"Content-Type": "text/html; charset=utf-8"}

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    html = b"<html><head><style>x{}</style></head><body><h1>Hola</h1><p>Mundo &amp; m\xc3\xa1s</p></body></html>"
    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout: Resp(html))
    assert execute_tool_call(Path("."), "fetch_url", {"url": "https://x.test/"}) == "Hola\n\nMundo & más"
    assert execute_tool_call(Path("."), "fetch_url", {"url": "ftp://x"}).startswith("[ERROR]")


def test_web_search_formatea_resultados():
    class Api:
        def web_search(self, query, limit):
            return {"results": [{"title": "Doc", "url": "https://d.test", "snippet": "  algo   útil "}]}

    out = execute_tool_call(Path("."), "web_search", {"query": "q"}, api=Api())
    assert out == "1. Doc\n   https://d.test\n   algo útil"
    assert execute_tool_call(Path("."), "web_search", {"query": "q"}).startswith("[ERROR]")
