"""Corpus dorado de las herramientas de escritura del agente.

Cada caso parte de un árbol inicial, ejecuta una herramienta Python y guarda la
salida y el árbol resultante (archivos y carpetas). Las implementaciones
portadas (Go) rehacen el árbol, ejecutan y comparan.

Normalizaciones para que el corpus no dependa del sistema operativo:
  - write_file/append_file escriben en modo texto: en Windows Python convierte
    \\n en \\r\\n. Se normaliza a \\n (los casos no llevan \\r de entrada).
  - Los mensajes de write_file/append_file/mkdir usan la ruta del SO; se
    normalizan a "/".
  - El glifo de rename_file depende de la consola; se fija a "→".

    python apps/cli/validation/gen_edit_corpus.py          # reescribe
    python apps/cli/validation/gen_edit_corpus.py --check  # falla si cambió
"""
import base64
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from lixbon_cli import agent, term  # noqa: E402

term.UNICODE_OK = True

CORPUS = HERE / "fixtures" / "edit_corpus.json"

PY = "def a():\n    return 1\n\n\ndef b():\n    return 2\n"
TABS_FILE = "if x:\n\tprint(1)\n\tprint(2)\n"
INDENTED = "class C:\n    def m(self):\n        x = 1\n        y = 2\n        return x + y\n"
TRAILING = "uno  \ndos\t\ntres\n"
DUP = "foo\nbar\nfoo\nbar\n"

CASES: list[tuple[str, dict, str, dict]] = [
    # ── edit_file ────────────────────────────────────────────────────────
    ("edit_exact", {"a.py": PY}, "edit_file",
     {"path": "a.py", "old_text": "return 1", "new_text": "return 10"}),
    ("edit_exact_multiline", {"a.py": PY}, "edit_file",
     {"path": "a.py", "old_text": "def a():\n    return 1\n", "new_text": "def a():\n    return 0\n"}),
    ("edit_all", {"a.txt": "x y x z x\n"}, "edit_file",
     {"path": "a.txt", "old_text": "x", "new_text": "W", "all": True}),
    ("edit_ambiguous", {"a.txt": "x y x\n"}, "edit_file",
     {"path": "a.txt", "old_text": "x", "new_text": "W"}),
    ("edit_delete_fragment", {"a.txt": "hola mundo\n"}, "edit_file",
     {"path": "a.txt", "old_text": " mundo", "new_text": ""}),
    ("edit_missing_old_text", {"a.txt": "x\n"}, "edit_file",
     {"path": "a.txt", "old_text": "", "new_text": "y"}),
    ("edit_not_found", {"a.txt": "x\n"}, "edit_file",
     {"path": "a.txt", "old_text": "inexistente", "new_text": "y"}),
    ("edit_missing_file", {}, "edit_file",
     {"path": "nada.txt", "old_text": "a", "new_text": "b"}),
    ("edit_directory", {"d/x.txt": "x"}, "edit_file",
     {"path": "d", "old_text": "a", "new_text": "b"}),
    ("edit_outside", {}, "edit_file",
     {"path": "../fuera.txt", "old_text": "a", "new_text": "b"}),
    ("edit_unicode_line_number", {"a.txt": "á\né\nmañana ñ\n"}, "edit_file",
     {"path": "a.txt", "old_text": "mañana", "new_text": "tarde"}),
    ("edit_bom_preserved", {"a.txt": "\ufeffhola\nadiós\n"}, "edit_file",
     {"path": "a.txt", "old_text": "adiós", "new_text": "chao"}),
    ("edit_crlf_exact", {"a.txt": b"uno\r\ndos\r\ntres\r\n"}, "edit_file",
     {"path": "a.txt", "old_text": "dos\r\n", "new_text": "DOS\r\n"}),
    ("edit_crlf_loose", {"a.txt": b"uno\r\ndos\r\ntres\r\n"}, "edit_file",
     {"path": "a.txt", "old_text": "dos\ntres", "new_text": "DOS\nTRES"}),
    ("edit_loose_trailing_whitespace", {"a.txt": TRAILING}, "edit_file",
     {"path": "a.txt", "old_text": "uno\ndos", "new_text": "UNO\nDOS"}),
    ("edit_loose_reindent", {"a.py": INDENTED}, "edit_file",
     {"path": "a.py", "old_text": "x = 1\ny = 2", "new_text": "x = 10\n    y = 20"}),
    ("edit_loose_reindent_tabs", {"a.py": TABS_FILE}, "edit_file",
     {"path": "a.py", "old_text": "print(1)\nprint(2)", "new_text": "print(3)\nprint(4)"}),
    ("edit_loose_ambiguous", {"a.txt": DUP}, "edit_file",
     {"path": "a.txt", "old_text": "foo \nbar ", "new_text": "X"}),
    ("edit_loose_leading_newlines_stripped", {"a.txt": "a\nb\nc\n"}, "edit_file",
     {"path": "a.txt", "old_text": "\n\nb\n", "new_text": "B"}),
    ("edit_string_all_flag_truthy", {"a.txt": "x x\n"}, "edit_file",
     {"path": "a.txt", "old_text": "x", "new_text": "y", "all": 1}),

    # ── multi_edit ───────────────────────────────────────────────────────
    ("multi_edit_ok", {"a.py": PY}, "multi_edit",
     {"path": "a.py", "edits": [{"old_text": "return 1", "new_text": "return 10"},
                                {"old_text": "return 2", "new_text": "return 20"}]}),
    ("multi_edit_second_fails", {"a.py": PY}, "multi_edit",
     {"path": "a.py", "edits": [{"old_text": "return 1", "new_text": "return 10"},
                                {"old_text": "no existe", "new_text": "x"}]}),
    ("multi_edit_first_fails", {"a.py": PY}, "multi_edit",
     {"path": "a.py", "edits": [{"old_text": "no existe", "new_text": "x"}]}),
    ("multi_edit_with_all", {"a.txt": "x x\ny\n"}, "multi_edit",
     {"path": "a.txt", "edits": [{"old_text": "x", "new_text": "z", "all": True},
                                 {"old_text": "y", "new_text": "w"}]}),
    ("multi_edit_not_a_list", {"a.txt": "x"}, "multi_edit",
     {"path": "a.txt", "edits": "x"}),
    ("multi_edit_empty_list", {"a.txt": "x"}, "multi_edit",
     {"path": "a.txt", "edits": []}),
    ("multi_edit_item_not_object", {"a.txt": "x"}, "multi_edit",
     {"path": "a.txt", "edits": ["x"]}),

    # ── insert_at_line ───────────────────────────────────────────────────
    ("insert_middle", {"a.txt": "1\n2\n3\n"}, "insert_at_line",
     {"path": "a.txt", "line": 2, "content": "X\n"}),
    ("insert_first_line", {"a.txt": "1\n2\n"}, "insert_at_line",
     {"path": "a.txt", "line": 1, "content": "X\n"}),
    ("insert_zero_appends", {"a.txt": "1\n2\n"}, "insert_at_line",
     {"path": "a.txt", "line": 0, "content": "X\n"}),
    ("insert_beyond_end", {"a.txt": "1\n2\n"}, "insert_at_line",
     {"path": "a.txt", "line": 99, "content": "X\n"}),
    ("insert_negative_line", {"a.txt": "1\n2\n"}, "insert_at_line",
     {"path": "a.txt", "line": -3, "content": "X\n"}),
    ("insert_without_trailing_newline_in_content", {"a.txt": "1\n2\n"}, "insert_at_line",
     {"path": "a.txt", "line": 2, "content": "X"}),
    ("insert_multiline", {"a.txt": "1\n2\n"}, "insert_at_line",
     {"path": "a.txt", "line": 2, "content": "A\nB\nC\n"}),
    ("insert_crlf_file", {"a.txt": b"1\r\n2\r\n3\r\n"}, "insert_at_line",
     {"path": "a.txt", "line": 2, "content": "X\n"}),
    ("insert_into_file_without_final_newline", {"a.txt": "1\n2"}, "insert_at_line",
     {"path": "a.txt", "line": 0, "content": "X\n"}),
    ("insert_into_empty_file", {"a.txt": ""}, "insert_at_line",
     {"path": "a.txt", "line": 1, "content": "X\n"}),
    ("insert_empty_content", {"a.txt": "1\n2\n"}, "insert_at_line",
     {"path": "a.txt", "line": 1, "content": ""}),
    ("insert_missing_file", {}, "insert_at_line",
     {"path": "nada.txt", "line": 1, "content": "X"}),
    ("insert_string_line_number", {"a.txt": "1\n2\n3\n"}, "insert_at_line",
     {"path": "a.txt", "line": "2", "content": "X\n"}),

    # ── write_file / append_file / mkdir ─────────────────────────────────
    ("write_new_nested", {}, "write_file",
     {"path": "src/nuevo/a.py", "content": "print('hola')\n"}),
    ("write_overwrite", {"a.txt": "viejo\n"}, "write_file",
     {"path": "a.txt", "content": "nuevo\n"}),
    ("write_unicode", {}, "write_file",
     {"path": "ñandú/é.txt", "content": "canción 🎵\n"}),
    ("write_empty", {}, "write_file", {"path": "vacio.txt", "content": ""}),
    ("write_outside", {}, "write_file", {"path": "../fuera.txt", "content": "x"}),
    ("append_existing", {"a.txt": "uno\n"}, "append_file",
     {"path": "a.txt", "content": "dos\n"}),
    ("append_creates_dirs_and_file", {}, "append_file",
     {"path": "logs/app.log", "content": "inicio\n"}),
    ("append_outside", {}, "append_file", {"path": "../fuera.txt", "content": "x"}),
    ("mkdir_nested", {}, "mkdir", {"path": "a/b/c"}),
    ("mkdir_existing", {"a/x.txt": "x"}, "mkdir", {"path": "a"}),
    ("mkdir_outside", {}, "mkdir", {"path": "../fuera"}),

    # ── delete_file / rename_file ────────────────────────────────────────
    ("delete_file", {"a.txt": "x", "b.txt": "y"}, "delete_file", {"path": "a.txt"}),
    ("delete_directory_recursive", {"d/x.txt": "x", "d/e/y.txt": "y", "z.txt": "z"}, "delete_file",
     {"path": "d"}),
    ("delete_missing", {"a.txt": "x"}, "delete_file", {"path": "nada.txt"}),
    ("delete_outside", {}, "delete_file", {"path": "../fuera.txt"}),
    ("rename_file", {"a.txt": "x"}, "rename_file", {"src": "a.txt", "dst": "b.txt"}),
    ("rename_into_new_dir", {"a.txt": "x"}, "rename_file", {"src": "a.txt", "dst": "n/m/b.txt"}),
    ("rename_directory", {"d/x.txt": "x"}, "rename_file", {"src": "d", "dst": "e"}),
    ("rename_destination_exists", {"a.txt": "x", "b.txt": "y"}, "rename_file",
     {"src": "a.txt", "dst": "b.txt"}),
    ("rename_missing_source", {}, "rename_file", {"src": "nada.txt", "dst": "b.txt"}),
    ("rename_outside_destination", {"a.txt": "x"}, "rename_file",
     {"src": "a.txt", "dst": "../fuera.txt"}),
]

POSIX_NEWLINE_TOOLS = {"write_file", "append_file"}
SLASH_MESSAGE_TOOLS = {"write_file", "append_file", "mkdir"}


def spec(data: bytes) -> dict:
    try:
        text = data.decode("utf-8")
        if "\r" not in text:
            return {"text": text}
    except UnicodeDecodeError:
        pass
    return {"b64": base64.b64encode(data).decode("ascii")}


def to_bytes(value) -> bytes:
    return value if isinstance(value, bytes) else value.encode("utf-8")


def snapshot(root: Path) -> dict:
    files = {p.relative_to(root).as_posix(): spec(p.read_bytes())
             for p in sorted(root.rglob("*")) if p.is_file()}
    dirs = sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_dir())
    return {"files": files, "dirs": dirs}


def run_case(files: dict, tool: str, args: dict) -> dict:
    with tempfile.TemporaryDirectory(prefix="lxe") as tmp:
        ws = Path(tmp).resolve()
        for rel, data in files.items():
            path = ws / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(to_bytes(data))
        try:
            output = agent.execute_tool_call(ws, tool, args)
        except Exception as exc:
            output = f"[ERROR] {exc}"
        after = snapshot(ws)
    if tool in SLASH_MESSAGE_TOOLS:
        output = output.replace("\\", "/")
    if tool in POSIX_NEWLINE_TOOLS:
        for rel, entry in after["files"].items():
            data = base64.b64decode(entry["b64"]) if "b64" in entry else entry["text"].encode("utf-8")
            after["files"][rel] = spec(data.replace(b"\r\n", b"\n"))
    return {"output": output, "after": after}


def build() -> dict:
    cases = []
    for name, files, tool, args in CASES:
        initial = {rel: spec(to_bytes(data)) for rel, data in files.items()}
        if tool in POSIX_NEWLINE_TOOLS:
            assert not any(b"\r" in to_bytes(d) for d in files.values()), name
            assert "\r" not in json.dumps(args), name
        cases.append({"name": name, "files": initial, "tool": tool, "args": args,
                      **run_case(files, tool, args)})
    return {"version": 1, "oracle": "apps/cli/lixbon_cli/agent.py::execute_tool_call", "cases": cases}


def render() -> str:
    return json.dumps(build(), ensure_ascii=False, indent=1) + "\n"


def main() -> int:
    text = render()
    if "--check" in sys.argv:
        current = CORPUS.read_text(encoding="utf-8") if CORPUS.exists() else ""
        if current != text:
            print("edit_corpus.json desactualizado: ejecuta gen_edit_corpus.py", file=sys.stderr)
            return 1
        return 0
    CORPUS.write_text(text, encoding="utf-8", newline="\n")
    print(f"{len(CASES)} casos escritos en {CORPUS}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
