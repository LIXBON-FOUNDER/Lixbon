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


# ── Transporte HTTP (Streamable HTTP) ──────────────────────────────────────

import json as _json  # noqa: E402
import threading as _threading  # noqa: E402
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402
from types import SimpleNamespace  # noqa: E402

from lixbon_cli.mcp import HttpMcpServer, McpError  # noqa: E402


class _FakeHttpMcp(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        if self.headers.get("Authorization") != "Bearer buena":
            self.send_response(401)
            self.end_headers()
            return
        msg = _json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if "id" not in msg:
            self.send_response(202)
            self.end_headers()
            return
        m, i = msg["method"], msg["id"]
        if m == "initialize":
            result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}, "prompts": {}}}
        elif m == "tools/list":
            result = {"tools": [{"name": "visual_list", "description": "Lista", "inputSchema": {"type": "object"}}]}
        elif m == "tools/call":
            result = {"content": [{"type": "text", "text": "hay 2 visuals"}]}
        else:
            result = {"messages": [{"role": "user", "content": {"type": "text", "text": "diseña: " + msg["params"]["arguments"]["peticion"]}}]}
        body = _json.dumps({"jsonrpc": "2.0", "id": i, "result": result})
        sse = m == "tools/call"  # una respuesta por SSE, como hacen algunos servidores
        data = (f"event: message\ndata: {body}\n\n" if sse else body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream" if sse else "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def _http_server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _FakeHttpMcp)
    _threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}/mcp"


def test_http_tools_prompt_y_sse():
    srv, url = _http_server()
    try:
        server = HttpMcpServer("lixbon", url, {"Authorization": "Bearer buena"})
        server.start()
        assert server.alive and [t["name"] for t in server.tools] == ["visual_list"]
        assert server.call("visual_list", {}) == "hay 2 visuals"
        assert server.get_prompt("visual", {"peticion": "una landing"}) == "diseña: una landing"
    finally:
        srv.shutdown()


def test_http_sin_auth_da_error_claro():
    srv, url = _http_server()
    try:
        server = HttpMcpServer("lixbon", url, {"Authorization": "Bearer mala"})
        try:
            server.start()
            raise AssertionError("debió fallar")
        except McpError as exc:
            assert "401" in str(exc)
        assert not server.alive
    finally:
        srv.shutdown()


def test_registro_mezcla_stdio_y_http(tmp_path):
    srv, url = _http_server()
    try:
        config = _config(tmp_path)
        config["lixbon"] = {"url": url, "headers": {"Authorization": "Bearer buena"}}
        registry = McpRegistry()
        registry.start_all(config)
        try:
            nombres = {s["function"]["name"] for s in registry.tool_schemas()}
            assert {"mcp__demo__echo", "mcp__lixbon__visual_list"} <= nombres
            assert registry.call("mcp__lixbon__visual_list", {}) == "hay 2 visuals"
        finally:
            registry.close_all()
    finally:
        srv.shutdown()


def test_config_con_url_y_servidor_de_lixbon_automatico(tmp_path):
    (tmp_path / ".lixbon").mkdir()
    (tmp_path / ".lixbon" / "mcp.json").write_text('{"servers": {"remoto": {"url": "https://x/mcp"}}}', encoding="utf-8")
    assert load_mcp_config(tmp_path, tmp_path / "nohome")["remoto"]["url"] == "https://x/mcp"

    from lixbon_cli.app import LIXBON_MCP, ChatApp

    fake = SimpleNamespace(workspace=tmp_path, cfg={"api_key": "lixbon_sk_x", "base_url": "https://lixbon.com/v1"})
    config = ChatApp._mcp_config(fake)
    assert config[LIXBON_MCP] == {"url": "https://lixbon.com/mcp", "headers": {"Authorization": "Bearer lixbon_sk_x"}}
    assert LIXBON_MCP not in ChatApp._mcp_config(SimpleNamespace(workspace=tmp_path, cfg={"api_key": ""}))
    off = SimpleNamespace(workspace=tmp_path, cfg={"api_key": "k", "lixbon_mcp": False})
    assert LIXBON_MCP not in ChatApp._mcp_config(off)
