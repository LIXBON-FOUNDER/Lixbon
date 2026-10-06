"""Regenera el catálogo de herramientas y el corpus de parsing de tool-calls.

Salidas (oráculo: lixbon_cli.agent):
  go/internal/toolspec/catalog.json     esquemas y conjuntos de herramientas (embebido en Go)
  validation/fixtures/tool_parse_corpus.json   texto del modelo -> llamadas extraídas

    python apps/cli/validation/gen_tool_corpus.py          # reescribe
    python apps/cli/validation/gen_tool_corpus.py --check  # falla si está desactualizado
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from lixbon_cli import agent, documents  # noqa: E402

CATALOG = HERE.parent / "go" / "internal" / "toolspec" / "catalog.json"
CORPUS = HERE / "fixtures" / "tool_parse_corpus.json"

LONG_CSS = "body { color: red; font-family: \"Helvetica\"; }"

TEXT_CASES: list[tuple[str, str, str]] = [
    ("classic_format", "Formato {tool,args}.",
     '{"tool":"edit_file","args":{"path":"a.js","old_text":"const x = 1;","new_text":"const total = 1;"}}'),
    ("openai_name_arguments", "Formato {name,arguments} con arguments objeto.",
     '{"name":"mkdir","arguments":{"path":"src"}}'),
    ("openai_arguments_as_string", "arguments como string JSON.",
     '{"name":"mkdir","arguments":"{\\"path\\": \\"src\\"}"}'),
    ("arguments_string_not_object", "arguments string que no es un objeto: args vacío.",
     '{"name":"mkdir","arguments":"[1,2]"}'),
    ("arguments_string_invalid", "arguments string inválido: args vacío.",
     '{"name":"mkdir","arguments":"{no json"}'),
    ("name_without_arguments", "{name} sin arguments no es una llamada, pero cuenta como intento roto.",
     '{"name":"mkdir"}'),
    ("name_with_null_arguments", "arguments null no es una llamada.",
     '{"name":"mkdir","arguments":null}'),
    ("tool_args_not_object", "args que no es objeto: se normaliza a {}.",
     '{"tool":"list_files","args":"."}'),
    ("tool_without_args", "tool sin args.",
     '{"tool":"list_files"}'),
    ("empty_tool_name", "tool vacío no es llamada.",
     '{"tool":"","args":{}}'),
    ("python_style_quotes", "Comillas simples estilo Python en content.",
     '{"name": "mkdir", "arguments": {"path": "demo"}}\n'
     '{"name": "write_file", "arguments": {"path": "demo/package.json", "content": \'{"name": "demo"}\'}}\n'
     '{"name": "write_file", "arguments": {"path": "demo/index.js", "content": \'console.log("hola");\'}}\n'
     '{"name": "run_command", "arguments": {"command": "cd demo && node index.js"}}'),
    ("single_quote_escapes_kept", "Escapes dentro de comillas simples se conservan.",
     '{"name":"write_file","arguments":{"path":"a.py","content":\'print("hola")\\nprint(2)\\n\'}}'),
    ("single_quote_escaped_apostrophe", "Apóstrofo escapado dentro de comillas simples.",
     '{"name":"write_file","arguments":{"path":"a.txt","content":\'it\\\'s ok\'}}'),
    ("real_newlines_single_quotes", "Saltos de línea reales dentro de comillas simples.",
     '{"name":"write_file","arguments":{"path":"a.txt","content":\'linea1\nlinea2\'}}'),
    ("real_newlines_double_quotes", "Saltos de línea reales dentro de comillas dobles (strict=False).",
     '{"tool":"write_file","args":{"path":"a.txt","content":"linea1\nlinea2\ttab"}}'),
    ("real_newlines_generic_path", "Salto real en comillas dobles en formato {name,arguments} (ruta genérica, strict=False).",
     '{"name":"write_file","arguments":{"path":"a.txt","content":"l1\nl2\tx"}}'),
    ("real_newlines_multi_edit", "Salto real dentro de multi_edit (ruta genérica).",
     '{"tool":"multi_edit","args":{"path":"a.py","edits":[{"old_text":"a\nb","new_text":"c"}]}}'),
    ("apostrophe_in_double_quotes", "Apóstrofo y llaves dentro de string con comillas dobles.",
     '{"tool":"write_file","args":{"path":"a.txt","content":"don\'t {stop} now"}}'),
    ("indented_json", "JSON indentado en varias líneas.",
     '{\n  "tool": "read_file",\n  "args": {\n    "path": "a.py",\n    "start_line": 3\n  }\n}'),
    ("nbsp_whitespace", "Espacio no separable entre llave y clave.",
     '{ "tool":"mkdir","args":{"path":"x"}}'),
    ("repair_unescaped_quotes", "Comillas sin escapar dentro de un content largo: reparación por esquema.",
     '{"tool":"write_file","args":{"path":"a.css","content":"' + LONG_CSS + '"}}'),
    ("repair_with_numbers_and_bool", "Reparación campo a campo con primitivos.",
     '{"tool":"read_file","args":{"path":"a.py","start_line":2,"end_line":9.5}}'),
    ("repair_edit_with_flag", "Reparación con comillas sin escapar y flag booleano.",
     '{"tool":"edit_file","args":{"path":"a.html","old_text":"<a href="x">","new_text":"<a href="y">","all":true}}'),
    ("repair_unescape_sequences", "La reparación desescapa \\n, \\t, \\\" y \\\\.",
     '{"tool":"write_file","args":{"path":"a.txt","content":"l1\\nl2\\t\\"q\\" \\\\ fin"}}'),
    ("multi_edit_generic_path", "multi_edit (edits anidado) cae al escaneo genérico.",
     '{"tool":"multi_edit","args":{"path":"a.py","edits":[{"old_text":"a","new_text":"b"},{"old_text":"c","new_text":"d"}]}}'),
    ("todo_nested", "todo con lista anidada.",
     '{"tool":"todo","args":{"items":[{"text":"uno","status":"done"},{"text":"dos","status":"pending"}]}}'),
    ("unknown_tool_is_still_a_call", "Una herramienta desconocida se extrae igual.",
     '{"tool":"inventada","args":{"x":1}}'),
    ("prose_around_calls", "La prosa alrededor sobrevive.",
     'Creo el archivo.\n{"name":"mkdir","arguments":{"path":"src"}}\nListo.'),
    ("two_calls_with_prose", "Dos llamadas con prosa entre medias.",
     'Primero.\n{"tool":"mkdir","args":{"path":"a"}}\nLuego.\n{"tool":"mkdir","args":{"path":"b"}}\nFin.'),
    ("unclosed_call_at_end", "Llamada sin cerrar al final (salida truncada).",
     'Voy a crearlo.\n{"tool":"write_file","args":{"path":"a.txt","content":"hola'),
    ("unclosed_after_complete", "Una completa y otra sin cerrar.",
     '{"tool":"mkdir","args":{"path":"a"}}\ntexto\n{"tool":"write_file","args":{"path":"b","content":"x'),
    ("broken_json_closed", "Objeto cerrado pero con JSON roto: intento inválido.",
     '{"tool":"mkdir","args":{path: src}}'),
    ("broken_then_valid", "Intento roto seguido de una llamada válida.",
     '{"tool":"x","args":{bad}}\n{"tool":"mkdir","args":{"path":"ok"}}'),
    ("fabricated_tool_result", "El modelo fabrica un TOOL_RESULT: lo posterior se descarta.",
     'Hecho.\nTOOL_RESULT write_file: ok\nTodo listo, he terminado.'),
    ("tool_result_inline", "TOOL_RESULT sin salto de línea previo.",
     'texto TOOL_RESULT inventado'),
    ("empty_fences", "Vallas de código vacías tras quitar la llamada.",
     'Ahí va:\n```json\n{"tool":"mkdir","args":{"path":"a"}}\n```\nListo.'),
    ("fence_with_language_unicode", "Valla vacía con lenguaje con acento.",
     '```ñandú\n```\nresto'),
    ("unicode_content", "Contenido con acentos y emoji.",
     '{"tool":"write_file","args":{"path":"é.txt","content":"canción 🎵 日本"}}'),
    ("no_calls", "Texto sin llamadas.", "Solo prosa, sin herramientas."),
    ("empty_text", "Texto vacío.", ""),
    ("braces_in_prose", "Llaves en prosa que no son llamadas.",
     'Usa {x: 1} o {"a": 1} en tu código.'),
    ("prose_whitespace_only_after_strip", "Solo una llamada: la prosa queda vacía.",
     '  \n{"tool":"mkdir","args":{"path":"a"}}\n  '),
]

NATIVE_CASES: list[tuple[str, dict]] = [
    ("arguments_string", {"id": "c1", "function": {"name": "mkdir", "arguments": '{"path": "src"}'}}),
    ("arguments_object", {"id": "c2", "function": {"name": "mkdir", "arguments": {"path": "src"}}}),
    ("arguments_empty_string", {"function": {"name": "list_files", "arguments": ""}}),
    ("arguments_invalid_string", {"function": {"name": "list_files", "arguments": "{no"}}),
    ("arguments_array", {"function": {"name": "list_files", "arguments": [1]}}),
    ("arguments_missing", {"function": {"name": "list_files"}}),
    ("no_function", {"id": "c3"}),
    ("function_null", {"function": None}),
    ("arguments_string_not_object", {"function": {"name": "x", "arguments": "[1]"}}),
]


HTML_CASES: list[tuple[str, str]] = [
    ("plain_paragraphs", "<p>Uno</p><p>Dos</p>"),
    ("script_and_style_removed", "<style>a{}</style><p>Hola</p><script>alert('x')</script>fin"),
    ("noscript_and_svg_removed", "<noscript>no</noscript><svg><path d='x'/></svg>texto"),
    ("script_case_insensitive_multiline", "<SCRIPT type='x'>\nvar a;\n</Script>visible"),
    ("block_tags_become_newlines", "<div>a</div><br><li>b</li><tr>c</tr><h2>d</h2>"),
    ("inline_tags_become_spaces", "<b>negrita</b><i>cursiva</i>"),
    ("entities", "&amp; &lt;b&gt; &eacute; &#233; &#x1F600; &copy &quot;q&quot;"),
    ("numeric_entity_cp1252", "&#x80; &#150;"),
    ("whitespace_collapsed", "a \t\t  b   \n   c"),
    ("many_blank_lines", "<p>a</p>\n\n\n\n<p>b</p>"),
    ("nbsp_survives_inline_collapse", "a&nbsp;&nbsp;b"),
    ("comment_without_gt", "antes<!-- nota -->después"),
    ("attributes_with_gt_in_quotes", "<a title=\"a>b\">link</a>"),
    ("empty", ""),
    ("only_tags", "<div><span></span></div>"),
    ("unicode_text", "<p>canción 🎵 日本</p>"),
]


def parse_text(text: str) -> dict:
    return {
        "extract_all": agent.extract_all_tool_calls(text),
        "has_invalid_call": agent.has_invalid_call(text),
        "strip": agent.strip_tool_calls(text),
        "truncate_fabricated": agent.truncate_fabricated(text),
        "cut_unclosed": agent.cut_unclosed_call(text),
        "has_unclosed": agent.has_unclosed_call(text),
        "clean_prose": agent.clean_prose(text),
    }


def build_catalog() -> dict:
    return {
        "version": 1,
        "oracle": "apps/cli/lixbon_cli/agent.py",
        "schemas": agent.TOOL_SCHEMAS,
        "specs": [{"name": n, "args": a, "description": d} for n, a, d in agent.TOOL_SPECS],
        "read_only": sorted(agent.READ_ONLY_TOOLS),
        "mutating": sorted(agent.MUTATING_TOOLS),
        "edit": sorted(agent.EDIT_TOOLS),
        "arg_keys": {k: list(v) for k, v in agent._TOOL_ARG_KEYS.items()},
    }


def build_corpus() -> dict:
    return {
        "version": 1,
        "oracle": "apps/cli/lixbon_cli/agent.py",
        "text_cases": [
            {"name": name, "description": desc, "text": text, **parse_text(text)}
            for name, desc, text in TEXT_CASES
        ],
        "html_cases": [
            {"name": name, "html": page, "text": documents.html_to_text(page)}
            for name, page in HTML_CASES
        ],
        "native_cases": [
            {"name": name, "call": call, "expected": agent.native_call_to_internal(call)}
            for name, call in NATIVE_CASES
        ],
    }


def render(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def main() -> int:
    outputs = {CATALOG: render(build_catalog()), CORPUS: render(build_corpus())}
    if "--check" in sys.argv:
        stale = [p.name for p, text in outputs.items()
                 if not p.exists() or p.read_text(encoding="utf-8") != text]
        if stale:
            print(f"desactualizado: {', '.join(stale)} — ejecuta gen_tool_corpus.py", file=sys.stderr)
            return 1
        return 0
    for path, text in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
        print(f"escrito {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
