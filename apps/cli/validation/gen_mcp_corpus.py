"""Corpus dorado del cliente MCP: formato de resultados, nombres expuestos,
schemas de herramientas y lectura de mcp.json.

Oráculo: lixbon_cli.mcp. Diferencias deliberadas del cliente Go (no están en el
corpus): structuredContent como respaldo de un resultado vacío, `type: object`
añadido a un inputSchema que no lo trae, sufijo ante nombres repetidos, límite
de 64 caracteres en el nombre y valores bool/null de args y env.

    python apps/cli/validation/gen_mcp_corpus.py          # reescribe
    python apps/cli/validation/gen_mcp_corpus.py --check  # falla si cambió
"""
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from lixbon_cli import mcp  # noqa: E402

CORPUS = HERE / "fixtures" / "mcp_corpus.json"
WORKSPACE = "<ws>"

RESULTS = [
    {"content": [{"type": "text", "text": "a"}, {"type": "text", "text": ""}, {"type": "text", "text": "b"}]},
    {"content": [{"type": "image", "mimeType": "image/png", "data": "AA"}]},
    {"content": [{"type": "resource", "resource": {"uri": "file:///x", "text": "cuerpo"}}]},
    {"content": [{"type": "resource", "resource": {"uri": "file:///x"}}]},
    {"content": [{"type": "resource"}]},
    {"content": [{"type": "audio", "data": "AA"}, {"type": "text", "text": "tras audio"}]},
    {"content": [{"type": "text", "text": "  \n"}]},
    {"content": []},
    {"content": None},
    {},
    {"isError": True, "content": [{"type": "text", "text": "mal"}]},
    {"isError": True},
    {"content": [{"type": "text", "text": "línea 1\nlínea 2 ñandú 🎵"}]},
    {"content": [{"type": "text", "text": "  con espacios  "}]},
]

SLUGS = ["github", "my server", "do-it", "ñandú", "a.b/c", "__x__", "!!!", "", "Ok_1", "mcp lixbon"]

TOOLS = [
    {"name": "echo", "description": "Devuelve el texto",
     "inputSchema": {"type": "object", "properties": {"zeta": {"type": "string"}, "alfa": {"type": "integer"}},
                     "required": ["alfa"]}},
    {"name": "sin descripción", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "sin schema"},
    {"name": "schema vacío", "description": "d", "inputSchema": {}},
    {"name": "larga", "description": "é" * 1200, "inputSchema": {"type": "object"}},
]

PROMPTS = [
    {"messages": [{"role": "user", "content": {"type": "text", "text": "uno"}},
                  {"role": "assistant", "content": {"type": "text", "text": "dos"}}]},
    {"messages": [{"role": "user", "content": {"type": "image", "data": "AA"}},
                  {"role": "user", "content": {"type": "text", "text": "solo texto"}}]},
    {"messages": [{"role": "user", "content": "texto plano"}]},
    {"messages": []},
    {},
]

CONFIGS = [
    {"name": "solo usuario", "user": {"servers": {"a": {"command": "uno", "args": ["x", 1]}}}, "project": None},
    {"name": "mcpServers", "user": None, "project": {"mcpServers": {"a": {"command": "uno"}}}},
    {"name": "servers vacío cae a mcpServers", "user": None,
     "project": {"servers": {}, "mcpServers": {"a": {"command": "uno"}}}},
    {"name": "proyecto pisa al usuario sin mover su posición",
     "user": {"servers": {"a": {"command": "u-a"}, "b": {"command": "u-b"}, "c": {"command": "u-c"}}},
     "project": {"servers": {"b": {"command": "p-b", "cwd": "/otra"}, "d": {"command": "p-d"}}}},
    {"name": "remoto", "user": {"servers": {"r": {"url": "https://ej.com/mcp", "headers": {"Authorization": "Bearer x", "N": 7}}}},
     "project": None},
    {"name": "url gana a command", "user": {"servers": {"r": {"url": "https://ej.com/mcp", "command": "x"}}}, "project": None},
    {"name": "entradas inválidas se ignoran",
     "user": {"servers": {"sin": {"nada": 1}, "cadena": "no", "lista": [1], "ok": {"command": "c", "env": {"K": "v", "N": 1}}}},
     "project": None},
    {"name": "orden del archivo", "user": {"servers": {"z": {"command": "z"}, "a": {"command": "a"}, "m": {"command": "m"}}},
     "project": None},
]


def format_cases() -> list[dict]:
    return [{"result": r, "text": mcp.format_tool_result(r)} for r in RESULTS]


def slug_cases() -> list[dict]:
    return [{"text": t, "slug": mcp._slug(t)} for t in SLUGS]


def schema_cases() -> list[dict]:
    registry = mcp.McpRegistry()
    registry.servers["demo srv"] = SimpleNamespace(tools=TOOLS)
    for tool in TOOLS:
        registry._tool_map[f"mcp__{mcp._slug('demo srv')}__{mcp._slug(tool['name'])}"] = ("demo srv", tool["name"])
    return [{"server": "demo srv", "tools": TOOLS, "schemas": registry.tool_schemas()}]


def prompt_cases() -> list[dict]:
    return [{"result": r, "text": mcp.prompt_text(r)} for r in PROMPTS]


def normalized(spec: dict, workspace: Path) -> dict:
    if spec.get("url"):
        return {"url": spec["url"], "headers": {k: str(v) for k, v in (spec.get("headers") or {}).items()}}
    cwd = spec.get("cwd")
    return {"command": str(spec["command"]), "args": [str(a) for a in spec.get("args") or []],
            "env": {k: str(v) for k, v in (spec.get("env") or {}).items()},
            "cwd": WORKSPACE if cwd == str(workspace) else cwd}



def config_cases() -> list[dict]:
    out = []
    for case in CONFIGS:
        with tempfile.TemporaryDirectory() as tmp:
            home, workspace = Path(tmp) / "home", Path(tmp) / "ws"
            (workspace / ".lixbon").mkdir(parents=True)
            home.mkdir()
            if case["user"] is not None:
                (home / "mcp.json").write_text(json.dumps(case["user"]), encoding="utf-8")
            if case["project"] is not None:
                (workspace / ".lixbon" / "mcp.json").write_text(json.dumps(case["project"]), encoding="utf-8")
            loaded = mcp.load_mcp_config(workspace, home)
            expected = [{"name": name, **normalized(spec, workspace)} for name, spec in loaded.items()]
        out.append({**case, "expected": expected})
    return out


def build() -> dict:
    return {
        "version": 1,
        "oracle": "apps/cli/lixbon_cli/mcp.py",
        "workspace_placeholder": WORKSPACE,
        "format_result": format_cases(),
        "slug": slug_cases(),
        "schemas": schema_cases(),
        "prompt_text": prompt_cases(),
        "config": config_cases(),
    }


def render() -> str:
    return json.dumps(build(), ensure_ascii=False, indent=1) + "\n"


def main() -> int:
    text = render()
    if "--check" in sys.argv:
        current = CORPUS.read_text(encoding="utf-8") if CORPUS.exists() else ""
        if current != text:
            print("mcp_corpus.json desactualizado: ejecuta gen_mcp_corpus.py", file=sys.stderr)
            return 1
        return 0
    CORPUS.write_text(text, encoding="utf-8", newline="\n")
    print(f"escrito {CORPUS} ({len(text) // 1024} kB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
