"""Regenera fixtures/sse_corpus.json usando lixbon_cli.sse como oráculo.

Cada caso es un stream SSE crudo (bytes) y los eventos tipados que produce la
implementación Python. Las implementaciones portadas (Go) consumen el JSON sin
depender de este script.

    python apps/cli/validation/gen_sse_corpus.py          # reescribe el corpus
    python apps/cli/validation/gen_sse_corpus.py --check  # falla si está desactualizado
"""
import base64
import io
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from lixbon_cli.sse import events_from_stream  # noqa: E402

CORPUS = HERE / "fixtures" / "sse_corpus.json"


def data(obj) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


def delta(**fields) -> str:
    return data({"choices": [{"delta": fields}]})


def content(text: str) -> str:
    return delta(content=text)


CASES: list[tuple[str, str, str | bytes]] = [
    ("content_basic", "Dos deltas de contenido y cierre con [DONE].",
     content("Hola") + content(" mundo") + "data: [DONE]\n\n"),
    ("reasoning_then_content", "reasoning_content va antes del content.",
     delta(reasoning_content="pienso") + content("respondo") + "data: [DONE]\n\n"),
    ("same_chunk_order", "En un mismo chunk: reasoning, tool_calls, content y usage en ese orden.",
     data({"choices": [{"delta": {
         "content": "texto", "tool_calls": [{"function": {"name": "read_file"}}],
         "reasoning_content": "r"}}], "usage": {"total_tokens": 7}}) + "data: [DONE]\n\n"),
    ("think_tags_inline", "<think>…</think> dentro del content se reclasifica como reasoning.",
     content("<think>razono</think>respuesta") + "data: [DONE]\n\n"),
    ("think_tag_split_open", "La etiqueta de apertura llega partida entre chunks.",
     content("antes <th") + content("ink>dentro</think>fin") + "data: [DONE]\n\n"),
    ("think_tag_split_close", "La etiqueta de cierre llega partida entre chunks.",
     content("<think>dentro</th") + content("ink>fuera") + "data: [DONE]\n\n"),
    ("think_tag_split_last_char", "Ambas etiquetas llegan completas salvo el último carácter '>'.",
     content("<think") + content(">razono</think") + content(">fin") + "data: [DONE]\n\n"),
    ("think_unclosed_flush", "Un <think> sin cerrar se vacía como reasoning al terminar el stream.",
     content("<think>sin cierre") + "data: [DONE]\n\n"),
    ("partial_tag_lookalike", "Un '<' final retenido se libera en el flush como content.",
     content("a <") + "data: [DONE]\n\n"),
    ("sources_first", "lixbon_sources se emite como sources y el chunk no se procesa más.",
     data({"lixbon_sources": [{"url": "https://a.test", "title": "A"}],
           "usage": {"total_tokens": 1}}) + content("ok") + "data: [DONE]\n\n"),
    ("tool_calls_native", "tool_calls completos en un chunk (Ollama).",
     delta(tool_calls=[{"id": "c1", "function": {"name": "list_dir", "arguments": {"path": "."}}}])
     + "data: [DONE]\n\n"),
    ("usage_last_chunk", "usage llega en el último chunk, sin choices.",
     content("fin") + data({"usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}})
     + "data: [DONE]\n\n"),
    ("keepalive_comments", "Los comentarios ':' (keepalive) y líneas en blanco se ignoran.",
     ": keepalive\n\n" + content("a") + ": ping\n\n" + "\n\n" + content("b") + "data: [DONE]\n\n"),
    ("crlf_endings", "Terminadores CRLF.",
     (content("uno") + content("dos") + "data: [DONE]\n\n").replace("\n", "\r\n")),
    ("no_done_eof", "El stream termina sin [DONE]: igualmente se emite done.",
     content("sin done")),
    ("last_line_without_newline", "La última línea data no termina en salto de línea.",
     'data: {"choices":[{"delta":{"content":"cola"}}]}'),
    ("done_stops_following_data", "Lo que venga después de [DONE] se descarta.",
     content("antes") + "data: [DONE]\n\n" + content("despues")),
    ("malformed_json_skipped", "Un payload JSON inválido se ignora sin cortar el stream.",
     content("a") + "data: {no es json}\n\n" + "data:\n\n" + content("b") + "data: [DONE]\n\n"),
    ("unknown_fields_ignored", "Campos desconocidos no alteran los eventos.",
     data({"id": "x", "object": "chunk", "nuevo": {"a": 1},
           "choices": [{"index": 0, "finish_reason": None,
                        "delta": {"role": "assistant", "content": "ok", "extra": 1}}]})
     + "data: [DONE]\n\n"),
    ("non_data_fields_ignored", "event:, id: y retry: no son data y se ignoran.",
     "event: message\nid: 7\nretry: 100\n" + content("x") + "data: [DONE]\n\n"),
    ("data_without_space", "data: sin espacio tras los dos puntos.",
     'data:{"choices":[{"delta":{"content":"pegado"}}]}\n\ndata:[DONE]\n\n'),
    ("empty_values_skipped", "content/reasoning vacíos, delta nulo y choices vacío no emiten nada.",
     delta(content="") + delta(reasoning_content="") + data({"choices": [{"delta": None}]})
     + data({"choices": []}) + data({"usage": {}}) + content("ok") + "data: [DONE]\n\n"),
    ("utf8_multibyte", "Texto multibyte (acentos, emoji, CJK) intacto.",
     content("canción 🎵 漢字") + "data: [DONE]\n\n"),
    ("invalid_utf8_single_byte", "Un byte inválido en el JSON se sustituye por U+FFFD.",
     b'data: {"choices":[{"delta":{"content":"a\xffb"}}]}\n\ndata: [DONE]\n\n'),
    ("invalid_utf8_truncated_sequence", "Una secuencia truncada se sustituye por un único U+FFFD.",
     b'data: {"choices":[{"delta":{"content":"a\xe2\x82b"}}]}\n\ndata: [DONE]\n\n'),
    ("empty_stream", "Stream vacío: solo done.", ""),
]


def build() -> dict:
    cases = []
    for name, description, stream in CASES:
        raw = stream if isinstance(stream, bytes) else stream.encode("utf-8")
        events = [[kind, value] for kind, value in events_from_stream(io.BytesIO(raw))]
        case = {"name": name, "description": description}
        try:
            case["stream"] = raw.decode("utf-8")
        except UnicodeDecodeError:
            case["stream_b64"] = base64.b64encode(raw).decode("ascii")
        case["events"] = events
        cases.append(case)
    return {"version": 1, "oracle": "apps/cli/lixbon_cli/sse.py::events_from_stream", "cases": cases}


def render() -> str:
    return json.dumps(build(), ensure_ascii=False, indent=2) + "\n"


def main() -> int:
    text = render()
    if "--check" in sys.argv:
        current = CORPUS.read_text(encoding="utf-8") if CORPUS.exists() else ""
        if current != text:
            print("sse_corpus.json desactualizado: ejecuta gen_sse_corpus.py", file=sys.stderr)
            return 1
        return 0
    CORPUS.write_text(text, encoding="utf-8", newline="\n")
    print(f"{len(CASES)} casos escritos en {CORPUS}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
