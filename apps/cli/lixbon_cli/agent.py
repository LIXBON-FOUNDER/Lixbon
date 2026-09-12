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
import threading
import time
from pathlib import Path

from lixbon_cli.checks import verify_file
from lixbon_cli.context import (
    clip_tool_output,
    compact_messages,
    estimate_tokens,
    fit_history,
    needs_compaction,
    prompt_budget,
    shrink_old_results,
)
from lixbon_cli.diffs import compute_change, render_change
from lixbon_cli.documents import (
    describe_image,
    docx_text,
    fmt_size,
    html_to_text,
    is_binary,
    is_docx,
    is_image,
    is_pdf,
    pdf_text,
)
from lixbon_cli.remote import REMOTE_RESULT_CHARS, _args_summary
from lixbon_cli.term import g
from lixbon_cli.theme import make_console
from lixbon_cli.ui import (
    confirm_command,
    TOOL_VERB,
    VERB_WIDTH,
    confirm3,
    print_note,
    render_action,
    render_action_result,
    render_log_line,
)

# Tope de pasos por turno. Es un cortafuegos contra bucles, NO un presupuesto de
# trabajo: una tarea real (leer varios archivos, editarlos, ejecutar los tests y
# corregir) se come 12 pasos enseguida, y antes el turno moría ahí sin decir
# nada. Ahora hay margen de sobra y, si se alcanza, se dice por qué.
MAX_AGENT_STEPS = 40

# Llamadas idénticas seguidas que se toleran antes de romper el bucle: un modelo
# atascado repite la misma herramienta con los mismos argumentos indefinidamente.
MAX_REPEATED_CALLS = 3

READ_ONLY_TOOLS = {"list_files", "find_files", "read_file", "outline", "search", "fetch_url",
                   "web_search", "read_output", "stop_command", "todo", "ask_user"}
MUTATING_TOOLS = {"write_file", "edit_file", "multi_edit", "insert_at_line", "append_file",
                  "delete_file", "rename_file"}
EDIT_TOOLS = {"write_file", "edit_file", "multi_edit", "insert_at_line", "append_file"}

# Tope de líneas que devuelve una búsqueda o un listado: por encima el modelo
# no lee nada útil y solo gasta contexto.
MAX_RESULT_LINES = 300

# Catálogo legible de lo que el agente puede hacer (lo muestra /tools). Es la
# misma lista que se le describe al modelo en el system prompt, escrita para
# personas: quien usa el CLI necesita saber qué puede tocar el agente.
TOOL_SPECS: list[tuple[str, str, str]] = [
    ("list_files", "path, recursive?", "Listar el contenido de una carpeta"),
    ("find_files", "pattern", "Buscar archivos por nombre o patrón glob"),
    ("read_file", "path, start_line?, end_line?", "Leer un archivo, PDF, Word o imagen"),
    ("outline", "path", "Funciones, clases y secciones de un archivo con su línea"),
    ("search", "pattern, path?, glob?, ignore_case?, regex?", "Buscar texto en el workspace"),
    ("write_file", "path, content", "Crear o reemplazar un archivo entero"),
    ("edit_file", "path, old_text, new_text", "Sustituir un fragmento exacto de un archivo"),
    ("multi_edit", "path, edits", "Varias sustituciones en un archivo, en una llamada"),
    ("insert_at_line", "path, line, content", "Insertar texto antes de una línea"),
    ("append_file", "path, content", "Añadir texto al final de un archivo"),
    ("mkdir", "path", "Crear una carpeta"),
    ("delete_file", "path", "Eliminar un archivo"),
    ("rename_file", "src, dst", "Mover o renombrar un archivo"),
    ("run_command", "command, timeout?, background?", "Ejecutar un comando de shell en el workspace"),
    ("read_output", "id, wait?", "Leer la salida nueva de un comando en segundo plano"),
    ("stop_command", "id", "Detener un comando en segundo plano"),
    ("fetch_url", "url", "Descargar una página web como texto"),
    ("web_search", "query, limit?", "Buscar en internet (vía el gateway)"),
    ("todo", "items", "Lista de pasos del turno (pendiente / en curso / hecho)"),
    ("ask_user", "question, options?", "Preguntar al usuario antes de seguir"),
]

# Definiciones de funciones en formato OpenAI para tool-calling NATIVO. El
# gateway (ChatCompletionRequest.tools) las reenvía tal cual a Ollama, que las
# inyecta en el template del modelo. Deben coincidir con execute_tool_call().
def _p(kind: str, description: str) -> dict:
    return {"type": kind, "description": description}


TOOL_SCHEMAS: list[dict] = [
    {"type": "function", "function": {
        "name": "list_files",
        "description": "Lista una carpeta del workspace con tamaños; con recursive ve el árbol completo.",
        "parameters": {"type": "object", "properties": {
            "path": _p("string", 'Ruta relativa; "." para la raíz'),
            "recursive": _p("boolean", "Incluir subcarpetas (por defecto no)"),
        }}}},
    {"type": "function", "function": {
        "name": "find_files",
        "description": "Busca archivos por nombre con un patrón glob: '*.py', 'test_*', 'src/**/*.jsx'.",
        "parameters": {"type": "object", "properties": {
            "pattern": _p("string", "Patrón glob del nombre o de la ruta relativa"),
        }, "required": ["pattern"]}}},
    {"type": "function", "function": {
        "name": "read_file",
        "description": "Lee el contenido de un archivo. Admite rango de líneas. "
                       "Un PDF o .docx devuelve su texto; una imagen (png/jpg/webp) "
                       "se te adjunta para que la veas.",
        "parameters": {"type": "object", "properties": {
            "path": _p("string", "Ruta relativa del archivo"),
            "start_line": _p("integer", "Primera línea (1-based), opcional"),
            "end_line": _p("integer", "Última línea, opcional"),
        }, "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "outline",
        "description": ("Esqueleto de un archivo: funciones, clases, métodos y encabezados con su "
                        "número de línea. Úsalo antes de read_file en archivos grandes para leer "
                        "solo el rango que importa."),
        "parameters": {"type": "object", "properties": {
            "path": _p("string", "Ruta relativa del archivo"),
        }, "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "search",
        "description": "Busca texto en los archivos del workspace (grep): devuelve archivo:línea:contenido.",
        "parameters": {"type": "object", "properties": {
            "pattern": _p("string", "Texto a buscar (literal, salvo regex=true)"),
            "path": _p("string", 'Carpeta o archivo donde buscar; "." para todo el workspace'),
            "glob": _p("string", "Solo archivos que cumplan el patrón, p. ej. '*.py'"),
            "ignore_case": _p("boolean", "Ignorar mayúsculas/minúsculas"),
            "regex": _p("boolean", "Interpretar pattern como expresión regular"),
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
        "name": "multi_edit",
        "description": ("Varias sustituciones EXACTAS en un mismo archivo, en orden. Preferir a "
                        "varios edit_file seguidos cuando el cambio toca varios sitios del archivo."),
        "parameters": {"type": "object", "properties": {
            "path": _p("string", "Ruta relativa del archivo"),
            "edits": {"type": "array", "description": "Sustituciones en orden", "items": {
                "type": "object", "properties": {
                    "old_text": _p("string", "Fragmento actual, copiado exacto"),
                    "new_text": _p("string", "Texto nuevo"),
                }, "required": ["old_text", "new_text"]}},
        }, "required": ["path", "edits"]}}},
    {"type": "function", "function": {
        "name": "insert_at_line",
        "description": "Inserta texto ANTES de la línea indicada (1-based). line=0 o mayor que el total: al final.",
        "parameters": {"type": "object", "properties": {
            "path": _p("string", "Ruta relativa del archivo"),
            "line": _p("integer", "Número de línea delante de la cual insertar"),
            "content": _p("string", "Texto a insertar (con sus saltos de línea)"),
        }, "required": ["path", "line", "content"]}}},
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
                        "(npm create, git init…), instalar dependencias, tests y builds. "
                        "Con background=true arranca un proceso largo (servidor de desarrollo, "
                        "watcher) y devuelve un id para read_output/stop_command."),
        "parameters": {"type": "object", "properties": {
            "command": _p("string", "Comando a ejecutar"),
            "timeout": _p("integer", "Segundos máximos (por defecto 30, tope 600)"),
            "background": _p("boolean", "No esperar: dejarlo corriendo y devolver un id"),
        }, "required": ["command"]}}},
    {"type": "function", "function": {
        "name": "read_output",
        "description": "Salida nueva (desde la última lectura) de un comando en segundo plano y si sigue vivo.",
        "parameters": {"type": "object", "properties": {
            "id": _p("string", "Id devuelto por run_command con background=true"),
            "wait": _p("integer", "Segundos a esperar antes de leer (por defecto 0, tope 60)"),
        }, "required": ["id"]}}},
    {"type": "function", "function": {
        "name": "stop_command",
        "description": "Detiene un comando en segundo plano (y sus procesos hijos).",
        "parameters": {"type": "object", "properties": {
            "id": _p("string", "Id del comando"),
        }, "required": ["id"]}}},
    {"type": "function", "function": {
        "name": "fetch_url",
        "description": "Descarga una página web (o un JSON/texto) y devuelve su contenido como texto.",
        "parameters": {"type": "object", "properties": {
            "url": _p("string", "URL http(s) completa"),
        }, "required": ["url"]}}},
    {"type": "function", "function": {
        "name": "web_search",
        "description": ("Busca en internet y devuelve título, URL y resumen de cada resultado. "
                        "Úsala para documentación, errores o datos que no estén en el workspace; "
                        "luego fetch_url para leer una página entera."),
        "parameters": {"type": "object", "properties": {
            "query": _p("string", "Consulta de búsqueda, concreta y en el idioma de la fuente"),
            "limit": _p("integer", "Resultados máximos (por defecto 5)"),
        }, "required": ["query"]}}},
    {"type": "function", "function": {
        "name": "todo",
        "description": ("Tu lista de pasos para la tarea actual. Llámala al empezar una tarea de "
                        "varios pasos y cada vez que completes uno (envía la lista completa "
                        "actualizada). El usuario la ve; te evita olvidar partes de la petición."),
        "parameters": {"type": "object", "properties": {
            "items": {"type": "array", "description": "Pasos en orden", "items": {
                "type": "object", "properties": {
                    "text": _p("string", "Qué hay que hacer"),
                    "status": {"type": "string", "enum": ["pending", "doing", "done"]},
                }, "required": ["text", "status"]}},
        }, "required": ["items"]}}},
    {"type": "function", "function": {
        "name": "ask_user",
        "description": ("Pregunta al usuario cuando la petición es ambigua o hay que elegir entre "
                        "alternativas que cambian el resultado. No la uses para confirmar cada paso."),
        "parameters": {"type": "object", "properties": {
            "question": _p("string", "Pregunta concreta"),
            "options": {"type": "array", "items": {"type": "string"},
                        "description": "Opciones cerradas (2 a 6); sin ellas la respuesta es texto libre"},
        }, "required": ["question"]}}},
]

PLAN_MODE_PROMPT = (
    "\n\n=== MODO PLAN ===\n"
    "Estás en modo plan: SOLO puedes leer, buscar y preguntar. No escribas, edites ni borres archivos "
    "ni ejecutes comandos. Explora lo necesario y termina con un plan numerado, concreto (archivos y "
    "cambios), para que el usuario lo apruebe. Cuando lo apruebe y salga del modo plan, ejecútalo."
)
TODO_PROMPT = (
    "\n\nPara peticiones con varios pasos, empieza llamando a `todo` con la lista de pasos y "
    "actualízala al completar cada uno. Si algo es ambiguo y cambia el resultado, usa `ask_user` "
    "antes de tocar archivos."
)


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

# Los modelos thinking a veces agotan el turno razonando y no llegan a emitir
# nada. Repetir la petición tal cual les hace volver a razonar lo mismo; pedir
# el paso CONCRETO y prohibir el preámbulo es lo que los desatasca.
NO_OUTPUT_PROMPT = (
    "Has razonado pero no has emitido ninguna respuesta ni ninguna llamada a "
    "herramienta. NO vuelvas a razonar: ejecuta AHORA el siguiente paso llamando "
    "a la herramienta que toque, o responde con el resumen final si ya no queda "
    "nada por hacer."
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
        '{"tool":"list_files","args":{"path":".","recursive":false}}\n'
        '{"tool":"find_files","args":{"pattern":"*.py"}}\n'
        '{"tool":"outline","args":{"path":"src/app.py"}}  (funciones y clases con su línea, para leer solo un rango)\n'
        '{"tool":"read_file","args":{"path":"archivo.txt"}}  (opcional: "start_line" y "end_line" para archivos grandes; '
        'un .pdf o .docx llega como texto y una imagen png/jpg/webp se te adjunta para que la veas)\n'
        '{"tool":"edit_file","args":{"path":"archivo.txt","old_text":"fragmento EXACTO actual","new_text":"fragmento nuevo"}}\n'
        '{"tool":"multi_edit","args":{"path":"archivo.txt","edits":[{"old_text":"a","new_text":"b"},{"old_text":"c","new_text":"d"}]}}\n'
        '{"tool":"insert_at_line","args":{"path":"archivo.txt","line":12,"content":"nueva línea\\n"}}\n'
        '{"tool":"write_file","args":{"path":"archivo.txt","content":"contenido completo"}}\n'
        '{"tool":"append_file","args":{"path":"archivo.txt","content":"texto nuevo al final"}}\n'
        '{"tool":"mkdir","args":{"path":"carpeta/subcarpeta"}}\n'
        '{"tool":"search","args":{"pattern":"texto a buscar","path":".","glob":"*.js","ignore_case":true}}\n'
        '{"tool":"delete_file","args":{"path":"archivo.txt"}}\n'
        '{"tool":"rename_file","args":{"src":"viejo.txt","dst":"nuevo.txt"}}\n'
        '{"tool":"run_command","args":{"command":"npm install","timeout":60}}  (con "background":true devuelve un id; '
        'luego {"tool":"read_output","args":{"id":"p1","wait":5}} y {"tool":"stop_command","args":{"id":"p1"}})\n'
        '{"tool":"web_search","args":{"query":"fastapi lifespan deprecated on_event","limit":5}}\n'
        '{"tool":"fetch_url","args":{"url":"https://ejemplo.com/docs"}}\n'
        '{"tool":"todo","args":{"items":[{"text":"leer app.py","status":"done"},{"text":"añadir la ruta","status":"doing"}]}}\n'
        '{"tool":"ask_user","args":{"question":"¿SQLite o Postgres?","options":["SQLite","Postgres"]}}\n\n'
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


def _cap_lines(lines: list[str], total: int | None = None) -> str:
    total = len(lines) if total is None else total
    if total > MAX_RESULT_LINES:
        return "\n".join(lines[:MAX_RESULT_LINES]) + f"\n…[{total - MAX_RESULT_LINES} líneas más]"
    return "\n".join(lines)


def _sorted_entries(directory: Path) -> list[Path]:
    try:
        return sorted(directory.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    except OSError:
        return []


def tool_list_files(workspace: Path, rel_path: str = ".", recursive: bool = False) -> str:
    target = resolve_safe_path(workspace, rel_path)
    if not target.exists():
        return f"No existe: {rel_path}"
    if target.is_file():
        return f"[F] {target.relative_to(workspace).as_posix()} ({fmt_size(target.stat().st_size)})"
    lines: list[str] = []

    def walk(directory: Path, depth: int) -> None:
        for p in _sorted_entries(directory):
            if len(lines) > MAX_RESULT_LINES:
                return
            rel = p.relative_to(workspace).as_posix()
            if p.is_dir():
                if p.name in IGNORED_TREE_DIRS:
                    lines.append(f"[D] {rel}/ (omitida)")
                    continue
                lines.append(f"[D] {rel}/ ({len(_sorted_entries(p))} entradas)")
                if recursive and depth < 6:
                    walk(p, depth + 1)
            else:
                try:
                    lines.append(f"[F] {rel} ({fmt_size(p.stat().st_size)})")
                except OSError:
                    lines.append(f"[F] {rel}")

    walk(target, 1)
    return _cap_lines(lines) if lines else "(vacío)"


_OUTLINE_PATTERNS = {
    ".py": [re.compile(r"^(\s*)(?:async\s+)?(?:def|class)\s+\w+.*?(?::|$)")],
    ".js": [re.compile(r"^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+\w+|class\s+\w+).*"),
            re.compile(r"^(\s*)(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>.*"),
            re.compile(r"^(\s{2,})(?:static\s+|async\s+)*\w+\s*\([^)]*\)\s*\{\s*$")],
    ".go": [re.compile(r"^(\s*)(?:func|type)\s+.*")],
    ".rs": [re.compile(r"^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod)\s+.*")],
    ".java": [re.compile(r"^(\s*)(?:public|private|protected|static|final|abstract|\s)*\s*(?:class|interface|enum|record)\s+\w+.*"),
              re.compile(r"^(\s{2,})(?:public|private|protected|static|final|synchronized|\s)+[\w<>\[\],\s]+\s+\w+\s*\([^)]*\)\s*(?:throws[^{]*)?\{?\s*$")],
    ".md": [re.compile(r"^(#{1,6})\s+.*")],
    ".css": [re.compile(r"^(\s*)[^\s{}/][^{}]*\{\s*$")],
}
for _ext in (".jsx", ".ts", ".tsx", ".mjs", ".cjs"):
    _OUTLINE_PATTERNS[_ext] = _OUTLINE_PATTERNS[".js"]
for _ext in (".kt", ".cs", ".scala"):
    _OUTLINE_PATTERNS[_ext] = _OUTLINE_PATTERNS[".java"]


def tool_outline(workspace: Path, rel_path: str) -> str:
    target = resolve_safe_path(workspace, rel_path)
    if not target.is_file():
        return f"Archivo no encontrado: {rel_path}"
    patterns = _OUTLINE_PATTERNS.get(target.suffix.lower())
    if not patterns:
        return f"(sin esqueleto para {target.suffix or 'este tipo'}; usa read_file)"
    lines: list[str] = []
    total = 0
    for total, line in enumerate(target.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        if any(p.match(line) for p in patterns):
            lines.append(f"{total:>5}  {line.rstrip()[:140]}")
    if not lines:
        return f"(sin funciones ni clases reconocibles en {total} líneas)"
    return f"{rel_path}: {total} líneas\n" + _cap_lines(lines)


def render_todo(console, items: list[dict]) -> None:
    marks = {"done": g("check"), "doing": g("arrow"), "pending": g("dot_empty")}
    styles = {"done": "lx.dim2", "doing": "lx.primary", "pending": "lx.dim"}
    for item in items:
        status = item.get("status", "pending")
        render_log_line(console, f"{marks.get(status, '?')} {item.get('text', '')}", styles.get(status, "lx.dim"))


def tool_todo(session: dict, console, items) -> str:
    if not isinstance(items, list):
        return "[ERROR] items debe ser una lista de {text, status}"
    limpios = []
    for it in items[:30]:
        if isinstance(it, str):
            it = {"text": it, "status": "pending"}
        if not isinstance(it, dict) or not str(it.get("text", "")).strip():
            continue
        status = str(it.get("status", "pending")).lower()
        limpios.append({"text": str(it["text"]).strip()[:200],
                        "status": status if status in ("pending", "doing", "done") else "pending"})
    session["todo"] = limpios
    render_todo(console, limpios)
    hechos = sum(1 for it in limpios if it["status"] == "done")
    return f"Lista actualizada: {hechos}/{len(limpios)} hechos.\n" + "\n".join(
        f"[{it['status']}] {it['text']}" for it in limpios)


def tool_ask_user(session: dict, question: str, options) -> str:
    preguntar = session.get("ask_user")
    if preguntar is None or session.get("remote"):
        return ("[ask_user no disponible en esta sesión] Termina el turno formulando la pregunta al "
                "usuario en tu respuesta y espera su mensaje.")
    question = str(question or "").strip()
    if not question:
        return "[ERROR] Falta question"
    opciones = [str(o).strip() for o in (options or []) if str(o).strip()][:6]
    respuesta = preguntar(question, opciones)
    if respuesta is None:
        return "El usuario no respondió (canceló). Sigue con tu mejor criterio o termina el turno."
    return f"Respuesta del usuario: {respuesta}"


def tool_find_files(workspace: Path, pattern: str) -> str:
    pattern = (pattern or "").strip().replace("\\", "/")
    if not pattern:
        return "[ERROR] Falta pattern"
    if "/" not in pattern:
        pattern = f"**/{pattern}"
    hits: list[str] = []
    for p in workspace.glob(pattern):
        rel = p.relative_to(workspace)
        if any(part in IGNORED_TREE_DIRS for part in rel.parts):
            continue
        hits.append(rel.as_posix() + ("/" if p.is_dir() else ""))
        if len(hits) > MAX_RESULT_LINES:
            break
    hits.sort()
    return _cap_lines(hits) if hits else "(sin resultados)"


def tool_read_file(workspace: Path, rel_path: str, start_line: int = 0, end_line: int = 0) -> str:
    target = resolve_safe_path(workspace, rel_path)
    if not target.exists() or not target.is_file():
        return f"Archivo no encontrado: {rel_path}"
    if is_image(target):
        return describe_image(target)
    if is_pdf(target):
        content = pdf_text(target)
    elif is_docx(target):
        content = docx_text(target)
    elif is_binary(target):
        return (f"[binario] {target.name} ({fmt_size(target.stat().st_size)}): no es texto ni un "
                "formato que sepa leer (pdf, docx, png/jpg/webp).")
    else:
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
    # newline="" conserva los CRLF: el archivo se reescribe con sus finales de línea.
    with target.open(encoding="utf-8", errors="replace", newline="") as f:
        content = f.read()
    count = content.count(old_text)
    if count == 0:
        return _edit_loose(target, rel_path, content, old_text, new_text)
    if count > 1 and not replace_all:
        return (f"[ERROR] old_text aparece {count} veces en {rel_path}; añade más líneas de "
                'contexto para que sea único, o pasa "all":true para reemplazar todas')
    line = content[:content.index(old_text)].count("\n") + 1
    updated = content.replace(old_text, new_text) if replace_all else content.replace(old_text, new_text, 1)
    target.write_text(updated, encoding="utf-8", newline="")
    donde = f"{count} reemplazos" if count > 1 else f"1 reemplazo en la línea {line}"
    return f"Archivo editado: {rel_path} ({donde})"


def _leading_ws(line: str) -> str:
    return line[:len(line) - len(line.lstrip())]


def _find_block(lines: list[str], wanted: list[str], key) -> list[int]:
    n = len(wanted)
    target = [key(w) for w in wanted]
    return [i for i in range(len(lines) - n + 1) if [key(l) for l in lines[i:i + n]] == target]


def _edit_loose(target: Path, rel_path: str, content: str, old_text: str, new_text: str) -> str:
    """old_text no coincide byte a byte: los modelos chicos pierden espacios
    finales o copian el bloque con otra indentación. Se acepta si, ignorando
    eso, el bloque es único; new_text hereda la indentación real del archivo."""
    lines = content.split("\n")
    old_lines = old_text.strip("\n").split("\n")
    new_lines = new_text.split("\n")
    for key, reindent in ((str.rstrip, False), (str.strip, True)):
        hits = _find_block(lines, old_lines, key)
        if len(hits) > 1:
            return (f"[ERROR] old_text (salvo espacios) aparece {len(hits)} veces en {rel_path}; "
                    "añade más líneas de contexto para que sea único")
        if not hits:
            continue
        i = hits[0]
        if reindent:
            file_ws, old_ws = _leading_ws(lines[i]), _leading_ws(old_lines[0])
            new_lines = [file_ws + l[len(old_ws):] if l.startswith(old_ws) and l.strip() else l
                         for l in new_lines]
        if "\r\n" in content:
            new_lines = [l.rstrip("\r") + "\r" for l in new_lines]
        lines[i:i + len(old_lines)] = new_lines
        target.write_text("\n".join(lines), encoding="utf-8", newline="")
        return (f"Archivo editado: {rel_path} (1 reemplazo en la línea {i + 1}; old_text "
                "coincidió ignorando espacios e indentación)")
    return (f"[ERROR] No se encontró old_text en {rel_path}. Debe coincidir con el archivo "
            "(usa read_file y copia el fragmento tal cual, con sus líneas completas)")


def tool_multi_edit(workspace: Path, rel_path: str, edits) -> str:
    if not isinstance(edits, list) or not edits:
        return "[ERROR] edits debe ser una lista de {old_text, new_text}"
    hechos: list[str] = []
    for i, edit in enumerate(edits, 1):
        if not isinstance(edit, dict):
            return f"[ERROR] La edición {i} no es un objeto {{old_text, new_text}}"
        out = tool_edit_file(workspace, rel_path, str(edit.get("old_text", "")),
                             str(edit.get("new_text", "")), bool(edit.get("all")))
        if out.startswith("[ERROR]"):
            aplicadas = f" Ya se aplicaron las {i - 1} anteriores." if i > 1 else ""
            return f"[ERROR] Edición {i} de {len(edits)}: {out[8:]}.{aplicadas}"
        hechos.append(out.split("(", 1)[-1].rstrip(")"))
    return f"Archivo editado: {rel_path} ({len(edits)} ediciones: " + "; ".join(hechos) + ")"


def tool_insert_at_line(workspace: Path, rel_path: str, line: int, content: str) -> str:
    target = resolve_safe_path(workspace, rel_path)
    if not target.is_file():
        return f"Archivo no encontrado: {rel_path}"
    with target.open(encoding="utf-8", errors="replace", newline="") as f:
        original = f.read()
    nl = "\r\n" if "\r\n" in original else "\n"
    lines = original.split(nl)
    if not content.endswith(("\n", "\r\n")):
        content += nl
    nuevas = content.replace("\r\n", "\n").split("\n")[:-1]
    idx = len(lines) if line <= 0 or line > len(lines) else line - 1
    if idx == len(lines) and lines and lines[-1] == "":
        idx -= 1  # el archivo acaba en salto de línea: insertar antes del final vacío
    lines[idx:idx] = nuevas
    target.write_text(nl.join(lines), encoding="utf-8", newline="")
    return f"Archivo editado: {rel_path} ({len(nuevas)} líneas insertadas en la línea {idx + 1})"


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


def tool_search(workspace: Path, pattern: str, rel_path: str = ".", glob: str = "",
                ignore_case: bool = False, regex: bool = False) -> str:
    if not pattern:
        return "[ERROR] Falta pattern"
    target = resolve_safe_path(workspace, rel_path or ".")
    if not target.exists():
        return f"No existe: {rel_path}"
    cmd = ["rg", "-n", "--hidden", "--no-messages", "--max-columns", "240"]
    cmd += [f"--glob=!{d}" for d in IGNORED_TREE_DIRS]
    if glob:
        cmd += ["--glob", glob]
    if ignore_case:
        cmd.append("-i")
    if not regex:
        cmd.append("-F")
    cmd += ["-e", pattern, str(target)]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                             errors="replace", cwd=str(workspace))
    except FileNotFoundError:
        return _search_python(workspace, target, pattern, glob, ignore_case, regex)
    if out.returncode == 2:
        return f"[ERROR] {(out.stderr or out.stdout).strip()[:500]}"
    lines = [_relative_hit(workspace, l) for l in out.stdout.splitlines() if l]
    return _cap_lines(lines) if lines else "(sin resultados)"


def _relative_hit(workspace: Path, line: str) -> str:
    prefix = str(workspace)
    if line.startswith(prefix):
        line = line[len(prefix):].lstrip("\\/")
    return line.replace("\\", "/", 1) if ":" in line else line


def _search_python(workspace: Path, target: Path, pattern: str, glob: str = "",
                   ignore_case: bool = False, regex: bool = False) -> str:
    """Fallback sin ripgrep, con las mismas opciones."""
    import fnmatch

    flags = re.IGNORECASE if ignore_case else 0
    try:
        matcher = re.compile(pattern if regex else re.escape(pattern), flags)
    except re.error as exc:
        return f"[ERROR] regex inválida: {exc}"
    hits: list[str] = []
    files = [target] if target.is_file() else [
        p for p in target.rglob("*")
        if p.is_file() and not any(part in IGNORED_TREE_DIRS for part in p.parts)
    ]
    for p in files[:5000]:
        rel = p.relative_to(workspace).as_posix()
        if glob and not (fnmatch.fnmatch(p.name, glob) or fnmatch.fnmatch(rel, glob)):
            continue
        if is_binary(p):
            continue
        try:
            for lineno, line in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if matcher.search(line):
                    hits.append(f"{rel}:{lineno}:{line.strip()[:240]}")
                    if len(hits) > MAX_RESULT_LINES:
                        return _cap_lines(hits)
        except OSError:
            continue
    return _cap_lines(hits) if hits else "(sin resultados)"


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
    if dest.exists():
        return f"[ERROR] Ya existe el destino: {dst}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    import shutil
    shutil.move(str(source), str(dest))
    return f"Movido: {src} {g('arrow')} {dst}"


MAX_COMMAND_TIMEOUT = 600
MAX_COMMAND_OUTPUT = 8000


def _kill_tree(proc: subprocess.Popen) -> None:
    import os
    import signal

    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def tool_run_command(workspace: Path, command: str, timeout: int = 30) -> str:
    if not command.strip():
        return "[ERROR] Falta command"
    timeout = max(1, min(int(timeout or 30), MAX_COMMAND_TIMEOUT))
    import os
    # El shell arranca en su propio grupo: un timeout mata también a los hijos
    # (npm, pytest…), que con subprocess.run seguían vivos comiendo CPU.
    extra = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
    try:
        proc = subprocess.Popen(command, shell=True, cwd=str(workspace), stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **extra)
    except Exception as exc:
        return f"[ERROR] {exc}"
    try:
        raw, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_tree(proc)
        raw, _ = proc.communicate()
        salida = _decode_output(raw)[-2000:]
        return f"[TIMEOUT] El comando superó {timeout}s y se mató (con sus procesos hijos)." + (
            f"\nÚltima salida:\n{salida}" if salida else "")
    output = _decode_output(raw)
    if len(output) > MAX_COMMAND_OUTPUT:
        output = output[:MAX_COMMAND_OUTPUT // 2] + "\n…[salida recortada]…\n" + output[-MAX_COMMAND_OUTPUT // 2:]
    return f"[EXIT {proc.returncode}] " + (output or "(sin salida)")


class _Background:
    """Proceso lanzado con background=true: un hilo drena su salida a un
    buffer y read_output devuelve solo lo nuevo desde la última lectura."""

    def __init__(self, ident: str, command: str, proc: subprocess.Popen):
        self.id = ident
        self.command = command
        self.proc = proc
        self.buffer = bytearray()
        self.lock = threading.Lock()
        self.cursor = 0
        threading.Thread(target=self._drain, daemon=True, name=f"bg-{ident}").start()

    def _drain(self) -> None:
        for chunk in iter(lambda: self.proc.stdout.read1(4096), b""):
            with self.lock:
                self.buffer += chunk
                if len(self.buffer) > 400_000:  # cola de 400 kB: lo viejo se descarta
                    dropped = len(self.buffer) - 400_000
                    del self.buffer[:dropped]
                    self.cursor = max(0, self.cursor - dropped)
        self.proc.wait()

    def read_new(self) -> str:
        with self.lock:
            fresh = bytes(self.buffer[self.cursor:])
            self.cursor = len(self.buffer)
        return _decode_output(fresh)

    @property
    def alive(self) -> bool:
        return self.proc.poll() is None


_background: dict[str, _Background] = {}
_background_seq = 0


def _spawn_shell(workspace: Path, command: str) -> subprocess.Popen:
    import os
    # El shell arranca en su propio grupo: matarlo mata también a los hijos
    # (npm, pytest…), que con subprocess.run seguían vivos comiendo CPU.
    extra = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt"
             else {"start_new_session": True})
    return subprocess.Popen(command, shell=True, cwd=str(workspace), stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **extra)


def tool_run_background(workspace: Path, command: str) -> str:
    global _background_seq
    if not command.strip():
        return "[ERROR] Falta command"
    try:
        proc = _spawn_shell(workspace, command)
    except Exception as exc:
        return f"[ERROR] {exc}"
    _background_seq += 1
    ident = f"p{_background_seq}"
    _background[ident] = _Background(ident, command, proc)
    time.sleep(1.0)  # un fallo inmediato (comando inexistente) se ve ya en la primera lectura
    bg = _background[ident]
    salida = bg.read_new()
    estado = "en marcha" if bg.alive else f"terminó con código {proc.returncode}"
    return f"[background {ident}] {estado}" + (f"\n{salida}" if salida else "")


def tool_read_output(ident: str, wait: int = 0) -> str:
    bg = _background.get(ident)
    if bg is None:
        return f"[ERROR] No hay ningún proceso {ident}; los activos: {', '.join(_background) or 'ninguno'}"
    wait = max(0, min(int(wait or 0), 60))
    if wait:
        try:
            bg.proc.wait(timeout=wait)
        except subprocess.TimeoutExpired:
            pass
    salida = bg.read_new()
    if len(salida) > MAX_COMMAND_OUTPUT:
        salida = salida[:MAX_COMMAND_OUTPUT // 2] + "\n…[salida recortada]…\n" + salida[-MAX_COMMAND_OUTPUT // 2:]
    estado = "sigue en marcha" if bg.alive else f"terminó con código {bg.proc.returncode}"
    return f"[{ident}] {estado}" + (f"\n{salida}" if salida else "\n(sin salida nueva)")


def tool_stop_command(ident: str) -> str:
    bg = _background.pop(ident, None)
    if bg is None:
        return f"[ERROR] No hay ningún proceso {ident}"
    if bg.alive:
        _kill_tree(bg.proc)
    return f"[{ident}] detenido ({bg.command[:80]})"


def background_processes() -> list[tuple[str, str, bool]]:
    return [(bg.id, bg.command, bg.alive) for bg in _background.values()]


def stop_all_background() -> None:
    for ident in list(_background):
        tool_stop_command(ident)


def _decode_output(raw: bytes) -> str:
    """Salida de consola: UTF-8 si lo es; si no, la página de códigos local
    (en Windows cmd habla cp850/cp1252)."""
    import locale

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode(locale.getpreferredencoding(False) or "utf-8", errors="replace")
    return re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", text).strip()


MAX_FETCH_CHARS = 12000


def tool_fetch_url(url: str) -> str:
    from urllib import error, request

    url = (url or "").strip()
    if not url.lower().startswith(("http://", "https://")):
        return "[ERROR] La URL debe empezar por http:// o https://"
    req = request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; lixbon-cli/1.0)",
                                        "Accept": "text/html,application/json,text/plain,*/*"})
    try:
        with request.urlopen(req, timeout=20) as resp:
            ctype = resp.headers.get("Content-Type", "")
            raw = resp.read(4 * 1024 * 1024)
    except error.HTTPError as exc:
        return f"[ERROR] HTTP {exc.code} al descargar {url}"
    except Exception as exc:
        return f"[ERROR] No se pudo descargar {url}: {exc}"
    charset = "utf-8"
    m = re.search(r"charset=([\w-]+)", ctype)
    if m:
        charset = m.group(1)
    text = raw.decode(charset, errors="replace")
    if "html" in ctype or text.lstrip()[:15].lower().startswith(("<!doctype", "<html")):
        text = html_to_text(text)
    elif not any(t in ctype for t in ("text", "json", "xml", "javascript")):
        return f"[ERROR] {url} no es texto ({ctype.split(';')[0] or 'tipo desconocido'})"
    if len(text) > MAX_FETCH_CHARS:
        text = text[:MAX_FETCH_CHARS] + f"\n…[recortado: {len(text) - MAX_FETCH_CHARS} caracteres más]"
    return text or "(la página no tiene texto)"


def tool_web_search(api, query: str, limit: int = 5) -> str:
    if api is None:
        return "[ERROR] La búsqueda web no está disponible en esta sesión"
    query = (query or "").strip()
    if not query:
        return "[ERROR] Falta query"
    try:
        data = api.web_search(query, max(1, min(int(limit or 5), 10)))
    except Exception as exc:
        return f"[ERROR] Búsqueda web fallida: {exc}"
    results = data.get("results") or []
    if not results:
        return "(sin resultados)"
    parts = []
    for i, r in enumerate(results, 1):
        snippet = re.sub(r"\s+", " ", str(r.get("snippet") or "")).strip()[:1500]
        parts.append(f"{i}. {r.get('title') or '(sin título)'}\n   {r.get('url', '')}\n   {snippet}")
    return "\n\n".join(parts)


def execute_tool_call(workspace: Path, tool_name: str, args: dict, api=None) -> str:
    if tool_name == "list_files":
        return tool_list_files(workspace, args.get("path", "."), bool(args.get("recursive")))
    if tool_name == "find_files":
        return tool_find_files(workspace, str(args.get("pattern", "")))
    if tool_name == "outline":
        return tool_outline(workspace, str(args.get("path", "")))
    if tool_name == "fetch_url":
        return tool_fetch_url(str(args.get("url", "")))
    if tool_name == "web_search":
        return tool_web_search(api, str(args.get("query", "")), int(args.get("limit") or 5))
    if tool_name == "read_file":
        return tool_read_file(workspace, args.get("path", ""),
                              int(args.get("start_line") or 0), int(args.get("end_line") or 0))
    if tool_name == "write_file":
        return tool_write_file(workspace, args.get("path", ""), args.get("content", ""))
    if tool_name == "edit_file":
        return tool_edit_file(workspace, args.get("path", ""), args.get("old_text", ""),
                              args.get("new_text", ""), bool(args.get("all")))
    if tool_name == "multi_edit":
        return tool_multi_edit(workspace, args.get("path", ""), args.get("edits"))
    if tool_name == "insert_at_line":
        return tool_insert_at_line(workspace, args.get("path", ""), int(args.get("line") or 0),
                                   str(args.get("content", "")))
    if tool_name == "append_file":
        return tool_append_file(workspace, args.get("path", ""), args.get("content", ""))
    if tool_name == "mkdir":
        return tool_mkdir(workspace, args.get("path", ""))
    if tool_name == "search":
        return tool_search(workspace, args.get("pattern", ""), args.get("path") or ".",
                           str(args.get("glob") or ""), bool(args.get("ignore_case")),
                           bool(args.get("regex")))
    if tool_name == "delete_file":
        return tool_delete_file(workspace, args.get("path", ""))
    if tool_name == "rename_file":
        return tool_rename_file(workspace, args.get("src", ""), args.get("dst", ""))
    if tool_name == "run_command":
        if args.get("background"):
            return tool_run_background(workspace, args.get("command", ""))
        return tool_run_command(workspace, args.get("command", ""), int(args.get("timeout") or 30))
    if tool_name == "read_output":
        return tool_read_output(str(args.get("id", "")), int(args.get("wait") or 0))
    if tool_name == "stop_command":
        return tool_stop_command(str(args.get("id", "")))
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

def dump_empty_turn(messages: list[dict], reasoning: str, raw: str) -> str:
    """Guarda un turno sin respuesta en ~/.lixbon/empty-turns/ para poder verlo.

    Un turno vacío no deja rastro por definición: sin esto, saber POR QUÉ el
    modelo no dijo nada exige reproducirlo a ciegas. Solo se activa con
    LIXBON_DEBUG=1, y guarda lo que se envió junto a lo que llegó.
    """
    import os
    import time as _time
    from pathlib import Path as _Path

    if os.environ.get("LIXBON_DEBUG") != "1":
        return ""
    try:
        folder = _Path.home() / ".lixbon" / "empty-turns"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{_time.strftime('%Y%m%d-%H%M%S')}.json"
        path.write_text(json.dumps({
            "sent": messages,
            "reasoning": reasoning,
            "content": raw,
        }, ensure_ascii=False, indent=1), encoding="utf-8")
        return str(path)
    except Exception:
        return ""


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
        ask = session.get("ask")
        if ask is not None and needs_compaction(working, window):
            # Antes de podar a ciegas: resumir. Lo que se pierde en la poda es
            # justo lo que el agente necesita para no repetir trabajo.
            print_note("La conversación llena la ventana de contexto: compactando…")
            try:
                working = compact_messages(working, ask)
                print_note(f"Contexto compactado a ~{estimate_tokens(working)} tokens.")
            except Exception as exc:
                print_note(f"No se pudo compactar ({exc}); se recortarán los pasos antiguos.")
        # El flag puede apagarse a mitad de turno (fallback si el modelo no
        # soporta tools), así que se relee en cada paso.
        native = session.get("native_tools", True)
        system_content = (build_native_system_prompt(workspace) if native
                          else build_agent_system_prompt(workspace)) + TODO_PROMPT
        if session.get("plan_mode"):
            system_content += PLAN_MODE_PROMPT
        system_msg = {"role": "system", "content": system_content}
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
            images = pop_tool_images(session)
            if images:
                working.append({"role": "user", "content": TOOL_IMAGES_PROMPT, "images": images})
            continue

        tool_calls = extract_all_tool_calls(assistant)

        if not tool_calls and not assistant.strip():
            # Sin texto y sin llamadas. Antes de darlo por perdido hay que mirar
            # el RAZONAMIENTO: los modelos thinking (qwen3.5 y compañía) muchas
            # veces deciden la herramienta dentro del bloque de pensamiento y la
            # escriben ahí, así que Ollama la manda por el canal `thinking` y no
            # como content ni como tool_call. Descartarlo era ver al agente
            # "pensar 12 s y no hacer nada" con el contexto casi vacío.
            reasoning = str(session.get("last_reasoning") or "")
            dumped = dump_empty_turn(messages, reasoning, raw)
            if dumped:
                print_note(f"Turno sin respuesta volcado en {dumped}")
            rescued = extract_all_tool_calls(reasoning)
            if rescued:
                tool_calls = rescued
                # El historial guarda la llamada rescatada, no un turno vacío:
                # el modelo tiene que ver lo que pidió para leer bien el resultado.
                assistant = "\n".join(
                    json.dumps({"tool": c.get("tool", ""), "args": c.get("args", {})},
                               ensure_ascii=False)
                    for c in rescued)
                render_action_result(console, "llamada recuperada del razonamiento")
            elif empty_retries < 2:
                empty_retries += 1
                if reasoning:
                    # Razonó pero no dijo nada: no es contexto, es que se quedó
                    # pensando. Se le pide el paso concreto, sin tocar el historial.
                    working.append({"role": "user", "content": NO_OUTPUT_PROMPT})
                    print_note("El modelo se quedó pensando sin responder; le pido "
                               "que ejecute el siguiente paso.")
                else:
                    # Nada en absoluto (ni razonamiento): ahí sí huele a ventana
                    # desbordada. Se recorta lo que se ENVÍA, no el historial:
                    # podar `working` borraba la conversación del usuario.
                    print_note("El modelo no devolvió nada; libero contexto y lo reintento.")
                    working = shrink_old_results(working, keep_recent=2)
                continue
            else:
                return ("Me quedé sin respuesta del modelo: razona pero no llega a "
                        "responder. Prueba con /model a uno sin «thinking», o /new "
                        "para empezar con el contexto limpio."), working
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
        for group in _group_reads(tool_calls):
            if len(group) > 1:
                results = _run_read_group(console, workspace, session, group)
            else:
                call = group[0]
                results = [_approve_and_run(console, workspace, session,
                                            call.get("tool", ""), call.get("args", {}))]
            for call, result in zip(group, results):
                combined_results.append(
                    f"TOOL_RESULT {call.get('tool', '')}: {clip_tool_output(result)}")

        results_msg = {"role": "user", "content": "\n".join(combined_results)}
        images = pop_tool_images(session)
        if images:
            results_msg["images"] = images
        working.append(results_msg)

    return (f"He llegado al tope de {MAX_AGENT_STEPS} pasos en un mismo turno y paro aquí "
            "para no seguir a ciegas. Dime «continúa» si quieres que siga desde donde iba."), working


def turn_stats(session: dict) -> dict:
    """Contadores del turno en curso, para el resumen que lo cierra."""
    return session.setdefault(
        "turn_stats", {"actions": 0, "files": set(), "adds": 0, "dels": 0})


# Medida de una lectura: se saca del propio resultado, así que la acción se
# imprime DESPUÉS de ejecutar. Una lectura no pide permiso, así que el orden en
# pantalla es el mismo y a cambio la columna de la derecha dice algo.
def _read_meta(tool_name: str, result: str) -> str:
    lines = result.count("\n") + 1 if result else 0
    if tool_name == "read_file":
        return f"{lines} líneas"
    if tool_name == "search":
        return f"{lines} coincidencia" + ("" if lines == 1 else "s")
    if tool_name in ("list_files", "find_files"):
        return f"{lines} entrada" + ("" if lines == 1 else "s")
    if tool_name == "outline":
        return f"{max(0, lines - 1)} símbolo" + ("" if lines == 2 else "s")
    if tool_name == "web_search":
        n = len(re.findall(r"^\d+\. ", result, re.MULTILINE))
        return f"{n} resultado" + ("" if n == 1 else "s")
    if tool_name == "fetch_url":
        return f"{len(result) // 1000} k caracteres" if len(result) >= 1000 else f"{len(result)} caracteres"
    return ""


def _group_reads(tool_calls: list[dict]) -> list[list[dict]]:
    """Parte las llamadas de un paso en grupos: las lecturas seguidas van juntas.

    Cuando el modelo pide tres archivos de golpe, tres líneas iguales no dicen
    más que una: `leyó  3 archivos` y los nombres debajo.
    """
    groups: list[list[dict]] = []
    for call in tool_calls:
        if call.get("tool") == "read_file" and groups and groups[-1][0].get("tool") == "read_file":
            groups[-1].append(call)
        else:
            groups.append([call])
    return groups


def _stash_image(session: dict, workspace: Path, tool_name: str, args: dict, failed: bool):
    """Una imagen leída con read_file no cabe en un TOOL_RESULT de texto: se
    guarda y el bucle la adjunta al modelo (campo `images`) tras el resultado."""
    if tool_name != "read_file" or failed:
        return
    try:
        target = resolve_safe_path(workspace, str(args.get("path", "")))
    except RuntimeError:
        return
    if target.is_file() and is_image(target):
        from lixbon_cli.commands import encode_image
        session.setdefault("tool_images", []).append(encode_image(target))


def pop_tool_images(session: dict) -> list[str]:
    return session.pop("tool_images", [])


TOOL_IMAGES_PROMPT = "Imágenes de los read_file anteriores, en el mismo orden. Continúa."


def _run_read_group(console, workspace: Path, session: dict, calls: list[dict]) -> list[str]:
    remote = session.get("remote")
    stats = turn_stats(session)
    results: list[str] = []
    names: list[str] = []
    lines = 0
    for call in calls:
        args = call.get("args", {})
        label = str(args.get("path") or ".")
        result, failed, _elapsed = _execute(workspace, "read_file", args)
        _stash_image(session, workspace, "read_file", args, failed)
        stats["actions"] += 1
        results.append(result)
        if failed:
            render_action(console, TOOL_VERB["read_file"], label, readonly=True)
            render_action_result(console, result.split("\n", 1)[0][:120], error=True)
        else:
            names.append(label.rsplit("/", 1)[-1])
            lines += result.count("\n") + 1
        if remote:
            remote.emit("tool_use", tool="read_file", summary=label, readonly=True)
            remote.emit("tool_result", tool="read_file",
                        result=result[:REMOTE_RESULT_CHARS], error=failed)
    if names:
        render_action(console, TOOL_VERB["read_file"], f"{len(names)} archivos",
                      readonly=True, meta=f"{lines} líneas")
        listed = f" {g('sep')} ".join(names)
        render_log_line(console, " " * VERB_WIDTH + listed, "lx.dim2")
    return results


def _approve_and_run(console, workspace: Path, session: dict, tool_name: str, args: dict) -> str:
    # Con /remote activo, la sesión se maneja desde el móvil/web: los eventos
    # de herramientas viajan al controller y las aprobaciones se piden allí
    # (localmente no hay nadie al teclado durante el takeover).
    remote = session.get("remote")
    stats = turn_stats(session)

    if tool_name == "todo":
        render_action(console, TOOL_VERB["todo"], "", readonly=True)
        result = tool_todo(session, console, args.get("items"))
        stats["actions"] += 1
        if remote:
            remote.emit("tool_use", tool="todo", summary=result[:REMOTE_RESULT_CHARS], readonly=True)
        return result
    if tool_name == "ask_user":
        render_action(console, TOOL_VERB["ask_user"], str(args.get("question", ""))[:100], readonly=True)
        stats["actions"] += 1
        return tool_ask_user(session, args.get("question", ""), args.get("options"))
    if session.get("plan_mode") and tool_name not in READ_ONLY_TOOLS:
        render_action(console, TOOL_VERB.get(tool_name, tool_name), _args_summary(tool_name, args))
        render_action_result(console, "bloqueado: modo plan", error=True)
        return ("[modo plan] No puedes modificar archivos ni ejecutar comandos ahora. Termina de "
                "explorar y responde con el plan numerado para que el usuario lo apruebe.")
    if tool_name in READ_ONLY_TOOLS:
        # Solo lectura: se ejecuta sin preguntar, con rastro discreto.
        label = args.get("path") or args.get("pattern") or args.get("query") or args.get("url") or "."
        result, failed, _elapsed = _execute(workspace, tool_name, args, session.get("api"))
        _stash_image(session, workspace, tool_name, args, failed)
        stats["actions"] += 1
        render_action(console, TOOL_VERB.get(tool_name, tool_name), str(label),
                     readonly=True, meta="" if failed else _read_meta(tool_name, result))
        if failed:
            render_action_result(console, result.split("\n", 1)[0][:120], error=True)
        if remote:
            remote.emit("tool_use", tool=tool_name, summary=str(label), readonly=True)
            remote.emit("tool_result", tool=tool_name,
                        result=result[:REMOTE_RESULT_CHARS], error=failed)
        return result

    try:
        change = compute_change(workspace, tool_name, args, resolve_safe_path)
    except Exception:
        change = None
    counts = (0, 0)
    if change is not None:
        counts = render_change(console, change)
    else:
        render_action(console, TOOL_VERB.get(tool_name, tool_name), _args_summary(tool_name, args))
    if remote:
        remote.emit("tool_use", tool=tool_name, summary=_args_summary(tool_name, args), readonly=False)

    # Los comandos de shell son irreversibles (sin snapshot que los deshaga):
    # tienen su propio flag y NO los cubre auto_approve. Así, responder
    # "siempre" tras una edición de archivo no habilita ejecutar comandos.
    if tool_name == "run_command":
        command = str(args.get("command", ""))
        permitido = command_allowed(command, session.get("allowed_commands") or [])
        if not session.get("auto_run_commands") and not permitido:
            if remote:
                if remote.request_approval(tool_name, _args_summary(tool_name, args), "command") != "allow":
                    render_action_result(console, "rechazado desde el control remoto", error=True)
                    return "Ejecución cancelada por el usuario"
            else:
                prefix = command_prefix(command)
                decision = confirm_command(_args_summary(tool_name, args), prefix)
                if decision == "always":
                    session["auto_run_commands"] = True
                elif decision == "prefix":
                    session.setdefault("allowed_commands", []).append(prefix)
                    guardar = session.get("save_allowed_commands")
                    if guardar:
                        guardar(session["allowed_commands"])
                elif decision in ("no", None):
                    render_action_result(console, "rechazado por el usuario", error=True)
                    return "Ejecución cancelada por el usuario"
    elif not session.get("auto_approve"):
        if remote:
            if remote.request_approval(tool_name, _args_summary(tool_name, args), "edit") != "allow":
                render_action_result(console, "rechazado desde el control remoto", error=True)
                return "Ejecución cancelada por el usuario"
        else:
            detail = change.path if change is not None else _args_summary(tool_name, args)
            if counts != (0, 0):
                detail = f"{detail} {g('sep')} +{counts[0]} -{counts[1]}"
            decision = confirm3("¿Aplicar este cambio?", detail=detail)
            if decision == "always":
                session["auto_approve"] = True
            elif decision in ("no", None):
                render_action_result(console, "rechazado por el usuario", error=True)
                return "Ejecución cancelada por el usuario"

    stats["actions"] += 1
    if change is not None and change.kind != "command":
        stats["files"].add(change.path)
        stats["adds"] += counts[0]
        stats["dels"] += counts[1]
    snapshot_before(session, workspace, tool_name, args)
    result = _run(console, workspace, tool_name, args, remote)
    if session.get("auto_check", True):
        tool, errors, result = verify_after(workspace, tool_name, args, result)
        if tool:
            primera = errors.strip().splitlines()[0][:110] if errors else "sin errores"
            render_action_result(console, f"{tool}: {primera}", error=bool(errors))
    return result


def command_prefix(command: str) -> str:
    """Lo que se guarda al decir «siempre para este comando»: el programa y su
    subcomando (`npm test`, `git status`, `pytest`), no la línea entera."""
    words = command.strip().split()
    if not words:
        return ""
    if len(words) >= 2 and re.fullmatch(r"[\w.-]+", words[1]) and not words[1].startswith("-"):
        return f"{words[0]} {words[1]}"
    return words[0]


def command_allowed(command: str, allowed: list[str]) -> bool:
    """Un comando encadenado (`&&`, `;`, `|`) solo pasa si TODOS sus tramos
    están permitidos: «npm test» no debe cubrir «npm test && rm -rf x»."""
    tramos = [t.strip() for t in re.split(r"&&|\|\||;|\|", command) if t.strip()]
    if not tramos:
        return False
    for tramo in tramos:
        words = tramo.split()
        if not any(prefix and (words[:len(prefix.split())] == prefix.split()) for prefix in allowed):
            return False
    return True


def snapshot_before(session: dict, workspace: Path, tool_name: str, args: dict) -> None:
    """Guarda el estado previo de lo que va a tocar una herramienta, para /undo.
    Cada entrada: (ruta relativa, bytes anteriores o None si no existía)."""
    if tool_name not in MUTATING_TOOLS:
        return
    rutas = [args.get("src"), args.get("dst")] if tool_name == "rename_file" else [args.get("path")]
    turno = session.setdefault("checkpoints", [])
    for rel in rutas:
        if not rel:
            continue
        try:
            target = resolve_safe_path(workspace, str(rel))
        except RuntimeError:
            continue
        if target.is_dir():
            session["undo_incomplete"] = True  # carpetas: no se guarda su contenido
            continue
        before = target.read_bytes() if target.is_file() else None
        turno.append((str(rel), before))


def undo_checkpoints(workspace: Path, entries: list[tuple[str, bytes | None]]) -> list[str]:
    """Deshace en orden inverso: restaura el contenido previo o borra lo creado."""
    hechos: list[str] = []
    for rel, before in reversed(entries):
        target = resolve_safe_path(workspace, rel)
        if before is None:
            if target.is_file():
                target.unlink()
                hechos.append(f"eliminado {rel}")
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(before)
            hechos.append(f"restaurado {rel}")
    return hechos


def verify_after(workspace: Path, tool_name: str, args: dict, result: str) -> tuple[str, str, str]:
    """Tras escribir/editar, pasa el verificador del archivo. Devuelve
    (herramienta, errores, resultado ampliado para el modelo)."""
    if tool_name not in EDIT_TOOLS or result.startswith("[ERROR]"):
        return "", "", result
    try:
        target = resolve_safe_path(workspace, str(args.get("path", "")))
        tool, errors = verify_file(workspace, target)
    except Exception:
        return "", "", result
    if errors:
        result += f"\n[verificación {tool}] el archivo tiene errores; corrígelos:\n{errors}"
    return tool, errors, result


def _execute(workspace: Path, tool_name: str, args: dict, api=None) -> tuple[str, bool, float]:
    """Ejecuta una herramienta. Devuelve (resultado, ha fallado, segundos)."""
    started = time.monotonic()
    try:
        result = execute_tool_call(workspace, tool_name, args, api)
    except Exception as exc:
        result = f"[ERROR] {exc}"
    failed = (result.startswith("[ERROR]") or result.startswith("[TIMEOUT]")
              or (result.startswith("[EXIT ") and not result.startswith("[EXIT 0]")))
    return result, failed, time.monotonic() - started


def _run(console, workspace: Path, tool_name: str, args: dict, remote=None) -> str:
    result, failed, elapsed = _execute(workspace, tool_name, args)
    if tool_name not in READ_ONLY_TOOLS or failed:
        # El tiempo va en el resultado y no en la acción: la línea de la acción
        # se imprime antes de ejecutar, porque es la que se aprueba.
        meta = f"{g('cross') if failed else g('check')} {elapsed:.1f} s" if elapsed >= 0.1 else ""
        render_action_result(console, result.split("\n", 1)[0][:120],
                            error=failed, meta=meta)
    if remote:
        remote.emit("tool_result", tool=tool_name,
                    result=result[:REMOTE_RESULT_CHARS], error=failed)
    return result
