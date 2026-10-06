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


def test_tool_corpus_and_catalog_match_python_oracle():
    spec = importlib.util.spec_from_file_location(
        "gen_tool_corpus", CLI_DIR / "validation" / "gen_tool_corpus.py")
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    for path, data in ((generator.CATALOG, generator.build_catalog()),
                       (generator.CORPUS, generator.build_corpus())):
        assert path.read_text(encoding="utf-8") == generator.render(data), (
            f"{path.name} no coincide con lixbon_cli/agent.py. "
            "Regenera con: python apps/cli/validation/gen_tool_corpus.py"
        )


def test_workspace_corpus_matches_python_oracle():
    spec = importlib.util.spec_from_file_location(
        "gen_workspace_corpus", CLI_DIR / "validation" / "gen_workspace_corpus.py")
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    assert generator.CORPUS.read_text(encoding="utf-8") == generator.render(), (
        "workspace_corpus.json no coincide con las herramientas de agent.py. "
        "Regenera con: python apps/cli/validation/gen_workspace_corpus.py"
    )


def test_edit_corpus_matches_python_oracle():
    spec = importlib.util.spec_from_file_location(
        "gen_edit_corpus", CLI_DIR / "validation" / "gen_edit_corpus.py")
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    assert generator.CORPUS.read_text(encoding="utf-8") == generator.render(), (
        "edit_corpus.json no coincide con las herramientas de escritura de agent.py. "
        "Regenera con: python apps/cli/validation/gen_edit_corpus.py"
    )


def test_agent_corpus_matches_python_oracle():
    spec = importlib.util.spec_from_file_location(
        "gen_agent_corpus", CLI_DIR / "validation" / "gen_agent_corpus.py")
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    assert generator.CORPUS.read_text(encoding="utf-8") == generator.render(), (
        "agent_corpus.json no coincide con context.py/agent.py. "
        "Regenera con: python apps/cli/validation/gen_agent_corpus.py"
    )


def test_state_corpus_matches_python_oracle():
    spec = importlib.util.spec_from_file_location(
        "gen_state_corpus", CLI_DIR / "validation" / "gen_state_corpus.py")
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    assert generator.CORPUS.read_text(encoding="utf-8") == generator.render(), (
        "state_corpus.json no coincide con sessions.py/commands.py. "
        "Regenera con: python apps/cli/validation/gen_state_corpus.py"
    )


def test_mcp_corpus_matches_python_oracle():
    spec = importlib.util.spec_from_file_location(
        "gen_mcp_corpus", CLI_DIR / "validation" / "gen_mcp_corpus.py")
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    assert generator.CORPUS.read_text(encoding="utf-8") == generator.render(), (
        "mcp_corpus.json no coincide con lixbon_cli/mcp.py. "
        "Regenera con: python apps/cli/validation/gen_mcp_corpus.py"
    )
