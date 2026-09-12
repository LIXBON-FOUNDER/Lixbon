"""Cliente MCP (Model Context Protocol) por stdio, sin dependencias.

Servidores en `<workspace>/.lixbon/mcp.json` o `~/.lixbon/mcp.json`:

    {"servers": {"github": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
                            "env": {"GITHUB_TOKEN": "..."}}}}

Cada tool del servidor se expone al modelo como `mcp__<servidor>__<tool>`.
"""
import json
import os
import re
import shutil
import subprocess
import threading
from pathlib import Path

MCP_PROTOCOL = "2024-11-05"
MCP_FILENAME = "mcp.json"
START_TIMEOUT = 30
CALL_TIMEOUT = 120
MAX_RESULT_CHARS = 20000


class McpError(RuntimeError):
    pass


def _slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", text).strip("_") or "x"


class McpServer:
    def __init__(self, name: str, command: str, args: list[str], env: dict | None = None, cwd: str = ""):
        self.name = name
        self.command = command
        self.args = args
        self.env = env or {}
        self.cwd = cwd
        self.proc: subprocess.Popen | None = None
        self.tools: list[dict] = []
        self.error = ""
        self._seq = 0
        self._pending: dict[int, dict] = {}
        self._lock = threading.Lock()

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def start(self) -> None:
        exe = shutil.which(self.command) or self.command
        env = {**os.environ, **{k: str(v) for k, v in self.env.items()}}
        extra = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
        try:
            self.proc = subprocess.Popen(
                [exe, *self.args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, cwd=self.cwd or None, env=env, **extra,
            )
        except OSError as exc:
            raise McpError(f"no se pudo lanzar «{self.command}»: {exc}") from exc
        threading.Thread(target=self._reader, daemon=True, name=f"mcp-{self.name}").start()
        self.request("initialize", {
            "protocolVersion": MCP_PROTOCOL,
            "capabilities": {},
            "clientInfo": {"name": "lixbon-cli", "version": "1"},
        }, timeout=START_TIMEOUT)
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.tools = list(self.request("tools/list", {}, timeout=START_TIMEOUT).get("tools") or [])

    def _reader(self) -> None:
        assert self.proc and self.proc.stdout
        for raw in iter(self.proc.stdout.readline, b""):
            try:
                msg = json.loads(raw.decode("utf-8", errors="replace"))
            except ValueError:
                continue  # los servidores a veces escriben logs por stdout
            ident = msg.get("id")
            if ident is None or ident not in self._pending:
                continue
            slot = self._pending[ident]
            slot["response"] = msg
            slot["event"].set()

    def _send(self, message: dict) -> None:
        if not self.alive or not self.proc or not self.proc.stdin:
            raise McpError(f"el servidor «{self.name}» no está en marcha")
        data = (json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8")
        with self._lock:
            self.proc.stdin.write(data)
            self.proc.stdin.flush()

    def request(self, method: str, params: dict, timeout: float = CALL_TIMEOUT) -> dict:
        self._seq += 1
        ident = self._seq
        slot = {"event": threading.Event(), "response": None}
        self._pending[ident] = slot
        try:
            self._send({"jsonrpc": "2.0", "id": ident, "method": method, "params": params})
            if not slot["event"].wait(timeout):
                raise McpError(f"«{self.name}» no respondió a {method} en {timeout:.0f}s")
        finally:
            self._pending.pop(ident, None)
        response = slot["response"] or {}
        if "error" in response:
            err = response["error"]
            raise McpError(str(err.get("message") or err) if isinstance(err, dict) else str(err))
        return response.get("result") or {}

    def call(self, tool: str, arguments: dict) -> str:
        result = self.request("tools/call", {"name": tool, "arguments": arguments or {}})
        parts = []
        for item in result.get("content") or []:
            kind = item.get("type")
            if kind == "text":
                parts.append(str(item.get("text", "")))
            elif kind == "image":
                parts.append(f"[imagen {item.get('mimeType', '')}: no se puede mostrar aquí]")
            elif kind == "resource":
                res = item.get("resource") or {}
                parts.append(str(res.get("text") or f"[recurso {res.get('uri', '')}]"))
        text = "\n".join(p for p in parts if p).strip() or "(sin contenido)"
        if len(text) > MAX_RESULT_CHARS:
            text = text[:MAX_RESULT_CHARS] + "\n…[recortado]"
        if result.get("isError"):
            return f"[ERROR] {text}"
        return text

    def close(self) -> None:
        if self.proc and self.alive:
            try:
                self.proc.stdin.close()
                self.proc.wait(timeout=3)
            except Exception:
                self.proc.kill()


def load_mcp_config(workspace: Path, home_dir: Path) -> dict[str, dict]:
    """Servidores declarados; los del proyecto pisan a los del usuario."""
    servers: dict[str, dict] = {}
    for path in (home_dir / MCP_FILENAME, workspace / ".lixbon" / MCP_FILENAME):
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for name, spec in (data.get("servers") or data.get("mcpServers") or {}).items():
            if isinstance(spec, dict) and spec.get("command"):
                servers[str(name)] = {**spec, "cwd": spec.get("cwd") or str(workspace)}
    return servers


class McpRegistry:
    def __init__(self):
        self.servers: dict[str, McpServer] = {}
        self._tool_map: dict[str, tuple[str, str]] = {}  # nombre expuesto → (servidor, tool)

    def start_all(self, config: dict[str, dict]) -> None:
        for name, spec in config.items():
            server = McpServer(name, str(spec["command"]), [str(a) for a in spec.get("args") or []],
                               spec.get("env") or {}, str(spec.get("cwd") or ""))
            self.servers[name] = server
            try:
                server.start()
            except McpError as exc:
                server.error = str(exc)
                continue
            except Exception as exc:  # un servidor roto no tumba el CLI
                server.error = f"{type(exc).__name__}: {exc}"
                continue
            for tool in server.tools:
                exposed = f"mcp__{_slug(name)}__{_slug(str(tool.get('name', '')))}"
                self._tool_map[exposed] = (name, str(tool.get("name", "")))

    def tool_schemas(self) -> list[dict]:
        schemas = []
        for exposed, (server_name, tool_name) in self._tool_map.items():
            server = self.servers[server_name]
            tool = next((t for t in server.tools if t.get("name") == tool_name), None)
            if tool is None:
                continue
            params = tool.get("inputSchema") or {"type": "object", "properties": {}}
            schemas.append({"type": "function", "function": {
                "name": exposed,
                "description": f"[MCP {server_name}] {tool.get('description') or tool_name}"[:1000],
                "parameters": params,
            }})
        return schemas

    def is_mcp_tool(self, name: str) -> bool:
        return name in self._tool_map

    def call(self, exposed: str, arguments: dict) -> str:
        server_name, tool_name = self._tool_map[exposed]
        server = self.servers[server_name]
        if not server.alive:
            return f"[ERROR] El servidor MCP «{server_name}» no está en marcha"
        try:
            return server.call(tool_name, arguments)
        except McpError as exc:
            return f"[ERROR] {exc}"

    def summary(self) -> list[tuple[str, str, int, str]]:
        """(servidor, comando, nº tools, error) por servidor."""
        return [(s.name, " ".join([s.command, *s.args])[:80], len(s.tools), s.error)
                for s in self.servers.values()]

    def close_all(self) -> None:
        for server in self.servers.values():
            server.close()
