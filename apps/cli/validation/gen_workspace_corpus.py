"""Corpus dorado de las herramientas de solo lectura del agente.

Construye un workspace sintético, ejecuta las herramientas Python y guarda la
salida. Las implementaciones portadas (Go) reconstruyen el mismo árbol desde
fixtures/workspace_corpus.json y comparan.

La búsqueda se genera con el recorrido Python (sin ripgrep): es el camino
portable y su orden no está definido, así que esos casos se comparan sin orden.

    python apps/cli/validation/gen_workspace_corpus.py          # reescribe
    python apps/cli/validation/gen_workspace_corpus.py --check  # falla si cambió
"""
import base64
import hashlib
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from lixbon_cli import agent  # noqa: E402

CORPUS = HERE / "fixtures" / "workspace_corpus.json"
INLINE_LIMIT = 4000

PY_SOURCE = '''import os


class Servicio:
    """Docstring."""

    def metodo(self, x):
        return x

    async def asincrono(self):
        pass


def principal():
    return 1


async def tarea():
    pass


def función_ñ():
    return "é"


x = 1  # def no_es_definicion():
'''

JS_SOURCE = '''export default class App {
  render() {
    return 1;
  }
  static async crear() {
    return new App();
  }
}

export const sumar = (a, b) => a + b;
const doble = async (x) => x * 2;
function* generador() {}
export async function cargar() {}
let valor = 3;
'''

JAVA_SOURCE = '''package demo;

public class Servicio {
    private int campo;

    public static void main(String[] args) {
    }

    protected String nombre() throws Exception {
        return "x";
    }
}

interface Contrato {}
'''

RS_SOURCE = '''pub struct Punto { x: i32 }

impl Punto {
    pub fn nuevo() -> Self { Punto { x: 0 } }
    fn privada(&self) {}
}

pub(crate) async fn tarea() {}
enum Estado { A, B }
mod interno {}
'''

GO_SOURCE = '''package main

type Servidor struct{}

func (s *Servidor) Iniciar() {}

func main() {}
'''

CSS_SOURCE = '''body {
  color: red;
}

.tarjeta > .titulo {
  margin: 0;
}

@media (max-width: 600px) {
  .tarjeta {
    display: none;
  }
}
'''

MD_SOURCE = '''# Título

Texto.

## Sección uno

### Sub sección

####### no es encabezado
#sin-espacio
'''

FILES: dict[str, dict] = {
    "README.md": {"text": "# demo\n"},
    "src/app.py": {"text": PY_SOURCE},
    "src/util.js": {"text": JS_SOURCE},
    "src/Servicio.java": {"text": JAVA_SOURCE},
    "src/lib.rs": {"text": RS_SOURCE},
    "src/main.go": {"text": GO_SOURCE},
    "src/estilo.css": {"text": CSS_SOURCE},
    "src/sep.py": {"text": "def a(): def b():\x0cdef c():\n"},
    "src/notas.txt": {"text": "Total de notas: 3\nTOTAL en mayúsculas\n"},
    "src/solo_comentarios.py": {"text": "# nada\n# que ver\n"},
    "docs/guide.md": {"text": MD_SOURCE},
    "crlf.txt": {"b64": base64.b64encode(b"uno\r\ndos\r\ntres").decode()},
    "cr.txt": {"b64": base64.b64encode(b"uno\rdos\rtres\n").decode()},
    "bom.txt": {"b64": base64.b64encode("﻿hola\n".encode()).decode()},
    "invalido.txt": {"b64": base64.b64encode(b"ok \xff\xfe fin\nlinea \xe2\x82 corta\n").decode()},
    "separadores.txt": {"text": "a b\x0bc\x1dd\x85e\n"},
    "vacio.txt": {"text": ""},
    "binario.dat": {"b64": base64.b64encode(b"abc\x00def").decode()},
    "imagen.png": {"b64": base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 3000).decode()},
    "grande.txt": {"gen": {"template": "línea número {i}\n", "count": 20000}},
    "medio.txt": {"gen": {"template": "fila {i}\n", "count": 40}},
    "muchos/f{i}.txt": {"gen": {"each": True, "text": "x\n", "count": 305}},
    "ñandú/é.txt": {"text": "contenido con total\n"},
    "con espacios/a b.txt": {"text": "total con espacios\n"},
    ".hidden/oculto.txt": {"text": "total oculto\n"},
    ".env.example": {"text": "TOTAL=1\n"},
    "node_modules/x/index.js": {"text": "total\n"},
    ".git/config": {"text": "total\n"},
    "dist/out.js": {"text": "total\n"},
    "__pycache__/m.pyc": {"text": "total\n"},
    "prof/a/b/c/d/e/f/g/h.txt": {"text": "total profundo\n"},
}
EMPTY_DIRS = ["vacia", "src/subvacia"]


def materialize(root: Path, files: dict, empty_dirs: list[str]) -> None:
    for rel, spec in files.items():
        if "gen" in spec and spec["gen"].get("each"):
            for i in range(1, spec["gen"]["count"] + 1):
                path = root / rel.replace("{i}", f"{i:03d}")
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(spec["gen"]["text"], encoding="utf-8", newline="")
            continue
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if "text" in spec:
            path.write_bytes(spec["text"].encode("utf-8"))
        elif "b64" in spec:
            path.write_bytes(base64.b64decode(spec["b64"]))
        else:
            gen = spec["gen"]
            path.write_bytes("".join(gen["template"].format(i=i)
                                     for i in range(1, gen["count"] + 1)).encode("utf-8"))
    for rel in empty_dirs:
        (root / rel).mkdir(parents=True, exist_ok=True)


# (nombre, herramienta, args, sin_orden)
CASES: list[tuple[str, str, dict, bool]] = [
    ("list_root", "list_files", {}, False),
    ("list_explicit_dot", "list_files", {"path": "."}, False),
    ("list_empty_path", "list_files", {"path": ""}, False),
    ("list_root_recursive", "list_files", {"path": ".", "recursive": True}, False),
    ("list_src", "list_files", {"path": "src"}, False),
    ("list_file", "list_files", {"path": "src/app.py"}, False),
    ("list_missing", "list_files", {"path": "nada"}, False),
    ("list_empty_dir", "list_files", {"path": "vacia"}, False),
    ("list_many_capped", "list_files", {"path": "muchos"}, False),
    ("list_depth_limit", "list_files", {"path": "prof", "recursive": True}, False),
    ("list_unicode_dir", "list_files", {"path": "ñandú"}, False),
    ("list_spaces_dir", "list_files", {"path": "con espacios"}, False),
    ("list_ignored_dir_direct", "list_files", {"path": "node_modules"}, False),
    ("list_outside", "list_files", {"path": "../fuera"}, False),
    ("list_recursive_flag_truthy", "list_files", {"path": "src", "recursive": 1}, False),

    ("find_by_name", "find_files", {"pattern": "*.py"}, False),
    ("find_js_skips_ignored", "find_files", {"pattern": "*.js"}, False),
    ("find_with_dir", "find_files", {"pattern": "src/*.js"}, False),
    ("find_double_star", "find_files", {"pattern": "src/**/*.go"}, False),
    ("find_md_anywhere", "find_files", {"pattern": "**/*.md"}, False),
    ("find_exact_name", "find_files", {"pattern": "README.md"}, False),
    ("find_none", "find_files", {"pattern": "*.xyz"}, False),
    ("find_empty", "find_files", {"pattern": ""}, False),
    ("find_blank", "find_files", {"pattern": "   "}, False),
    ("find_everything_in_src", "find_files", {"pattern": "src/*"}, False),
    ("find_in_unicode_dir", "find_files", {"pattern": "ñandú/*"}, False),
    ("find_in_spaces_dir", "find_files", {"pattern": "con espacios/*"}, False),
    ("find_backslash_pattern", "find_files", {"pattern": "src\\*.rs"}, False),
    ("find_question_mark", "find_files", {"pattern": "READM?.md"}, False),
    ("find_char_class", "find_files", {"pattern": "[ac]*.txt"}, False),
    ("find_hidden", "find_files", {"pattern": ".env*"}, False),

    ("read_small", "read_file", {"path": "README.md"}, False),
    ("read_range", "read_file", {"path": "medio.txt", "start_line": 3, "end_line": 5}, False),
    ("read_start_only", "read_file", {"path": "medio.txt", "start_line": 38}, False),
    ("read_end_only", "read_file", {"path": "medio.txt", "end_line": 2}, False),
    ("read_start_after_end", "read_file", {"path": "medio.txt", "start_line": 9, "end_line": 4}, False),
    ("read_start_beyond_file", "read_file", {"path": "medio.txt", "start_line": 500}, False),
    ("read_end_beyond_file", "read_file", {"path": "medio.txt", "start_line": 39, "end_line": 500}, False),
    ("read_range_string_numbers", "read_file", {"path": "medio.txt", "start_line": "2", "end_line": "3"}, False),
    ("read_crlf", "read_file", {"path": "crlf.txt"}, False),
    ("read_cr_only", "read_file", {"path": "cr.txt"}, False),
    ("read_bom", "read_file", {"path": "bom.txt"}, False),
    ("read_invalid_utf8", "read_file", {"path": "invalido.txt"}, False),
    ("read_empty", "read_file", {"path": "vacio.txt"}, False),
    ("read_empty_range", "read_file", {"path": "vacio.txt", "start_line": 1}, False),
    ("read_binary", "read_file", {"path": "binario.dat"}, False),
    ("read_image", "read_file", {"path": "imagen.png"}, False),
    ("read_big_truncated", "read_file", {"path": "grande.txt"}, False),
    ("read_big_with_range", "read_file", {"path": "grande.txt", "start_line": 19999}, False),
    ("read_unicode_path", "read_file", {"path": "ñandú/é.txt"}, False),
    ("read_spaces_path", "read_file", {"path": "con espacios/a b.txt"}, False),
    ("read_missing", "read_file", {"path": "nada.txt"}, False),
    ("read_directory", "read_file", {"path": "src"}, False),
    ("read_outside", "read_file", {"path": "../fuera.txt"}, False),
    ("read_missing_arg", "read_file", {}, False),

    ("outline_python", "outline", {"path": "src/app.py"}, False),
    ("outline_js", "outline", {"path": "src/util.js"}, False),
    ("outline_java", "outline", {"path": "src/Servicio.java"}, False),
    ("outline_rust", "outline", {"path": "src/lib.rs"}, False),
    ("outline_go", "outline", {"path": "src/main.go"}, False),
    ("outline_css", "outline", {"path": "src/estilo.css"}, False),
    ("outline_markdown", "outline", {"path": "docs/guide.md"}, False),
    ("outline_unicode_separators", "outline", {"path": "src/sep.py"}, False),
    ("outline_unsupported_ext", "outline", {"path": "src/notas.txt"}, False),
    ("outline_no_matches", "outline", {"path": "src/solo_comentarios.py"}, False),
    ("outline_empty_file", "outline", {"path": "vacio.txt"}, False),
    ("outline_missing", "outline", {"path": "nada.py"}, False),
    ("outline_directory", "outline", {"path": "src"}, False),

    ("search_literal", "search", {"pattern": "total"}, True),
    ("search_ignore_case", "search", {"pattern": "total", "ignore_case": True}, True),
    ("search_regex", "search", {"pattern": "^def \\w+", "regex": True}, True),
    ("search_literal_not_regex", "search", {"pattern": "def \\w+"}, True),
    ("search_glob", "search", {"pattern": "def", "glob": "*.py"}, True),
    ("search_glob_with_dir", "search", {"pattern": "total", "glob": "src/*", "ignore_case": True}, True),
    ("search_in_dir", "search", {"pattern": "total", "path": "src", "ignore_case": True}, True),
    ("search_in_file", "search", {"pattern": "def", "path": "src/app.py"}, True),
    ("search_no_results", "search", {"pattern": "inexistente_zzz"}, True),
    ("search_missing_pattern", "search", {"pattern": ""}, True),
    ("search_missing_path", "search", {"pattern": "x", "path": "nada"}, True),
    ("search_unicode", "search", {"pattern": "mayúsculas"}, True),
    ("search_unicode_dir", "search", {"pattern": "total", "path": "ñandú"}, True),
    ("search_hidden_included", "search", {"pattern": "oculto"}, True),
    ("search_binary_skipped", "search", {"pattern": "abc"}, True),
    ("search_line_separators", "search", {"pattern": "e", "path": "separadores.txt"}, True),
    ("search_strips_line", "search", {"pattern": "return x", "path": "src/app.py"}, True),
    ("search_outside", "search", {"pattern": "x", "path": ".."}, True),
    ("search_capped", "search", {"pattern": "línea", "path": "grande.txt"}, False),
]


def run_case(ws: Path, tool: str, args: dict) -> str:
    try:
        return agent.execute_tool_call(ws, tool, args)
    except Exception as exc:
        return f"[ERROR] {exc}"


def output_fields(result: str) -> dict:
    if len(result) <= INLINE_LIMIT:
        return {"output": result}
    return {
        "output_len": len(result),
        "output_sha256": hashlib.sha256(result.encode("utf-8")).hexdigest(),
        "output_head": result[:300],
    }


def build() -> dict:
    with tempfile.TemporaryDirectory(prefix="lxb") as tmp:
        ws = Path(tmp).resolve()
        materialize(ws, FILES, EMPTY_DIRS)
        assert not any(part in agent.IGNORED_TREE_DIRS for part in ws.parts), ws

        original_run = agent.subprocess.run

        def no_ripgrep(*_args, **_kwargs):
            raise FileNotFoundError("rg")

        cases = []
        for name, tool, args, unordered in CASES:
            agent.subprocess.run = no_ripgrep if tool == "search" else original_run
            try:
                result = run_case(ws, tool, args)
            finally:
                agent.subprocess.run = original_run
            case = {"name": name, "tool": tool, "args": args}
            if unordered:
                case["unordered"] = True
                result = "\n".join(sorted(result.split("\n")))
            cases.append({**case, **output_fields(result)})
    return {
        "version": 1,
        "oracle": "apps/cli/lixbon_cli/agent.py::execute_tool_call",
        "files": FILES,
        "empty_dirs": EMPTY_DIRS,
        "cases": cases,
    }


def render() -> str:
    return json.dumps(build(), ensure_ascii=False, indent=1) + "\n"


def main() -> int:
    text = render()
    if "--check" in sys.argv:
        current = CORPUS.read_text(encoding="utf-8") if CORPUS.exists() else ""
        if current != text:
            print("workspace_corpus.json desactualizado: ejecuta gen_workspace_corpus.py", file=sys.stderr)
            return 1
        return 0
    CORPUS.write_text(text, encoding="utf-8", newline="\n")
    print(f"{len(CASES)} casos escritos en {CORPUS}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
