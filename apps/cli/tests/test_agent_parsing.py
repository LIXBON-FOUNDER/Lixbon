"""Parseo de tool calls del modo agent, con las salidas que producen de verdad
los modelos chicos (qwen2.5-coder:7b y compañía).

El caso 1 es una regresión real: el modelo escribía el `content` entre comillas
simples, json.loads fallaba y la llamada se descartaba en silencio, así que el
agente creaba carpetas y ejecutaba comandos pero NUNCA escribía archivos.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lixbon_cli.agent import (  # noqa: E402
    TOOL_SCHEMAS,
    clean_prose,
    extract_all_tool_calls,
    has_unclosed_call,
    native_call_to_internal,
    sanitize_for_plain_chat,
)


def test_python_style_quotes():
    raw = (
        '{"name": "mkdir", "arguments": {"path": "demo"}}\n'
        '{"name": "write_file", "arguments": {"path": "demo/package.json", '
        '"content": \'{"name": "demo"}\'}}\n'
        '{"name": "write_file", "arguments": {"path": "demo/index.js", '
        '"content": \'console.log("hola");\'}}\n'
        '{"name": "run_command", "arguments": {"command": "cd demo && node index.js"}}'
    )
    calls = extract_all_tool_calls(raw)
    assert [c["tool"] for c in calls] == ["mkdir", "write_file", "write_file", "run_command"]
    assert calls[1]["args"]["content"] == '{"name": "demo"}'
    assert calls[2]["args"]["content"] == 'console.log("hola");'


def test_escapes_inside_single_quotes_are_kept():
    raw = '{"name":"write_file","arguments":{"path":"a.py","content":\'print("hola")\\nprint(2)\\n\'}}'
    assert extract_all_tool_calls(raw)[0]["args"]["content"] == 'print("hola")\nprint(2)\n'


def test_real_newlines_inside_single_quotes():
    raw = '{"name":"write_file","arguments":{"path":"a.txt","content":\'linea1\nlinea2\'}}'
    assert extract_all_tool_calls(raw)[0]["args"]["content"] == "linea1\nlinea2"


def test_classic_format_still_works():
    raw = ('{"tool":"edit_file","args":{"path":"a.js","old_text":"const x = 1;",'
           '"new_text":"const total = 1;"}}')
    assert extract_all_tool_calls(raw) == [{
        "tool": "edit_file",
        "args": {"path": "a.js", "old_text": "const x = 1;", "new_text": "const total = 1;"},
    }]


def test_apostrophe_inside_double_quoted_string():
    raw = '{"tool":"write_file","args":{"path":"a.txt","content":"don\'t {stop} now"}}'
    assert extract_all_tool_calls(raw)[0]["args"]["content"] == "don't {stop} now"


def test_unclosed_call_is_detected_and_hidden():
    raw = 'Voy a crearlo.\n{"tool":"write_file","args":{"path":"a.txt","content":"hola'
    assert has_unclosed_call(raw)
    assert clean_prose(raw) == "Voy a crearlo."


def test_prose_around_calls_survives():
    raw = 'Creo el archivo.\n{"name":"mkdir","arguments":{"path":"src"}}\nListo.'
    assert [c["tool"] for c in extract_all_tool_calls(raw)] == ["mkdir"]
    assert clean_prose(raw) == "Creo el archivo.\n\nListo."


def test_native_call_conversion():
    # OpenAI manda arguments como string; Ollama como objeto: los dos valen.
    as_string = {"id": "c1", "function": {"name": "mkdir", "arguments": '{"path": "src"}'}}
    as_object = {"id": "c2", "function": {"name": "mkdir", "arguments": {"path": "src"}}}
    assert native_call_to_internal(as_string) == {"tool": "mkdir", "args": {"path": "src"}}
    assert native_call_to_internal(as_object) == {"tool": "mkdir", "args": {"path": "src"}}


def test_tool_schemas_match_executor():
    from lixbon_cli.agent import TOOL_SPECS

    assert {t["function"]["name"] for t in TOOL_SCHEMAS} == {name for name, _, _ in TOOL_SPECS}


def test_sanitize_drops_tool_roundtrip():
    history = [
        {"role": "user", "content": "crea a.txt"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "c1"}]},
        {"role": "tool", "content": "Archivo creado", "tool_call_id": "c1", "name": "write_file"},
        {"role": "assistant", "content": "Listo."},
    ]
    plain = sanitize_for_plain_chat(history)
    assert [m["role"] for m in plain] == ["user", "assistant"]
    assert all("tool_calls" not in m for m in plain)
