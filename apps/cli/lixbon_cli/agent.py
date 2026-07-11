"""Modo agent: herramientas locales de código y loop de ejecución.

El modelo emite JSON `{"tool": ..., "args": {...}}` embebido en su respuesta;
aquí se parsea, se pide aprobación (con vista previa del diff) y se ejecuta.
"""
import json
import subprocess
from pathlib import Path

from lixbon_cli.diffs import compute_change, render_change
from lixbon_cli.term import g
from lixbon_cli.theme import make_console
from lixbon_cli.ui import confirm3, esc

MAX_AGENT_STEPS = 12

READ_ONLY_TOOLS = {"list_files", "read_file", "search"}

AGENT_SYSTEM_PROMPT = (
    "Eres un agente de codigo experto. Ejecutas acciones sobre archivos usando herramientas JSON.\n"
    "Workspace: {workspace}\n"
    "Rutas siempre RELATIVAS al workspace.\n\n"
    "=== HERRAMIENTAS DISPONIBLES ===\n"
    '{{"tool":"list_files","args":{{"path":"."}}}}\n'
    '{{"tool":"read_file","args":{{"path":"archivo.txt"}}}}\n'
    '{{"tool":"write_file","args":{{"path":"archivo.txt","content":"contenido completo"}}}}\n'
    '{{"tool":"append_file","args":{{"path":"archivo.txt","content":"texto nuevo al final"}}}}\n'
    '{{"tool":"mkdir","args":{{"path":"carpeta/subcarpeta"}}}}\n'
    '{{"tool":"search","args":{{"pattern":"texto a buscar","path":"."}}}}\n'
    '{{"tool":"delete_file","args":{{"path":"archivo.txt"}}}}\n'
    '{{"tool":"rename_file","args":{{"src":"viejo.txt","dst":"nuevo.txt"}}}}\n'
    '{{"tool":"run_command","args":{{"command":"npm install","timeout":60}}}}\n\n'
    "=== REGLAS OBLIGATORIAS ===\n"
    "1. Responde SIEMPRE con JSON puro para herramientas. NUNCA uses markdown (```) alrededor del JSON.\n"
    "2. Para EDITAR un archivo existente: primero read_file para leer, luego write_file con el contenido COMPLETO modificado.\n"
    "3. Puedes encadenar varias herramientas en una misma respuesta.\n"
    "4. Cuando termines todas las acciones, responde con texto normal resumiendo lo que hiciste.\n"
    "5. Los resultados de herramientas te llegan como TOOL_RESULT. Usalos para continuar.\n"
    "6. Si la tarea involucra ejecutar comandos del sistema, usa run_command."
)


# ── Sandbox de rutas y herramientas ─────────────────────────────────────────

def resolve_safe_path(workspace: Path, user_path: str) -> Path:
    path = Path(user_path)
    full = (workspace / path).resolve() if not path.is_absolute() else path.resolve()
    if workspace not in [full, *full.parents]:
        raise RuntimeError("Ruta fuera del workspace permitido")
    return full


def tool_list_files(workspace: Path, rel_path: str = ".") -> str:
    target = resolve_safe_path(workspace, rel_path)
    if not target.exists():
        return f"No existe: {target}"
    if target.is_file():
        return str(target.relative_to(workspace))
    items = sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    lines = []
    for p in items[:200]:
        marker = "F" if p.is_file() else "D"
        lines.append(f"[{marker}] {p.relative_to(workspace)}")
    return "\n".join(lines) if lines else "(vacio)"


def tool_read_file(workspace: Path, rel_path: str) -> str:
    target = resolve_safe_path(workspace, rel_path)
    if not target.exists() or not target.is_file():
        return f"Archivo no encontrado: {rel_path}"
    return target.read_text(encoding="utf-8", errors="replace")[:120000]


def tool_write_file(workspace: Path, rel_path: str, content: str) -> str:
    target = resolve_safe_path(workspace, rel_path)
    is_new = not target.exists()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    action = "creado" if is_new else "actualizado"
    return f"Archivo {action}: {target.relative_to(workspace)} ({len(content)} chars)"


def tool_append_file(workspace: Path, rel_path: str, content: str) -> str:
    target = resolve_safe_path(workspace, rel_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a", encoding="utf-8") as f:
        f.write(content)
    return f"Archivo actualizado: {target.relative_to(workspace)} (+{len(content)} chars)"


def tool_mkdir(workspace: Path, rel_path: str) -> str:
    target = resolve_safe_path(workspace, rel_path)
    target.mkdir(parents=True, exist_ok=True)
    return f"Directorio creado/listo: {target.relative_to(workspace)}"


def tool_search(workspace: Path, pattern: str, rel_path: str = ".") -> str:
    target = resolve_safe_path(workspace, rel_path)
    try:
        cmd = ["rg", "-n", "--hidden", "--glob", "!.git", pattern, str(target)]
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True)
        return out[:120000] if out else "(sin resultados)"
    except FileNotFoundError:
        return _search_python(workspace, target, pattern)
    except subprocess.CalledProcessError as exc:
        return (exc.output or "").strip() or "(sin resultados)"


def _search_python(workspace: Path, target: Path, pattern: str) -> str:
    """Fallback sin ripgrep: búsqueda simple por substring."""
    hits: list[str] = []
    files = [target] if target.is_file() else [
        p for p in target.rglob("*") if p.is_file() and ".git" not in p.parts
    ]
    for p in files[:2000]:
        try:
            for lineno, line in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if pattern in line:
                    hits.append(f"{p.relative_to(workspace)}:{lineno}:{line.strip()[:200]}")
                    if len(hits) >= 500:
                        return "\n".join(hits)
        except Exception:
            continue
    return "\n".join(hits) if hits else "(sin resultados)"


def tool_delete_file(workspace: Path, rel_path: str) -> str:
    target = resolve_safe_path(workspace, rel_path)
    if not target.exists():
        return f"No encontrado: {rel_path}"
    if target.is_dir():
        import shutil
        shutil.rmtree(target)
        return f"Directorio eliminado: {rel_path}"
    target.unlink()
    return f"Archivo eliminado: {rel_path}"


def tool_rename_file(workspace: Path, src: str, dst: str) -> str:
    source = resolve_safe_path(workspace, src)
    dest = resolve_safe_path(workspace, dst)
    if not source.exists():
        return f"No encontrado: {src}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    source.rename(dest)
    return f"Movido: {src} {g('arrow')} {dst}"


def tool_run_command(workspace: Path, command: str, timeout: int = 30) -> str:
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=str(workspace),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        output = (result.stdout + result.stderr).strip()
        prefix = f"[EXIT {result.returncode}] "
        return prefix + (output[:8000] if output else "(sin salida)")
    except subprocess.TimeoutExpired:
        return f"[TIMEOUT] Comando excedio {timeout}s"
    except Exception as exc:
        return f"[ERROR] {exc}"


def execute_tool_call(workspace: Path, tool_name: str, args: dict) -> str:
    if tool_name == "list_files":
        return tool_list_files(workspace, args.get("path", "."))
    if tool_name == "read_file":
        return tool_read_file(workspace, args.get("path", ""))
    if tool_name == "write_file":
        return tool_write_file(workspace, args.get("path", ""), args.get("content", ""))
    if tool_name == "append_file":
        return tool_append_file(workspace, args.get("path", ""), args.get("content", ""))
    if tool_name == "mkdir":
        return tool_mkdir(workspace, args.get("path", ""))
    if tool_name == "search":
        return tool_search(workspace, args.get("pattern", ""), args.get("path", "."))
    if tool_name == "delete_file":
        return tool_delete_file(workspace, args.get("path", ""))
    if tool_name == "rename_file":
        return tool_rename_file(workspace, args.get("src", ""), args.get("dst", ""))
    if tool_name == "run_command":
        return tool_run_command(workspace, args.get("command", ""), int(args.get("timeout", 30)))
    raise RuntimeError(f"Herramienta no soportada: {tool_name}")


# ── Parseo de tool calls embebidos en texto ─────────────────────────────────

def _validate_tool_dict(data: dict) -> dict | None:
    if isinstance(data, dict) and data.get("tool"):
        if "args" not in data or not isinstance(data.get("args"), dict):
            data["args"] = {}
        return data
    return None


def extract_all_tool_calls(text: str) -> list[dict]:
    """Extrae todos los JSON `{"tool":...}` embebidos en texto mixto.

    Cuenta llaves para soportar JSON anidado (write_file con content largo).
    """
    results = []
    i = 0
    while i < len(text):
        start = text.find('{"tool"', i)
        if start == -1:
            start = text.find('{ "tool"', i)
        if start == -1:
            break
        depth = 0
        j = start
        in_string = False
        escape_next = False
        while j < len(text):
            ch = text[j]
            if escape_next:
                escape_next = False
            elif ch == "\\" and in_string:
                escape_next = True
            elif ch == '"':
                in_string = not in_string
            elif not in_string:
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        candidate = text[start: j + 1]
                        try:
                            # strict=False: tolera saltos de línea reales dentro
                            # de strings (JSON inválido pero frecuente en LLMs)
                            data = _validate_tool_dict(json.loads(candidate, strict=False))
                            if data:
                                results.append(data)
                        except Exception:
                            pass
                        i = j + 1
                        break
            j += 1
        else:
            break
    return results


def strip_tool_calls(text: str) -> str:
    """Quita los JSON de herramientas del texto para mostrar solo la prosa."""
    for call in extract_all_tool_calls(text):
        raw = json.dumps(call)
        text = text.replace(raw, "")
    return text


# ── Loop del agente ─────────────────────────────────────────────────────────

def run_agent_turn(history: list[dict], workspace: Path, session: dict,
                   stream_assistant) -> tuple[str, list[dict]]:
    """Ejecuta un turno de agente con aprobación interactiva.

    - `session`: estado mutable con `auto_approve: bool`.
    - `stream_assistant(messages) -> str`: lo aporta la app; muestra el texto
      del modelo en vivo y devuelve la respuesta completa.
    Devuelve (respuesta_final, history_actualizado).
    """
    console = make_console()
    system_msg = {"role": "system", "content": AGENT_SYSTEM_PROMPT.format(workspace=workspace)}
    working = history[:]

    for _ in range(MAX_AGENT_STEPS):
        assistant = stream_assistant([system_msg] + working)
        working.append({"role": "assistant", "content": assistant})

        tool_calls = extract_all_tool_calls(assistant)
        if not tool_calls:
            return assistant, working

        combined_results = []
        for call in tool_calls:
            tool_name = call.get("tool", "")
            args = call.get("args", {})
            result = _approve_and_run(console, workspace, session, tool_name, args)
            combined_results.append(f"TOOL_RESULT {tool_name}: {result}")

        working.append({"role": "user", "content": "\n".join(combined_results)})

    return "No se pudo finalizar: se alcanzó el máximo de pasos del agente.", working


def _approve_and_run(console, workspace: Path, session: dict, tool_name: str, args: dict) -> str:
    dot = g("dot")

    if tool_name in READ_ONLY_TOOLS:
        # Solo lectura: se ejecuta sin preguntar, con rastro discreto.
        label = args.get("path") or args.get("pattern") or "."
        console.print(f"[lx.dim]{dot} {tool_name}({esc(label)})[/]")
        return _run(console, workspace, tool_name, args)

    try:
        change = compute_change(workspace, tool_name, args, resolve_safe_path)
    except Exception:
        change = None
    if change is not None:
        render_change(console, change)
    else:
        console.print(f"[lx.accent2]{dot}[/] [bold lx.primary]{tool_name}[/] [lx.dim]{esc(args)}[/]")

    if not session.get("auto_approve"):
        decision = confirm3("¿Aplicar este cambio?")
        if decision == "always":
            session["auto_approve"] = True
        elif decision in ("no", None):
            console.print(f"[lx.dim]{dot} rechazado[/]")
            return "Ejecución cancelada por el usuario"

    return _run(console, workspace, tool_name, args)


def _run(console, workspace: Path, tool_name: str, args: dict) -> str:
    try:
        result = execute_tool_call(workspace, tool_name, args)
    except Exception as exc:
        result = f"[ERROR] {exc}"
    if tool_name not in READ_ONLY_TOOLS:
        first_line = result.split("\n", 1)[0][:120]
        style = "lx.err" if result.startswith("[ERROR]") else "lx.dim"
        console.print(f"  [{style}]{g('arrow')} {esc(first_line)}[/]")
    return result
