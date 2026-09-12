"""Cliente MCP contra un servidor stdio de mentira (JSON-RPC por líneas)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lixbon_cli import agent  # noqa: E402
from lixbon_cli.mcp import McpRegistry, load_mcp_config  # noqa: E402
from lixbon_cli.theme import make_console  # noqa: E402

FAKE_SERVER = r'''
import json, sys
def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n"); sys.stdout.flush()
print("log basura que no es json", flush=True)
for raw in sys.stdin:
    msg = json.loads(raw)
    m, i = msg.get("method"), msg.get("id")
    if m == "initialize":
        send({"jsonrpc": "2.0", "id": i, "result": {"protocolVersion": "2024-11-05", "capabilities": {}}})
    elif m == "tools/list":
        send({"jsonrpc": "2.0", "id": i, "result": {"tools": [
            {"name": "echo", "description": "Devuelve el texto", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
            {"name": "fail", "description": "Siempre falla", "inputSchema": {"type": "object", "properties": {}}},
        ]}})
    elif m == "tools/call":
        name = msg["params"]["name"]
        if name == "echo":
            send({"jsonrpc": "2.0", "id": i, "result": {"content": [{"type": "text", "text": "eco: " + msg["params"]["arguments"]["text"]}]}})
        else:
            send({"jsonrpc": "2.0", "id": i, "result": {"isError": True, "content": [{"type": "text", "text": "roto"}]}})
'''


def _config(tmp_path: Path) -> dict:
    script = tmp_path / "fake_mcp.py"
    script.write_text(FAKE_SERVER, encoding="utf-8")
    (tmp_path / ".lixbon").mkdir()
    (tmp_path / ".lixbon" / "mcp.json").write_text(
        '{"servers": {"demo": {"command": "%s", "args": ["%s"]}}}' % (
            sys.executable.replace("\\", "\\\\"), str(script).replace("\\", "\\\\")),
        encoding="utf-8")
    return load_mcp_config(tmp_path, tmp_path / "nohome")


def test_registro_expone_tools_y_las_llama(tmp_path):
    registry = McpRegistry()
    registry.start_all(_config(tmp_path))
    try:
        assert registry.summary()[0][:1] == ("demo",) and registry.summary()[0][3] == ""
        names = [s["function"]["name"] for s in registry.tool_schemas()]
        assert names == ["mcp__demo__echo", "mcp__demo__fail"]
        assert registry.tool_schemas()[0]["function"]["description"].startswith("[MCP demo]")
        assert registry.call("mcp__demo__echo", {"text": "hola"}) == "eco: hola"
        assert registry.call("mcp__demo__fail", {}) == "[ERROR] roto"
    finally:
        registry.close_all()


def test_servidor_inexistente_no_tumba_el_registro(tmp_path):
    registry = McpRegistry()
    registry.start_all({"malo": {"command": "programa-que-no-existe-xyz", "args": []}})
    assert registry.summary()[0][3]  # error registrado
    assert registry.tool_schemas() == []


def test_el_agente_ejecuta_tools_mcp_con_auto_aprobar(tmp_path):
    registry = McpRegistry()
    registry.start_all(_config(tmp_path))
    try:
        session = {"mcp": registry, "auto_approve": True,
                   "turn_stats": {"actions": 0, "files": set(), "adds": 0, "dels": 0}}
        out = agent._approve_and_run(make_console(), tmp_path, session, "mcp__demo__echo", {"text": "x"})
        assert out == "eco: x" and session["turn_stats"]["actions"] == 1
        session["plan_mode"] = True
        assert agent._approve_and_run(make_console(), tmp_path, session, "mcp__demo__echo", {"text": "x"}).startswith("[modo plan]")
    finally:
        registry.close_all()


def test_prompt_de_texto_lista_las_tools_mcp():
    schemas = [{"type": "function", "function": {"name": "mcp__a__b", "description": "hace b",
                "parameters": {"type": "object", "properties": {"x": {}, "y": {}}}}}]
    texto = agent.mcp_text_prompt(schemas)
    assert '{"tool":"mcp__a__b","args":{"x":…, "y":…}}  hace b' in texto
