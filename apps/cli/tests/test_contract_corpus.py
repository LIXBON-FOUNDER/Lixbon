"""El corpus SSE portable debe coincidir con lo que produce el código Python.

Si falla: se cambió lixbon_cli/sse.py (o el corpus a mano). Regenera con
`python apps/cli/validation/gen_sse_corpus.py` y revisa el diff: cualquier
cambio de eventos es un cambio de contrato que también afecta al CLI Go.
"""
import importlib.util
import sys
from pathlib import Path

CLI_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CLI_DIR))

GENERATOR = CLI_DIR / "validation" / "gen_sse_corpus.py"


def _load_generator():
    spec = importlib.util.spec_from_file_location("gen_sse_corpus", GENERATOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_sse_corpus_matches_python_oracle():
    generator = _load_generator()
    on_disk = generator.CORPUS.read_text(encoding="utf-8")
    assert on_disk == generator.render(), (
        "fixtures/sse_corpus.json no coincide con lixbon_cli/sse.py. "
        "Regenera con: python apps/cli/validation/gen_sse_corpus.py"
    )


def test_sse_corpus_covers_every_event_kind():
    corpus = _load_generator().build()
    kinds = {event[0] for case in corpus["cases"] for event in case["events"]}
    assert kinds == {"sources", "reasoning", "content", "tool_calls", "usage", "done"}
