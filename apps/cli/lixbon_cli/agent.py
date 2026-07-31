"""Modo agent: herramientas locales de código y loop de ejecución.

Dos protocolos, en este orden de preferencia:

1. Tool-calling NATIVO: se mandan las definiciones de funciones (TOOL_SCHEMAS)
   al gateway, que las pasa a Ollama. Los modelos entrenados con tools
   (qwen2.5-coder, llama3.2, mistral…) devuelven `tool_calls` estructurados.
   Es lo único que funciona de forma fiable con modelos chicos (7B): pedirles
   por prompt que escriban JSON a mano casi siempre acaba en un bloque ```.
2. Fallback de TEXTO: el modelo emite `{"tool": ..., "args": {...}}` embebido en
   la respuesta y aquí se parsea. Se usa si el modelo no soporta tools nativas.

En ambos casos se pide aprobación (con vista previa del diff) antes de ejecutar.
"""
import json
import re
import subprocess
from pathlib import Path

from lixbon_cli.context import (
    clip_tool_output,
    estimate_tokens,
    fit_history,
    prompt_budget,
)
from lixbon_cli.diffs import compute_change, render_change
from lixbon_cli.remote import REMOTE_RESULT_CHARS, _args_summary
from lixbon_cli.term import g
from lixbon_cli.theme import make_console
from lixbon_cli.ui import (
    TOOL_VERB,
    confirm3,
    print_note,
    render_action,
    render_action_result,
)

# Tope de pasos por turno. Es un cortafuegos contra bucles, NO un presupuesto de
# trabajo: una tarea real (leer varios archivos, editarlos, ejecutar los tests y
# corregir) se come 12 pasos enseguida, y antes el turno moría ahí sin decir
# nada. Ahora hay margen de sobra y, si se alcanza, se dice por qué.
MAX_AGENT_STEPS = 40

# Llamadas idénticas seguidas que se toleran antes de romper el bucle: un modelo
# atascado repite la misma herramienta con los mismos argumentos indefinidamente.
MAX_REPEATED_CALLS = 3

READ_ONLY_TOOLS = {"list_files", "read_file", "search"}

# Catálogo legible de lo que el agente puede hacer (lo muestra /tools). Es la
# misma lista que se le describe al modelo en el system prompt, escrita para
# personas: quien usa el CLI necesita saber qué puede tocar el agente.
TOOL_SPECS: list[tuple[str, str, str]] = [
    ("list_files", "path", "Listar el contenido de una carpeta"),
    ("read_file", "path, start_line?, end_line?", "Leer un archivo (o un rango de líneas)"),
    ("search", "pattern, path", "Buscar texto en el workspace"),
    ("write_file", "path, content", "Crear o reemplazar un archivo entero"),
    ("edit_file", "path, old_text, new_text", "Sustituir un fragmento exacto de un archivo"),
    ("append_file", "path, content", "Añadir texto al final de un archivo"),
    ("mkdir", "path", "Crear una carpeta"),
    ("delete_file", "path", "Eliminar un archivo"),
    ("rename_file", "src, dst", "Mover o renombrar un archivo"),
    ("run_command", "command, timeout?", "Ejecutar un comando de shell en el workspace"),
]

# Definiciones de funciones en formato OpenAI para tool-calling NATIVO. El
# gateway (ChatCompletionRequest.tools) las reenvía tal cual a Ollama, que las
# inyecta en el template del modelo. Deben coincidir con execute_tool_call().
def _p(kind: str, description: str) -> dict:
    return {"type": kind, "description": description}


TOOL_SCHEMAS: list[dict] = [
    {"type": "function", "function": {
        "name": "list_files",
        "description": "Lista los archivos del workspace (o de una subcarpeta).",
        "parameters": {"type": "object", "properties": {
            "path": _p("string", 'Ruta relativa; "." para la raíz')}}}},
    {"type": "function", "function": {
        "name": "read_file",
        "description": "Lee el contenido de un archivo. Admite rango de líneas.",
        "parameters": {"type": "object", "properties": {
            "path": _p("string", "Ruta relativa del archivo"),
            "start_line": _p("integer", "Primera línea (1-based), opcional"),
            "end_line": _p("integer", "Última línea, opcional"),
        }, "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "search",
        "description": "Busca un texto EXACTO en los archivos del workspace (grep).",
        "parameters": {"type": "object", "properties": {
            "pattern": _p("string", "Texto a buscar"),
            "path": _p("string", 'Carpeta donde buscar; "." para todo el workspace'),
        }, "required": ["pattern"]}}},
    {"type": "function", "function": {
        "name": "write_file",
        "description": ("Crea un archivo con su contenido completo, creando las carpetas que falten. "
                        "Es la herramienta para crear archivos nuevos; para modificar uno existente "
                        "usa edit_file."),
        "parameters": {"type": "object", "properties": {
            "path": _p("string", "Ruta relativa del archivo"),
            "content": _p("string", "Contenido completo del archivo"),
        }, "required": ["path", "content"]}}},
    {"type": "function", "function": {
        "name": "edit_file",
        "description": ("Reemplaza un fragmento EXACTO de un archivo existente (edición parcial). "
                        "Preferir sobre write_file para modificar archivos ya creados."),
        "parameters": {"type": "object", "properties": {
            "path": _p("string", "Ruta relativa del archivo"),
            "old_text": _p("string", "Fragmento actual a reemplazar, copiado EXACTO (con su indentación)"),
            "new_text": _p("string", "Texto nuevo"),
            "all": _p("boolean", "Reemplazar todas las apariciones (por defecto solo la primera)"),
        }, "required": ["path", "old_text", "new_text"]}}},
    {"type": "function", "function": {
        "name": "append_file",
        "description": "Añade texto al final de un archivo (lo crea si no existe).",
        "parameters": {"type": "object", "properties": {
            "path": _p("string", "Ruta relativa del archivo"),
            "content": _p("string", "Texto a añadir"),
        }, "required": ["path", "content"]}}},
    {"type": "function", "function": {
        "name": "mkdir",
        "description": "Crea una carpeta (y las intermedias si faltan).",
        "parameters": {"type": "object", "properties": {
            "path": _p("string", "Ruta relativa de la carpeta")}, "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "delete_file",
        "description": "Elimina un archivo o carpeta.",
        "parameters": {"type": "object", "properties": {
            "path": _p("string", "Ruta relativa")}, "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "rename_file",
        "description": "Mueve o renombra un archivo.",
        "parameters": {"type": "object", "properties": {
            "src": _p("string", "Ruta origen"),
            "dst": _p("string", "Ruta destino"),
        }, "required": ["src", "dst"]}}},
    {"type": "function", "function": {
        "name": "run_command",
        "description": ("Ejecuta un comando de shell en el workspace: inicializar proyectos "
                        "(npm create, git init…), instalar dependencias, tests y builds."),
        "parameters": {"type": "object", "properties": {
            "command": _p("string", "Comando a ejecutar"),
            "timeout": _p("integer", "Segundos máximos (por defecto 30)"),
        }, "required": ["command"]}}},
]


def native_call_to_internal(call: dict) -> dict:
    """Convierte un tool_call nativo (formato OpenAI) al interno {tool, args}."""
    fn = call.get("function") or {}
    args = fn.get("arguments")
    if isinstance(args, str):
        try:
            args = json.loads(args or "{}")
        except Exception:
            args = {}
    return {"tool": fn.get("name", ""), "args": args if isinstance(args, dict) else {}}


def sanitize_for_plain_chat(messages: list[dict]) -> list[dict]:
    """Quita el round-trip de tools del historial para un chat normal.

    Los mensajes `role="tool"` solo son válidos justo detrás del assistant que
    los pidió; si el usuario pasa a modo ask (que recorta el historial) podrían
    quedar huérfanos y romper el template del modelo.
    """
    out = []
    for m in messages:
        if m.get("role") == "tool":
            continue
        if m.get("tool_calls"):
            m = {k: v for k, v in m.items() if k != "tool_calls"}
            if not (m.get("content") or "").strip():
                continue
        out.append(m)
    return out


# Recordatorio de una sola vez cuando el modelo "sugiere" código en el chat
# en vez de aplicarlo con herramientas (vicio típico de los modelos chicos).
NUDGE_PROMPT = (
    "Si ese código debía aplicarse a un archivo del workspace, hazlo AHORA con "
    '{"tool":"write_file","args":{"path":"...","content":"CONTENIDO COMPLETO"}} '
    '(JSON puro, sin ```). Si no había nada que aplicar, responde solo "OK".'
)

NATIVE_NUDGE_PROMPT = (
    "No escribas el código en el chat: aplícalo AHORA llamando a la herramienta "
    "write_file (o edit_file si el archivo ya existe), y usa run_command para los "
    'comandos. Si no había nada que aplicar, responde solo "OK".'
)

TRUNCATED_PROMPT = (
    "Tu respuesta anterior se CORTÓ a mitad porque el contenido era demasiado largo. "
    "NO reescribas el archivo entero con write_file. Usa edit_file para cambiar solo las "
    "secciones necesarias (old_text/new_text), en varios pasos pequeños si hace falta."
)

IGNORED_TREE_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build",
    "target", ".next", ".idea", ".vscode", ".mypy_cache", ".pytest_cache",
}
MAX_TREE_ENTRIES = 150


def workspace_tree(workspace: Path, max_entries: int = MAX_TREE_ENTRIES) -> str:
    """Listado compacto del workspace para el system prompt del agente.

    Da al modelo visión inmediata del proyecto sin que tenga que llamar
    list_files; se trunca para no comerse la ventana de contexto.
    """
    entries: list[str] = []
    truncated = False

    def walk(directory: Path, depth: int) -> None:
        nonlocal truncated
        if truncated or depth > 4:
            return
        try:
            items = sorted(directory.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except OSError:
            return
        for item in items:
            if len(entries) >= max_entries:
                truncated = True
                return
            rel = item.relative_to(workspace).as_posix()
            if item.is_dir():
                if item.name in IGNORED_TREE_DIRS:
                    continue
                entries.append(f"{rel}/")
                walk(item, depth + 1)
            else:
                entries.append(rel)

    walk(workspace, 1)
    if not entries:
        return "(workspace vacío)"
    tree = "\n".join(entries)
    if truncated:
        tree += "\n… (hay más archivos; usa list_files para explorar)"
    return tree


def build_native_system_prompt(workspace: Path) -> str:
    """Prompt para tool-calling NATIVO: las herramientas ya van en el template
    del modelo, así que aquí solo van las reglas de uso (describirlas otra vez
    confunde al modelo y le hace escribir JSON en el texto)."""
    return (
        "Eres un agente de código que trabaja DIRECTAMENTE sobre los archivos del usuario "
        "llamando a las herramientas que tienes disponibles.\n"
        f"Workspace: {workspace}\n"
        "Las rutas son siempre RELATIVAS al workspace.\n\n"
        "=== REGLAS ===\n"
        "1. Si el usuario pide crear, inicializar, modificar, arreglar, eliminar o ejecutar algo, "
        "LLAMA A LAS HERRAMIENTAS. Tú aplicas los cambios: el usuario no copia código a mano.\n"
        "2. NUNCA respondas con el código en un bloque ``` cuando lo que toca es escribirlo en "
        "un archivo: eso va en el argumento content de write_file.\n"
        "3. Para crear un proyecto: mkdir/write_file para los archivos, y run_command para los "
        "comandos de scaffolding, instalación o git.\n"
        "4. Para modificar un archivo que ya existe: primero read_file, luego edit_file con el "
        "fragmento exacto. write_file solo para archivos nuevos o reescrituras completas.\n"
        "5. Puedes llamar a varias herramientas seguidas; el resultado de cada una te llega antes "
        "del siguiente paso. Nunca inventes el resultado de una herramienta.\n"
        "6. Tras cambiar código, si hay tests o build, verifícalo con run_command y corrige si el "
        "EXIT es distinto de 0.\n"
        "7. Cuando ya no quede nada que hacer, responde con texto normal resumiendo lo hecho.\n\n"
        # Los modelos chicos (qwen2.5-coder:7b y similares) conocen el formato
        # pero se saltan los tags <tool_call>, y entonces Ollama devuelve la
        # llamada como texto plano. Repetir el formato aquí hace que al menos el
        # JSON salga bien formado: el CLI lo parsea igual desde el texto.
        "=== FORMATO DE LLAMADA ===\n"
        "Cada llamada va EXACTAMENTE así, sin ``` alrededor:\n"
        "<tool_call>\n"
        '{"name": "write_file", "arguments": {"path": "…", "content": "…"}}\n'
        "</tool_call>\n\n"
        "=== ARCHIVOS DEL WORKSPACE ===\n"
        f"{workspace_tree(workspace)}"
    )


def build_agent_system_prompt(workspace: Path) -> str:
    return (
        "Eres un agente de código experto que trabaja DIRECTAMENTE sobre los archivos del usuario.\n"
        f"Workspace: {workspace}\n"
        "Rutas siempre RELATIVAS al workspace.\n\n"
        "=== HERRAMIENTAS DISPONIBLES ===\n"
        "Para usar una herramienta escribe una línea que contenga SOLO su JSON:\n"
        '{"tool":"list_files","args":{"path":"."}}\n'
        '{"tool":"read_file","args":{"path":"archivo.txt"}}  (opcional: "start_line" y "end_line" para archivos grandes)\n'
        '{"tool":"edit_file","args":{"path":"archivo.txt","old_text":"fragmento EXACTO actual","new_text":"fragmento nuevo"}}\n'
        '{"tool":"write_file","args":{"path":"archivo.txt","content":"contenido completo"}}\n'
        '{"tool":"append_file","args":{"path":"archivo.txt","content":"texto nuevo al final"}}\n'
        '{"tool":"mkdir","args":{"path":"carpeta/subcarpeta"}}\n'
        '{"tool":"search","args":{"pattern":"texto a buscar","path":"."}}\n'
        '{"tool":"delete_file","args":{"path":"archivo.txt"}}\n'
        '{"tool":"rename_file","args":{"src":"viejo.txt","dst":"nuevo.txt"}}\n'
        '{"tool":"run_command","args":{"command":"npm install","timeout":60}}\n\n'
        "=== REGLAS OBLIGATORIAS ===\n"
        "1. Si el usuario pide crear, modificar, arreglar, eliminar o ejecutar algo, DEBES hacerlo "
        "con herramientas EN ESTA MISMA RESPUESTA. Tú ejecutas los cambios; el usuario no copia código.\n"
        "2. PROHIBIDO responder a una petición de cambio mostrando código en bloques ```: "
        "el código va DENTRO del JSON de edit_file o write_file.\n"
        "3. Emite el JSON puro de la herramienta, sin envolverlo en markdown.\n"
        "4. Para EDITAR o MEJORAR un archivo existente: primero read_file, luego edit_file con el fragmento exacto "
        "(old_text copiado tal cual, con su indentación). NUNCA reescribas un archivo grande entero con write_file: "
        "la salida se trunca y falla. write_file es SOLO para archivos nuevos. Haz varios edit_file pequeños si el cambio es amplio.\n"
        "5. Puedes encadenar varias herramientas en una misma respuesta.\n"
        "6. Los resultados te llegan como TOOL_RESULT. Úsalos para continuar; nunca los escribas tú.\n"
        "7. Tras cambiar código, si el proyecto tiene tests o build, verifica con run_command; "
        "si el resultado trae un error (EXIT distinto de 0), CORRIGE el archivo y vuelve a ejecutar hasta que pase.\n"
        "8. Cuando termines todas las acciones, responde SOLO con texto normal (sin JSON ni código) resumiendo lo que hiciste.\n\n"
        "=== EJEMPLO 1 (crear) ===\n"
        "Usuario: crea un script que imprima hola\n"
        'Asistente: {"tool":"write_file","args":{"path":"hola.py","content":"print(\'hola\')\\n"}}\n'
        "Usuario: TOOL_RESULT write_file: Archivo creado: hola.py (14 chars)\n"
        "Asistente: Listo: creé hola.py, que imprime «hola» al ejecutarlo.\n\n"
        "=== EJEMPLO 2 (editar) ===\n"
        "Usuario: renombra la variable x a total en utils.js\n"
        'Asistente: {"tool":"read_file","args":{"path":"utils.js"}}\n'
        "Usuario: TOOL_RESULT read_file: export const x = 1;\\nexport const y = x + 2;\n"
        'Asistente: {"tool":"edit_file","args":{"path":"utils.js","old_text":"export const x = 1;\\nexport const y = x + 2;","new_text":"export const total = 1;\\nexport const y = total + 2;"}}\n'
        "Usuario: TOOL_RESULT edit_file: Archivo editado: utils.js (1 reemplazo)\n"
        "Asistente: Hecho: renombré x a total en utils.js.\n\n"
        "=== ARCHIVOS DEL WORKSPACE ===\n"
        f"{workspace_tree(workspace)}\n\n"
        "=== RECUERDA ===\n"
        "Las peticiones de cambio se resuelven con herramientas, nunca mostrando código en el chat."
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


def tool_read_file(workspace: Path, rel_path: str, start_line: int = 0, end_line: int = 0) -> str:
    target = resolve_safe_path(workspace, rel_path)
    if not target.exists() or not target.is_file():
        return f"Archivo no encontrado: {rel_path}"
    content = target.read_text(encoding="utf-8", errors="replace")
    if start_line or end_line:
        lines = content.split("\n")
        s = max(1, int(start_line or 1))
        e = min(len(lines), int(end_line or len(lines)))
        return f"(líneas {s}-{e} de {len(lines)})\n" + "\n".join(lines[s - 1:e])
    if len(content) > 120000:
        total = content.count("\n") + 1
        return (f"(archivo grande: {total} líneas; pide rangos con start_line/end_line)\n"
                + content[:120000])
    return content


def tool_edit_file(workspace: Path, rel_path: str, old_text: str, new_text: str,
                   replace_all: bool = False) -> str:
    """Edición parcial estilo Cursor/Claude Code: reemplazo EXACTO de un
    fragmento. Evita reescribir archivos enteros (donde los modelos truncan)."""
    target = resolve_safe_path(workspace, rel_path)
    if not target.is_file():
        return f"Archivo no encontrado: {rel_path}"
    if not old_text:
        return "[ERROR] Falta old_text (el fragmento exacto a reemplazar)"
    content = target.read_text(encoding="utf-8", errors="replace")
    count = content.count(old_text)
    if count == 0:
        return (f"[ERROR] No se encontró old_text en {rel_path}. Debe coincidir EXACTO "
                "(espacios e indentación incluidos); usa read_file y copia el fragmento tal cual")
    if count > 1 and not replace_all:
        return (f"[ERROR] old_text aparece {count} veces en {rel_path}; añade más líneas de "
                'contexto para que sea único, o pasa "all":true para reemplazar todas')
    updated = content.replace(old_text, new_text) if replace_all else content.replace(old_text, new_text, 1)
    target.write_text(updated, encoding="utf-8")
    return f"Archivo editado: {rel_path} ({count} reemplazo{'s' if count > 1 else ''})"


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
        return tool_read_file(workspace, args.get("path", ""),
                              int(args.get("start_line") or 0), int(args.get("end_line") or 0))
    if tool_name == "write_file":
        return tool_write_file(workspace, args.get("path", ""), args.get("content", ""))
    if tool_name == "edit_file":
        return tool_edit_file(workspace, args.get("path", ""), args.get("old_text", ""),
                              args.get("new_text", ""), bool(args.get("all")))
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
    """Normaliza a {tool, args}. Acepta nuestro formato {tool,args} y el de
    función de OpenAI {name,arguments} (que emiten modelos primados con tools,
    p.ej. qwen2.5-coder). Devuelve None si no parece una llamada."""
    if not isinstance(data, dict):
        return None
    if data.get("tool"):
        args = data.get("args")
        return {"tool": data["tool"], "args": args if isinstance(args, dict) else {}}
    # {name, arguments}: solo con arguments presente (evita falsos positivos)
    if data.get("name") and data.get("arguments") is not None:
        args = data["arguments"]
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                args = {}
        return {"tool": data["name"], "args": args if isinstance(args, dict) else {}}
    return None


# `{` + cualquier espacio + `"tool"` (nuestro formato) o `"name"` (formato
# función de OpenAI). Los modelos suelen indentar el JSON ({\n  "tool": …).
_TOOL_START = re.compile(r'\{\s*"(tool|name)"')


def _scan_object(text: str, start: int) -> int:
    """Fin (exclusivo) del objeto que empieza en `start`, o -1 si no cierra.

    Cuenta llaves ignorando las que van dentro de un string. Reconoce strings
    con comilla doble Y simple: los modelos chicos escriben los argumentos al
    estilo Python ('…'), y con esas comillas sin reconocer el conteo se
    desbalancea y la llamada se pierde entera.
    """
    depth = 0
    quote = ""  # comilla que abrió el string actual ("" = fuera de string)
    escape_next = False
    for j in range(start, len(text)):
        ch = text[j]
        if escape_next:
            escape_next = False
        elif quote:
            if ch == "\\":
                escape_next = True
            elif ch == quote:
                quote = ""
        elif ch in ('"', "'"):
            quote = ch
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return j + 1
    return -1


def _quotes_to_json(text: str) -> str:
    """Convierte los strings 'a la Python' del candidato en strings JSON.

    qwen2.5-coder y otros modelos chicos emiten
    `{"name": "write_file", "arguments": {"content": '…'}}`: JSON inválido, así
    que la llamada se descartaba en silencio y el archivo nunca se escribía.
    Los escapes ya presentes (\\n, \\t…) se conservan tal cual; las comillas
    dobles y los saltos reales de dentro se escapan.
    """
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == '"':  # string JSON legítimo: copiar tal cual
            j = i + 1
            while j < n:
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == '"':
                    break
                j += 1
            out.append(text[i:min(j + 1, n)])
            i = j + 1
            continue
        if ch == "'":  # string estilo Python: reescribir con comilla doble
            buf: list[str] = []
            j = i + 1
            while j < n:
                c = text[j]
                if c == "\\":
                    nxt = text[j + 1] if j + 1 < n else ""
                    buf.append('\\"' if nxt == "'" else text[j:j + 2])
                    j += 2
                    continue
                if c == "'":
                    break
                buf.append({'"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t"}.get(c, c))
                j += 1
            out.append('"' + "".join(buf) + '"')
            i = j + 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _loads_lenient(candidate: str):
    """json.loads tolerante con lo que producen los modelos chicos.

    strict=False acepta saltos de línea reales dentro de los strings; si aun
    así falla, se prueba con las comillas normalizadas.
    """
    try:
        return json.loads(candidate, strict=False)
    except Exception:
        return json.loads(_quotes_to_json(candidate), strict=False)


def _iter_tool_call_spans(text: str) -> list[tuple[dict, int, int]]:
    """Localiza los JSON `{"tool":...}` embebidos: (call, inicio, fin_exclusivo).

    Cuenta llaves para soportar JSON anidado (write_file con content largo).
    """
    results = []
    i = 0
    while i < len(text):
        m = _TOOL_START.search(text, i)
        if not m:
            break
        start = m.start()
        end = _scan_object(text, start)
        if end == -1:  # objeto sin cerrar: no hay más llamadas completas
            break
        try:
            data = _validate_tool_dict(_loads_lenient(text[start:end]))
            if data:
                results.append((data, start, end))
        except Exception:
            pass
        i = end
    return results


def extract_all_tool_calls(text: str) -> list[dict]:
    """Extrae todos los JSON `{"tool":...}` embebidos en texto mixto."""
    return [call for call, _, _ in _iter_tool_call_spans(text)]


def strip_tool_calls(text: str) -> str:
    """Quita los JSON de herramientas del texto para mostrar solo la prosa.

    Corta por posición (no por re-serialización): el JSON del modelo rara vez
    coincide byte a byte con json.dumps.
    """
    for _, start, end in reversed(_iter_tool_call_spans(text)):
        text = text[:start] + text[end:]
    return text


def truncate_fabricated(text: str) -> str:
    """Corta donde el modelo fabrica un "TOOL_RESULT …" (se contesta a sí
    mismo imitando el ejemplo del prompt): lo posterior es alucinado."""
    idx = text.find("TOOL_RESULT")
    if idx == -1:
        return text
    line_start = text.rfind("\n", 0, idx)
    return text[: idx if line_start == -1 else line_start]


def cut_unclosed_call(text: str) -> str:
    """Corta un tool-call JSON iniciado pero SIN CERRAR al final (salida
    truncada al reescribir un archivo grande): evita filtrar JSON crudo."""
    starts = [m.start() for m in _TOOL_START.finditer(text)]
    if not starts:
        return text
    last = starts[-1]
    return text if _scan_object(text, last) != -1 else text[:last]


def has_unclosed_call(text: str) -> bool:
    return len(cut_unclosed_call(text)) < len(text)


def clean_prose(text: str) -> str:
    """Prosa final mostrable: sin tool calls (completos ni truncados), sin
    TOOL_RESULT fabricados y sin las vallas de código vacías (```json```)."""
    text = cut_unclosed_call(strip_tool_calls(truncate_fabricated(text)))
    text = re.sub(r"```[\w-]*\s*```", "", text)
    return text.strip()


# ── Loop del agente ─────────────────────────────────────────────────────────

def _call_signature(call: dict) -> str:
    """Huella de una llamada para detectar que el modelo se repite."""
    return json.dumps({"t": call.get("tool", ""), "a": call.get("args", {})},
                      sort_keys=True, ensure_ascii=False)[:400]


def run_agent_turn(history: list[dict], workspace: Path, session: dict,
                   stream_assistant) -> tuple[str, list[dict]]:
    """Ejecuta un turno de agente con aprobación interactiva.

    - `session`: estado mutable con `auto_approve: bool`, `native_tools: bool`
      (este último lo apaga la app si el modelo no soporta tools nativas) y
      `context_window: int` (la ventana que se le pide a Ollama).
    - `stream_assistant(messages, tools) -> (texto, tool_calls_nativos)`: lo
      aporta la app; muestra el texto del modelo en vivo y devuelve la respuesta
      completa junto con los tool_calls estructurados que haya emitido.
    Devuelve (respuesta_final, history_actualizado).

    El turno solo termina cuando el modelo deja de pedir herramientas, cuando se
    detecta que está atascado o cuando se agota el tope de pasos — y en los dos
    últimos casos lo dice. Nunca se queda callado a mitad de trabajo.
    """
    console = make_console()
    working = history[:]
    window = int(session.get("context_window") or 8192)

    nudged = False
    empty_retries = 0     # respuestas vacías consecutivas ya reintentadas
    last_signature = ""   # última tanda de llamadas, para detectar bucles
    repeated = 0
    pruned_warned = False

    for step in range(MAX_AGENT_STEPS):
        # El flag puede apagarse a mitad de turno (fallback si el modelo no
        # soporta tools), así que se relee en cada paso.
        native = session.get("native_tools", True)
        system_msg = {"role": "system", "content": (
            build_native_system_prompt(workspace) if native
            else build_agent_system_prompt(workspace))}
        tools = TOOL_SCHEMAS if native else None

        body = working if native else sanitize_for_plain_chat(working)
        # El prompt tiene que caber en la ventana CON el system prompt y las
        # definiciones de herramientas dentro: si se pasa, Ollama descarta el
        # principio (justo esos dos) y el modelo responde vacío. Podar aquí es
        # lo que impide que el agente se congele a los pocos minutos.
        budget = prompt_budget(window, tools, estimate_tokens([system_msg]))
        body, pruned = fit_history(body, budget)
        if pruned and not pruned_warned:
            pruned_warned = True
            print_note("La conversación llenaba la ventana de contexto: se han "
                       "recortado los pasos más antiguos para poder seguir.")

        messages = [system_msg] + body
        raw, native_calls = stream_assistant(messages, tools)
        # Sin el corte, el modelo "ejecutaría" resultados que él mismo inventó
        assistant = truncate_fabricated(raw)

        if native_calls:
            empty_retries = 0
            signature = "|".join(_call_signature(native_call_to_internal(c)) for c in native_calls)
            repeated = repeated + 1 if signature == last_signature else 0
            last_signature = signature
            if repeated >= MAX_REPEATED_CALLS:
                return ("Me estaba repitiendo con la misma acción sin avanzar, así que "
                        "he parado. Dime cómo seguir."), working
            working.append({"role": "assistant", "content": assistant, "tool_calls": native_calls})
            for call in native_calls:
                internal = native_call_to_internal(call)
                tool_name = internal["tool"]
                result = _approve_and_run(console, workspace, session, tool_name, internal["args"])
                working.append({
                    "role": "tool",
                    # Al modelo le va una versión acotada del resultado; el
                    # usuario ha visto la salida completa en pantalla. Un
                    # read_file de 100 000 caracteres desbordaba la ventana él solo.
                    "content": clip_tool_output(result),
                    "tool_call_id": str(call.get("id") or ""),
                    "name": tool_name,
                })
            continue

        tool_calls = extract_all_tool_calls(assistant)

        if not tool_calls and not assistant.strip():
            # Respuesta vacía: casi siempre es el prompt desbordando la ventana
            # (Ollama recorta por delante y el modelo se queda sin instrucciones).
            # Se poda a la mitad del presupuesto y se reintenta antes de rendirse.
            if empty_retries < 2:
                empty_retries += 1
                working, _ = fit_history(working, budget // 2)
                print_note("El modelo devolvió una respuesta vacía; libero contexto "
                           "y lo reintento.")
                continue
            return ("Me quedé sin respuesta del modelo (probablemente por contexto lleno). "
                    "Usa /compact o /new y vuelve a pedírmelo."), working
        empty_retries = 0

        working.append({"role": "assistant", "content": assistant})

        if not tool_calls:
            if not nudged and has_unclosed_call(assistant):
                # Salida truncada a mitad de un tool-call: empujar a edit_file
                nudged = True
                working.append({"role": "user", "content": TRUNCATED_PROMPT})
                continue
            if not nudged and "```" in assistant:
                # Mostró código en vez de aplicarlo: una oportunidad de corregirse
                nudged = True
                working.append({"role": "user",
                                "content": NATIVE_NUDGE_PROMPT if native else NUDGE_PROMPT})
                continue
            return assistant, working

        signature = "|".join(_call_signature(c) for c in tool_calls)
        repeated = repeated + 1 if signature == last_signature else 0
        last_signature = signature
        if repeated >= MAX_REPEATED_CALLS:
            return ("Me estaba repitiendo con la misma acción sin avanzar, así que "
                    "he parado. Dime cómo seguir."), working

        combined_results = []
        for call in tool_calls:
            tool_name = call.get("tool", "")
            args = call.get("args", {})
            result = _approve_and_run(console, workspace, session, tool_name, args)
            combined_results.append(f"TOOL_RESULT {tool_name}: {clip_tool_output(result)}")

        working.append({"role": "user", "content": "\n".join(combined_results)})

    return (f"He llegado al tope de {MAX_AGENT_STEPS} pasos en un mismo turno y paro aquí "
            "para no seguir a ciegas. Dime «continúa» si quieres que siga desde donde iba."), working


def _approve_and_run(console, workspace: Path, session: dict, tool_name: str, args: dict) -> str:
    # Con /remote activo, la sesión se maneja desde el móvil/web: los eventos
    # de herramientas viajan al controller y las aprobaciones se piden allí
    # (localmente no hay nadie al teclado durante el takeover).
    remote = session.get("remote")

    if tool_name in READ_ONLY_TOOLS:
        # Solo lectura: se ejecuta sin preguntar, con rastro discreto.
        label = args.get("path") or args.get("pattern") or "."
        render_action(console, TOOL_VERB.get(tool_name, tool_name), str(label), readonly=True)
        if remote:
            remote.emit("tool_use", tool=tool_name, summary=str(label), readonly=True)
        return _run(console, workspace, tool_name, args, remote)

    try:
        change = compute_change(workspace, tool_name, args, resolve_safe_path)
    except Exception:
        change = None
    if change is not None:
        render_change(console, change)
    else:
        render_action(console, TOOL_VERB.get(tool_name, tool_name), _args_summary(tool_name, args))
    if remote:
        remote.emit("tool_use", tool=tool_name, summary=_args_summary(tool_name, args), readonly=False)

    # Los comandos de shell son irreversibles (sin snapshot que los deshaga):
    # tienen su propio flag y NO los cubre auto_approve. Así, responder
    # "siempre" tras una edición de archivo no habilita ejecutar comandos.
    if tool_name == "run_command":
        if not session.get("auto_run_commands"):
            if remote:
                if remote.request_approval(tool_name, _args_summary(tool_name, args), "command") != "allow":
                    render_action_result(console, "rechazado desde el control remoto", error=True)
                    return "Ejecución cancelada por el usuario"
            else:
                decision = confirm3("¿Ejecutar este comando?")
                if decision == "always":
                    session["auto_run_commands"] = True
                elif decision in ("no", None):
                    render_action_result(console, "rechazado por el usuario", error=True)
                    return "Ejecución cancelada por el usuario"
    elif not session.get("auto_approve"):
        if remote:
            if remote.request_approval(tool_name, _args_summary(tool_name, args), "edit") != "allow":
                render_action_result(console, "rechazado desde el control remoto", error=True)
                return "Ejecución cancelada por el usuario"
        else:
            decision = confirm3("¿Aplicar este cambio?")
            if decision == "always":
                session["auto_approve"] = True
            elif decision in ("no", None):
                render_action_result(console, "rechazado por el usuario", error=True)
                return "Ejecución cancelada por el usuario"

    return _run(console, workspace, tool_name, args, remote)


def _run(console, workspace: Path, tool_name: str, args: dict, remote=None) -> str:
    try:
        result = execute_tool_call(workspace, tool_name, args)
    except Exception as exc:
        result = f"[ERROR] {exc}"
    failed = (result.startswith("[ERROR]") or result.startswith("[TIMEOUT]")
              or (result.startswith("[EXIT ") and not result.startswith("[EXIT 0]")))
    if tool_name not in READ_ONLY_TOOLS or failed:
        render_action_result(console, result.split("\n", 1)[0][:120], error=failed)
    if remote:
        remote.emit("tool_result", tool=tool_name,
                    result=result[:REMOTE_RESULT_CHARS], error=failed)
    return result
