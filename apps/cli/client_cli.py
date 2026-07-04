#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from urllib import error, request

try:
    import readline
except Exception:
    readline = None


import socket as _socket
DEFAULT_BASE_URL = f"http://{_socket.gethostname()}:8000/v1"
CONFIG_DIR = Path.home() / ".folax"
CONFIG_FILE = CONFIG_DIR / "config.json"
IS_WINDOWS = os.name == "nt"

COLOR_RESET = "\033[0m"
COLOR_DIM = "\033[2m"
COLOR_BOLD = "\033[1m"
COLOR_CYAN = "\033[96m"
COLOR_GREEN = "\033[92m"
COLOR_YELLOW = "\033[93m"
COLOR_MAGENTA = "\033[95m"
COLOR_BLUE = "\033[94m"
COLOR_RED = "\033[91m"

SLASH_COMMANDS = [
    "/help",
    "/mode <ask|agent|delegate>",
    "/delegate",
    "/workspace <ruta>",
    "/approve <on|off>",
    "/model <nombre>",
    "/key <api_key>",
    "/models",
    "/new",
    "/history",
    "/context <n>",
    "/usage",
    "/nodes",
    "/update",
    "/save",
    "/status",
    "/setup",
    "/copy",
    "/clear",
    "/exit",
]

MODEL_COMPLETIONS: list[str] = []


def default_config() -> dict:
    return {
        "base_url": "https://remote.datacentgbx.online/v1",
        "api_key": "",
        "model": "",
        "key_model": "",  # Si está definido, la key es de modelo especifico (no se puede cambiar)
        "max_context_messages": 12,
        "mode": "ask",
        "workspace": str(Path.cwd()),
        "auto_approve_tools": False,
    }


def enable_windows_colors() -> None:
    if IS_WINDOWS:
        os.system("")


def paint(text: str, color: str) -> str:
    return f"{color}{text}{COLOR_RESET}"


def hr(char: str = "─", width: int = 68) -> str:
    return char * width


def format_assistant_output(text: str) -> str:
    lines = text.split("\n")
    formatted = []
    in_code_block = False
    for line in lines:
        if line.strip().startswith("```"):
            in_code_block = not in_code_block
            formatted.append(paint(line, COLOR_CYAN))
        elif in_code_block:
            if line.startswith("+"):
                formatted.append(paint(line, COLOR_GREEN))
            elif line.startswith("-"):
                formatted.append(paint(line, COLOR_RED))
            elif line.startswith("@@"):
                formatted.append(paint(line, COLOR_MAGENTA))
            else:
                formatted.append(paint(line, COLOR_YELLOW))
        else:
            formatted.append(line)
    return "\n".join(formatted)


def print_cli_header(base_url: str, model: str, client_id: str) -> None:
    logo = [
        r"   ___  ___  _      ___  _  _     ____  ____  ___ ",
        r"  | __|| _ \| |    /   || \/ |   |  _ \|_  _|/ __|  ",
        r"  | _| |   /| |_  | (} ||    |   | | | | | || (__ ",
        r"  |_|  |_|_\|___| |___/ |_||_|   |_| |_| |_| \___|  v2",
    ]
    print(paint(hr("="), COLOR_BLUE))
    for row in logo:
        print(paint(row, COLOR_BOLD + COLOR_BLUE))
    print(paint(" FOLAX DTC CLI ", COLOR_BOLD + COLOR_CYAN))
    print(f"{paint('Base URL:', COLOR_DIM)} {base_url}")
    print(f"{paint('Modelo:', COLOR_DIM)} {model}")
    print(f"{paint('Cliente:', COLOR_DIM)} {client_id}")
    print("")
    print(paint(hr("="), COLOR_BLUE))


def print_command_help() -> None:
    print(paint("Comandos disponibles:", COLOR_BOLD + COLOR_MAGENTA))
    print(f"  {paint('/help', COLOR_CYAN)}           Mostrar ayuda")
    print(f"  {paint('/mode <ask|agent|delegate>', COLOR_CYAN)} Cambiar modo de trabajo")
    print(f"  {paint('/delegate', COLOR_CYAN)}       Activar modo delegacion IA (auto-routing)")
    print(f"  {paint('/workspace <ruta>', COLOR_CYAN)}  Definir carpeta para modo agent")
    print(f"  {paint('/approve <on|off>', COLOR_CYAN)}  Confirmacion de herramientas")
    print(f"  {paint('/model <nombre>', COLOR_CYAN)} Cambiar modelo actual")
    print(f"  {paint('/key <api_key|new>', COLOR_CYAN)}  Cambiar API key o generar nueva")
    print(f"  {paint('/models', COLOR_CYAN)}         Listar modelos disponibles")
    print(f"  {paint('/new', COLOR_CYAN)}            Iniciar nueva conversacion")
    print(f"  {paint('/history', COLOR_CYAN)}        Ver resumen de historial actual")
    print(f"  {paint('/context <n>', COLOR_CYAN)}    Ajustar contexto para mas velocidad")
    print(f"  {paint('/usage', COLOR_CYAN)}          Ver uso global del gateway")
    print(f"  {paint('/update', COLOR_CYAN)}         Actualizar CLI desde servidor")
    print(f"  {paint('/save', COLOR_CYAN)}           Guardar modelo/key en config local")
    print(f"  {paint('/status', COLOR_CYAN)}         Ver estado rapido")
    print(f"  {paint('/setup', COLOR_CYAN)}          Ejecutar configuracion interactiva")
    print(f"  {paint('/copy', COLOR_CYAN)}           Copiar la ultima respuesta de la IA")
    print(f"  {paint('/clear', COLOR_CYAN)}          Limpiar pantalla")
    print(f"  {paint('/exit', COLOR_CYAN)}           Salir")


def render_status_compact(cfg: dict, current_model: str) -> None:
    masked = "no configurada"
    if cfg.get("api_key"):
        k = cfg["api_key"]
        masked = f"{k[:6]}...{k[-4:]}" if len(k) > 10 else "***"
    print(paint(hr(), COLOR_DIM))
    print(f"{paint('URL', COLOR_DIM)}: {cfg.get('base_url') or DEFAULT_BASE_URL}")
    print(f"{paint('API key', COLOR_DIM)}: {masked}")
    print(f"{paint('Modelo', COLOR_DIM)}: {current_model or 'no configurado'}")
    print(paint(hr(), COLOR_DIM))


def setup_slash_completer() -> None:
    if readline is None:
        return
        
    hist_file = CONFIG_DIR / ".history"
    try:
        readline.read_history_file(str(hist_file))
        readline.set_history_length(1000)
    except FileNotFoundError:
        pass
    import atexit
    atexit.register(readline.write_history_file, str(hist_file))

    commands = [item.split(" ")[0].lstrip("/") for item in SLASH_COMMANDS]

    def completer(text: str, state: int):
        buffer = readline.get_line_buffer()
        if not buffer.startswith("/"):
            return None
        # Autocompletado contextual para /model <nombre>.
        if buffer.startswith("/model "):
            raw_model_prefix = buffer[len("/model ") :].strip()
            options = [m for m in MODEL_COMPLETIONS if m.startswith(raw_model_prefix)]
            if state < len(options):
                return options[state]
            return None
        word = buffer[readline.get_begidx() : readline.get_endidx()]
        prefix = (word or buffer).lstrip("/")
        options = [cmd for cmd in commands if cmd.startswith(prefix)]
        return options[state] if state < len(options) else None

    readline.parse_and_bind("tab: complete")
    readline.set_completer(completer)


def pick_model_interactive(current_model: str) -> str | None:
    if not MODEL_COMPLETIONS:
        print(paint("No hay modelos cargados para seleccionar.", COLOR_RED))
        return None
    print(paint("Selector de modelo (ENTER para mantener actual, /cancel para salir)", COLOR_CYAN))
    print(paint(f"Modelo actual: {current_model}", COLOR_DIM))
    filtered = MODEL_COMPLETIONS[:]
    while True:
        query = input(paint("Filtro modelo > ", COLOR_BOLD + COLOR_GREEN)).strip()
        if not query:
            return current_model
        if query.lower() in ("/cancel", "cancel", "salir"):
            return None
        filtered = [m for m in MODEL_COMPLETIONS if query.lower() in m.lower()]
        if not filtered:
            print(paint("Sin coincidencias, intenta otro filtro.", COLOR_YELLOW))
            continue
        print(paint(hr(), COLOR_DIM))
        for idx, m in enumerate(filtered[:20], start=1):
            print(f" {idx:>2}. {m}")
        print(paint(hr(), COLOR_DIM))
        choice = input(paint("Elige numero o escribe mas filtro > ", COLOR_BOLD + COLOR_GREEN)).strip()
        if not choice:
            continue
        if choice.isdigit():
            pos = int(choice)
            if 1 <= pos <= min(20, len(filtered)):
                return filtered[pos - 1]
            print(paint("Numero fuera de rango.", COLOR_RED))
            continue
        # Si no es numero, se toma como nuevo query.
        query = choice
        filtered = [m for m in MODEL_COMPLETIONS if query.lower() in m.lower()]
        if len(filtered) == 1:
            return filtered[0]
        if filtered:
            print(paint("Coincidencias parciales encontradas, afina filtro.", COLOR_DIM))
        else:
            print(paint("Sin coincidencias con ese filtro.", COLOR_YELLOW))


def spinner_while_thinking(stop_event: threading.Event) -> None:
    frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    idx = 0
    while not stop_event.is_set():
        frame = frames[idx % len(frames)]
        sys.stdout.write(f"\r{paint(f'{frame} pensando...', COLOR_YELLOW)}")
        sys.stdout.flush()
        idx += 1
        time.sleep(0.09)
    sys.stdout.write("\r" + (" " * 56) + "\r")
    sys.stdout.flush()


def load_config() -> dict:
    if not CONFIG_FILE.exists():
        return default_config()
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8-sig"))
    except Exception:
        return default_config()


def save_config(cfg: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def prompt_value(label: str, current: str = "", required: bool = False) -> str:
    while True:
        suffix = f" [{current}]" if current else ""
        value = input(f"{label}{suffix}: ").strip()
        if value:
            return value
        if current:
            return current
        if not required:
            return ""
        print("Este valor es requerido.")


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
    import difflib
    target = resolve_safe_path(workspace, rel_path)
    old_content = ""
    is_new = not target.exists()
    if not is_new:
        old_content = target.read_text(encoding="utf-8", errors="replace")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    if is_new:
        return f"[NEW] Archivo creado: {target.relative_to(workspace)} ({len(content)} chars)"
    # Calcula diff entre contenido viejo y nuevo
    diff_lines = list(difflib.unified_diff(
        old_content.splitlines(),
        content.splitlines(),
        fromfile=f"{rel_path} (antes)",
        tofile=f"{rel_path} (ahora)",
        lineterm="",
        n=2,
    ))
    if not diff_lines:
        return f"[OK] Sin cambios: {target.relative_to(workspace)}"
    # Limita el diff a 80 lineas para no saturar el contexto
    diff_str = "\n".join(diff_lines[:80])
    if len(diff_lines) > 80:
        diff_str += f"\n... ({len(diff_lines) - 80} lineas mas)"
    return f"[DIFF] {target.relative_to(workspace)}\n{diff_str}"


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
    except subprocess.CalledProcessError as exc:
        return (exc.output or "").strip() or "(sin resultados)"


def tool_delete_file(workspace: Path, rel_path: str) -> str:
    target = resolve_safe_path(workspace, rel_path)
    if not target.exists():
        return f"No encontrado: {rel_path}"
    if target.is_dir():
        import shutil
        shutil.rmtree(target)
        return f"[DEL] Directorio eliminado: {rel_path}"
    target.unlink()
    return f"[DEL] Archivo eliminado: {rel_path}"


def tool_rename_file(workspace: Path, src: str, dst: str) -> str:
    source = resolve_safe_path(workspace, src)
    dest = resolve_safe_path(workspace, dst)
    if not source.exists():
        return f"No encontrado: {src}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    source.rename(dest)
    return f"[MOVE] {src} -> {dst}"


def tool_run_command(workspace: Path, command: str, timeout: int = 30) -> str:
    """Ejecuta un comando de shell dentro del workspace."""
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


def _validate_tool_dict(data: dict) -> dict | None:
    """Valida que un dict sea una llamada de herramienta válida."""
    if isinstance(data, dict) and data.get("tool"):
        if "args" not in data or not isinstance(data.get("args"), dict):
            data["args"] = {}
        return data
    return None


def extract_all_tool_calls(text: str) -> list[dict]:
    """Extrae todos los JSON de herramientas embebidos en texto mixto.

    Usa conteo de llaves para manejar correctamente JSON anidado,
    por ejemplo write_file con args:{path, content}.
    """
    results = []
    i = 0
    while i < len(text):
        # Busca el inicio de un objeto JSON que empiece con {"tool"
        start = text.find('{"tool"', i)
        if start == -1:
            # Intenta variante con espacio: { "tool"
            start = text.find('{ "tool"', i)
        if start == -1:
            break
        # Recorre el texto contando profundidad de llaves
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
                        candidate = text[start : j + 1]
                        try:
                            data = _validate_tool_dict(json.loads(candidate))
                            if data:
                                results.append(data)
                        except Exception:
                            pass
                        i = j + 1
                        break
            j += 1
        else:
            # No se cerró el objeto, no hay más que buscar
            break
    return results


def delegate_request(base_url: str, api_key: str, user_input: str) -> dict:
    """Llama a POST /api/delegate y retorna el resultado de la delegacion."""
    server_base = base_url.rsplit('/v1', 1)[0] if base_url.endswith('/v1') else base_url
    return api_call("POST", f"{server_base}/api/delegate", api_key, {"user_input": user_input}, timeout=120)


def print_delegate_result(result: dict) -> None:
    """Imprime el resultado de la delegacion con formato de Cursor."""
    c = result.get('classification', {})
    routing = result.get('routing', {})
    router_type = routing.get('type', 'PLAN')
    model_used = routing.get('model', 'desconocido')
    exec_ms = result.get('execution_time_ms', 0)

    # Colores por tipo de routing
    router_colors = {
        'AUTO': COLOR_GREEN, 'PLAN': COLOR_BLUE,
        'DEBUG': COLOR_YELLOW, 'DELEGUE': COLOR_RED,
    }
    rc = router_colors.get(router_type, COLOR_CYAN)

    print(paint(hr(), COLOR_DIM))
    print(
        f"{paint('⚡ Delegacion', COLOR_BOLD + COLOR_MAGENTA)}  "
        f"{paint(f'[{router_type}]', COLOR_BOLD + rc)}  "
        f"modelo: {paint(model_used, COLOR_CYAN)}  "
        f"{paint(f'{exec_ms}ms', COLOR_DIM)}"
    )
    # Tags de clasificacion
    tags = [
        f"intent:{c.get('intent', '?')}",
        f"complejidad:{c.get('complexity', '?')}",
        f"dominio:{c.get('domain', '?')}",
        f"riesgo:{c.get('riskLevel', '?')}",
    ]
    print(paint('   ' + '  ·  '.join(tags), COLOR_DIM))
    print(paint(hr(), COLOR_DIM))

    response_text = result.get('response', '(sin respuesta)')
    print(format_assistant_output(response_text))

    similar = result.get('similar_tasks', [])
    if similar:
        print(paint(hr('-'), COLOR_DIM))
        print(paint(f"Tareas similares en historial ({len(similar)}):", COLOR_DIM))
        for t in similar:
            sim_pct = int(t.get('similarity', 0) * 100)
            print(paint(f"  {sim_pct}%  {t.get('user_input', '')[:80]}", COLOR_DIM))

    print(paint(hr(), COLOR_DIM))


def parse_tool_call(text: str) -> dict | None:
    """Retorna el primer JSON de herramienta encontrado en el texto, o None."""
    calls = extract_all_tool_calls(text)
    return calls[0] if calls else None

def api_call(method: str, url: str, api_key: str, payload: dict | None = None, timeout: int = 120) -> dict:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = request.Request(url=url, method=method, headers=headers, data=data)
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
    except Exception as exc:
        raise RuntimeError(f"Error de conexion: {exc}") from exc


def auth_api_call(method: str, url: str, payload: dict | None = None) -> dict:
    headers = {"Content-Type": "application/json"}
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = request.Request(url=url, method=method, headers=headers, data=data)
    try:
        with request.urlopen(req, timeout=120) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
    except Exception as exc:
        raise RuntimeError(f"Error de conexion: {exc}") from exc


def cmd_update(_: argparse.Namespace) -> None:
    cfg = load_config()
    base_url = cfg.get("base_url") or DEFAULT_BASE_URL
    server_base = base_url.rsplit("/v1", 1)[0] if base_url.endswith("/v1") else base_url
    target_path = Path(__file__).resolve()
    url = f"{server_base}/install/client_cli.py?ts={int(time.time() * 1000)}"
    print(paint(f"Actualizando CLI desde: {url}", COLOR_DIM))
    try:
        req = request.Request(
            url=url,
            headers={"Cache-Control": "no-cache", "Pragma": "no-cache"},
            method="GET",
        )
        with request.urlopen(req, timeout=120) as resp:
            content = resp.read().decode("utf-8")
        old_content = ""
        if target_path.exists():
            old_content = target_path.read_text(encoding="utf-8")
        old_hash = hashlib.sha256(old_content.encode("utf-8")).hexdigest() if old_content else ""
        new_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
        if old_hash == new_hash:
            print(paint("CLI ya esta actualizado (sin cambios remotos).", COLOR_YELLOW))
            return

        target_path.write_text(content, encoding="utf-8")
        print(paint("CLI actualizado correctamente (nueva version aplicada).", COLOR_GREEN))
        print(paint(f"Archivo: {target_path}", COLOR_DIM))
        print(paint("Recargando CLI para usar la nueva version...", COLOR_CYAN))
        os.execv(sys.executable, [sys.executable, str(target_path), *sys.argv[1:]])
    except Exception as exc:
        print(paint(f"No se pudo actualizar el CLI: {exc}", COLOR_RED))


def cmd_init(args: argparse.Namespace) -> None:
    cfg = load_config()
    if args.base_url:
        cfg["base_url"] = args.base_url.rstrip("/")
    if args.api_key:
        cfg["api_key"] = args.api_key.strip()
    if args.model:
        cfg["model"] = args.model.strip()
    if args.max_context_messages is not None:
        cfg["max_context_messages"] = max(2, int(args.max_context_messages))
    if args.mode:
        cfg["mode"] = args.mode
    if args.workspace:
        cfg["workspace"] = str(Path(args.workspace).resolve())
    if args.auto_approve_tools is not None:
        cfg["auto_approve_tools"] = args.auto_approve_tools
    save_config(cfg)
    print(f"Configuracion guardada en: {CONFIG_FILE}")


def cmd_setup(_: argparse.Namespace) -> None:
    import getpass

    FIXED_BASE_URL = "https://remote.datacentgbx.online/v1"
    SERVER_BASE = FIXED_BASE_URL.rsplit("/v1", 1)[0]

    cfg = load_config()
    cfg["base_url"] = FIXED_BASE_URL

    # ---- Cabecera ----
    print(paint(hr("="), COLOR_BLUE))
    print(paint("  FOLAX DTC CLI — Configuracion", COLOR_BOLD + COLOR_CYAN))
    print(paint(hr("="), COLOR_BLUE))
    print()

    # ---- Selector principal ----
    print(paint("  ¿Como deseas conectarte?", COLOR_BOLD))
    print(f"  {paint('1', COLOR_CYAN)}. Login con usuario y contraseña")
    print(f"  {paint('2', COLOR_CYAN)}. Pegar una API key de modelo especifico")
    print()
    while True:
        opcion = input(paint("  Elige [1/2]: ", COLOR_BOLD + COLOR_GREEN)).strip()
        if opcion in ("1", "2"):
            break
        print(paint("  Opcion invalida. Escribe 1 o 2.", COLOR_RED))
    print()

    if opcion == "1":
        # ---- Opcion 1: Login (acceso global) ----
        print(paint("  ¿Iniciar sesion o registrarse?", COLOR_BOLD))
        print(f"  {paint('1', COLOR_CYAN)}. Iniciar sesion")
        print(f"  {paint('2', COLOR_CYAN)}. Crear cuenta nueva")
        print()
        while True:
            acc_op = input(paint("  Elige [1/2]: ", COLOR_BOLD + COLOR_GREEN)).strip()
            if acc_op in ("1", "2"):
                break
            print(paint("  Opcion invalida.", COLOR_RED))
        action = "login" if acc_op == "1" else "register"
        print()

        username = input(paint("  Usuario: ", COLOR_BOLD + COLOR_GREEN)).strip()
        password = getpass.getpass(paint("  Contraseña: ", COLOR_BOLD + COLOR_GREEN))
        print()

        try:
            resp = auth_api_call("POST", f"{SERVER_BASE}/api/auth/{action}", {"username": username, "password": password})
            session_key = resp.get("api_key", "")
            print(paint(f"  ✓ {action.capitalize()} exitoso", COLOR_GREEN))
        except Exception as exc:
            print(paint(f"  Error: {exc}", COLOR_RED))
            return

        # Cargar modelos disponibles
        print(paint("\n  Cargando modelos disponibles...", COLOR_DIM))
        try:
            model_data = api_call("GET", f"{FIXED_BASE_URL}/models", session_key, timeout=15)
            modelos = [
                str(m.get("id")) for m in model_data.get("data", [])
                if m.get("id") and not str(m.get("id")).startswith("error:")
            ]
        except Exception as exc:
            print(paint(f"  No se pudo obtener modelos: {exc}", COLOR_RED))
            modelos = []

        if modelos:
            global MODEL_COMPLETIONS
            MODEL_COMPLETIONS = modelos
            print(paint("\n  Selecciona el modelo por defecto:", COLOR_BOLD))
            modelo_elegido = pick_model_interactive("")
            if not modelo_elegido:
                modelo_elegido = modelos[0]
        else:
            print(paint("  Sin modelos disponibles. Escribe el nombre manualmente.", COLOR_YELLOW))
            modelo_elegido = input(paint("  Modelo: ", COLOR_BOLD + COLOR_GREEN)).strip()

        cfg["api_key"] = session_key
        cfg["model"] = modelo_elegido
        cfg["key_model"] = ""  # Key global, sin restriccion de modelo
        print(paint(f"\n  ✓ Configuracion global. Modelo: {modelo_elegido}", COLOR_GREEN))

    else:
        # ---- Opcion 2: API key de modelo especifico ----
        print(paint("  Pega la API key del modelo especifico (generada desde el dashboard):", COLOR_DIM))
        raw_key = input(paint("  API key: ", COLOR_BOLD + COLOR_GREEN)).strip()
        print()

        if not raw_key:
            print(paint("  API key vacia. Operacion cancelada.", COLOR_RED))
            return

        print(paint("  Verificando key con el servidor...", COLOR_DIM))
        try:
            info = api_call("GET", f"{SERVER_BASE}/api/key/info", raw_key, timeout=10)
            modelo_vinculado = info.get("key_model") or ""
        except Exception as exc:
            print(paint(f"  No se pudo verificar la key: {exc}", COLOR_RED))
            return

        if not modelo_vinculado:
            print(paint("  Esta key es global (sin modelo especifico asignado).", COLOR_YELLOW))
            print(paint("  Para una key por modelo, genérala desde el dashboard en la seccion API Keys.", COLOR_DIM))
            print()
            modelo_elegido = input(paint("  Modelo (escribe el nombre exacto): ", COLOR_BOLD + COLOR_GREEN)).strip()
            cfg["api_key"] = raw_key
            cfg["model"] = modelo_elegido
            cfg["key_model"] = ""
        else:
            cfg["api_key"] = raw_key
            cfg["model"] = modelo_vinculado
            cfg["key_model"] = modelo_vinculado  # Bloquea el modelo en el chat
            print(paint(f"  ✓ Key vinculada al modelo: {paint(modelo_vinculado, COLOR_BOLD)}", COLOR_GREEN))
            print(paint("  El modelo es fijo. No podras cambiarlo durante el chat.", COLOR_DIM))

    # ---- Guardar (sin pedir modo ni tokens, los maneja el usuario dentro del chat) ----
    if "admin_token" in cfg:
        del cfg["admin_token"]
    save_config(cfg)
    print()
    print(paint("  ✓ Configuracion guardada. Ejecuta 'folax chat' para iniciar.", COLOR_GREEN))
    print(paint(hr("="), COLOR_BLUE))



def cmd_status(_: argparse.Namespace) -> None:
    cfg = load_config()
    masked = ""
    if cfg.get("api_key"):
        k = cfg["api_key"]
        masked = f"{k[:6]}...{k[-4:]}" if len(k) > 10 else "***"
    print(paint(" FOLAX DTC CLI — Estado", COLOR_BOLD + COLOR_CYAN))
    print(f"- Config:             {CONFIG_FILE}")
    print(f"- Base URL:           {cfg.get('base_url') or DEFAULT_BASE_URL}")
    print(f"- API key:            {masked or 'no configurada'}")
    print(f"- Modelo por defecto: {cfg.get('model') or 'no configurado'}")
    print(f"- Max context msgs:   {cfg.get('max_context_messages', 12)}")
    print(f"- Modo:               {cfg.get('mode', 'ask')}")
    print(f"- Workspace:          {Path.cwd()}")
    print(f"- Auto approve:       {'on' if cfg.get('auto_approve_tools') else 'off'}")


def cmd_models(_: argparse.Namespace) -> None:
    cfg = load_config()
    if not cfg.get("api_key"):
        print("Primero configura la CLI con: lanllm setup")
        return
    data = api_call("GET", f"{cfg['base_url']}/models", cfg["api_key"])
    models = data.get("data", [])
    if not models:
        print("No se encontraron modelos.")
        return
    print("Modelos disponibles:")
    for item in models:
        print(f"- {item.get('id')}")


def cmd_usage(_: argparse.Namespace) -> None:
    cfg = load_config()
    base_url = cfg.get("base_url") or DEFAULT_BASE_URL
    api_key = cfg.get("api_key", "")
    server_base = base_url.rsplit("/v1", 1)[0] if base_url.endswith("/v1") else base_url
    try:
        usage_data = api_call("GET", f"{server_base}/api/usage", api_key)
        print(
            f"Uso global: conv={usage_data.get('conversations', 0)} "
            f"msg={usage_data.get('messages', 0)} "
            f"tokens={usage_data.get('total_tokens', 0)}"
        )
    except Exception as exc:
        print(f"No se pudo obtener usage. Verifica tu sesion. Error: {exc}")


def run_agent_turn(
    base_url: str,
    api_key: str,
    model: str,
    conversation_id: str,
    history: list[dict[str, str]],
    workspace: Path,
    auto_approve_tools: bool,
    max_context_messages: int,
) -> tuple[str, list[dict[str, str]]]:
    agent_system = {
        "role": "system",
        "content": (
            "Eres un agente de codigo experto. Ejecutas acciones sobre archivos usando herramientas JSON.\n"
            f"Workspace: {workspace}\n"
            "Rutas siempre RELATIVAS al workspace.\n\n"
            "=== HERRAMIENTAS DISPONIBLES ===\n"
            '{"tool":"list_files","args":{"path":"."}}\n'
            '{"tool":"read_file","args":{"path":"archivo.txt"}}\n'
            '{"tool":"write_file","args":{"path":"archivo.txt","content":"contenido completo"}}\n'
            '{"tool":"append_file","args":{"path":"archivo.txt","content":"texto nuevo al final"}}\n'
            '{"tool":"mkdir","args":{"path":"carpeta/subcarpeta"}}\n'
            '{"tool":"search","args":{"pattern":"texto a buscar","path":"."}}\n'
            '{"tool":"delete_file","args":{"path":"archivo.txt"}}\n'
            '{"tool":"rename_file","args":{"src":"viejo.txt","dst":"nuevo.txt"}}\n'
            '{"tool":"run_command","args":{"command":"npm install","timeout":60}}\n\n'
            "=== REGLAS OBLIGATORIAS ===\n"
            "1. Responde SIEMPRE con JSON puro para herramientas. NUNCA uses markdown (```) alrededor del JSON.\n"
            "2. Para EDITAR un archivo existente: primero read_file para leer, luego write_file con el contenido COMPLETO modificado.\n"
            "3. Puedes encadenar varias herramientas en una misma respuesta.\n"
            "4. Cuando termines todas las acciones, responde con texto normal resumiendo lo que hiciste.\n"
            "5. Los resultados de herramientas te llegan como TOOL_RESULT. Usalos para continuar.\n"
            "6. Si la tarea involucra ejecutar comandos del sistema, usa run_command.\n\n"
            "=== EJEMPLO: editar archivo existente ===\n"
            "Paso 1 - Leer:\n"
            '{"tool":"read_file","args":{"path":"src/app.js"}}\n'
            "Paso 2 - Escribir con contenido modificado:\n"
            '{"tool":"write_file","args":{"path":"src/app.js","content":"...contenido completo nuevo..."}}'
        ),
    }
    working = history[:]
    max_steps = 12  # Aumentado para soportar múltiples herramientas por turno
    for _ in range(max_steps):
        messages_to_send = [agent_system] + working[-max_context_messages:]
        payload = {
            "model": model,
            "messages": messages_to_send,
            "conversation_id": conversation_id,
            "client_id": "cli-agent",
            "title": "Sesion Agent CLI",
        }
        response = api_call("POST", f"{base_url}/chat/completions", api_key, payload, timeout=300)
        assistant = (
            response.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
            .strip()
        )
        working.append({"role": "assistant", "content": assistant})

        # Extrae todas las herramientas de la respuesta (el modelo puede incluir varias)
        tool_calls = extract_all_tool_calls(assistant)
        if not tool_calls:
            # Sin herramientas: la respuesta es la final
            return assistant, working

        # Ejecuta todas las herramientas encontradas en orden
        combined_results = []
        for tool_call in tool_calls:
            tool_name = tool_call.get("tool", "")
            args = tool_call.get("args", {})
            if not auto_approve_tools:
                decision = input(
                    paint(f"Herramienta solicitada: {tool_name} args={args} ¿ejecutar? [y/N]: ", COLOR_YELLOW)
                ).strip().lower()
                if decision not in ("y", "yes", "s", "si"):
                    result = "Ejecucion cancelada por usuario"
                else:
                    result = execute_tool_call(workspace, tool_name, args)
            else:
                result = execute_tool_call(workspace, tool_name, args)
            print(paint(f"tool> {tool_name}", COLOR_CYAN))
            combined_results.append(f"TOOL_RESULT {tool_name}: {result}")

        # Agrega todos los resultados como un único mensaje de contexto
        working.append({"role": "user", "content": "\n".join(combined_results)})

    return "No se pudo finalizar: se alcanzo el maximo de pasos de agente.", working


def cmd_chat_fallback(args: argparse.Namespace) -> None:
    enable_windows_colors()
    setup_slash_completer()
    cfg = load_config()
    base_url = cfg.get("base_url") or "https://datacentgbx.online/v1"
    api_key = cfg.get("api_key") or ""
    key_model_locked = cfg.get("key_model", "")  # Si tiene valor, el modelo es fijo
    selected_model = getattr(args, "model", None)
    client_id = getattr(args, "client_id", os.getenv("HOSTNAME", "cli-client"))
    title = getattr(args, "title", "Sesion CLI")
    # Si la key tiene modelo fijo, ese modelo tiene prioridad siempre
    model = key_model_locked or selected_model or cfg.get("model") or ""
    max_context_messages = int(cfg.get("max_context_messages", 12))
    mode = cfg.get("mode", "ask")
    workspace = Path.cwd().resolve()
    auto_approve_tools = bool(cfg.get("auto_approve_tools", False))

    if not api_key:
        print("No hay API key configurada. Iniciando setup...")
        cmd_setup(args)
        cfg = load_config()
        base_url = cfg.get("base_url") or DEFAULT_BASE_URL
        api_key = cfg.get("api_key") or ""
        model = selected_model or cfg.get("model") or ""
    if not model:
        print("No hay modelo configurado. Ejecuta: lanllm setup")
        return

    # Precarga modelos para autocompletar en /model <TAB>.
    try:
        global MODEL_COMPLETIONS
        model_data = api_call("GET", f"{base_url}/models", api_key)
        MODEL_COMPLETIONS = [str(item.get("id")) for item in model_data.get("data", []) if item.get("id")]
    except Exception:
        MODEL_COMPLETIONS = []

    print_cli_header(base_url, model, client_id)
    print(paint("Tip: escribe '/' y presiona TAB para autocompletar comandos.", COLOR_DIM))
    print(paint(f"Contexto activo: ultimos {max_context_messages} mensajes", COLOR_DIM))
    print(paint(f"Modo actual: {mode} | Workspace: {workspace}", COLOR_DIM))
    print_command_help()
    conversation_id = str(uuid.uuid4())
    history: list[dict[str, str]] = []

    while True:
        try:
            user_text = input(paint("\nTu: ", COLOR_BOLD + COLOR_GREEN)).strip()
        except (EOFError, KeyboardInterrupt):
            print(f"\n{paint('Sesion finalizada.', COLOR_YELLOW)}")
            return

        if not user_text:
            continue
        if user_text.startswith("/") and user_text.strip() == "/":
            print_command_help()
            continue
        if user_text == "/exit":
            print(paint("Sesion finalizada.", COLOR_YELLOW))
            return
        if user_text == "/help":
            print_command_help()
            continue
        if user_text.startswith("/mode "):
            raw_mode = user_text.split(" ", 1)[1].strip().lower()
            if raw_mode not in ("ask", "agent", "delegate"):
                print(paint("Modo invalido. Usa /mode ask, /mode agent o /mode delegate", COLOR_RED))
                continue
            mode = raw_mode
            cfg["mode"] = mode
            print(paint(f"Modo cambiado a: {mode}", COLOR_CYAN))
            if mode == "delegate":
                print(paint("Modo delegacion activo: cada mensaje se envia a /api/delegate (auto-routing con Ollama)", COLOR_DIM))
            continue
        if user_text == "/delegate":
            mode = "delegate"
            print(paint("Modo delegacion activado. Escribe tu solicitud en lenguaje natural.", COLOR_CYAN))
            print(paint("Tip: /mode ask para volver al chat normal.", COLOR_DIM))
            continue
        if user_text.startswith("/workspace "):
            raw_ws = user_text.split(" ", 1)[1].strip()
            new_ws = Path(raw_ws).expanduser().resolve()
            if not new_ws.exists() or not new_ws.is_dir():
                print(paint("Workspace invalido (no existe o no es carpeta).", COLOR_RED))
                continue
            workspace = new_ws
            print(paint(f"Workspace cambiado a: {workspace}", COLOR_CYAN))
            continue
        if user_text.startswith("/approve "):
            raw = user_text.split(" ", 1)[1].strip().lower()
            if raw not in ("on", "off"):
                print(paint("Usa /approve on u /approve off", COLOR_RED))
                continue
            auto_approve_tools = raw == "on"
            cfg["auto_approve_tools"] = auto_approve_tools
            print(paint(f"Auto approve tools: {'on' if auto_approve_tools else 'off'}", COLOR_CYAN))
            continue
        if user_text == "/model":
            if key_model_locked:
                print(paint(f"Modelo bloqueado: esta sesion solo permite '{key_model_locked}'", COLOR_RED))
                continue
            selected = pick_model_interactive(model)
            if selected is not None:
                model = selected
                print(paint(f"Modelo cambiado a: {model}", COLOR_CYAN))
            continue
        if user_text.startswith("/model "):
            if key_model_locked:
                print(paint(f"Modelo bloqueado: esta sesion solo permite '{key_model_locked}'", COLOR_RED))
                continue
            raw_model = user_text.split(" ", 1)[1].strip()
            matches = [m for m in MODEL_COMPLETIONS if raw_model.lower() in m.lower()]
            if len(matches) == 1:
                model = matches[0]
                print(paint(f"Modelo cambiado a: {model}", COLOR_CYAN))
            elif len(matches) > 1:
                print(paint("Coincidencias encontradas:", COLOR_MAGENTA))
                for m in matches[:20]:
                    print(f" - {m}")
                print(paint("Usa /model y el selector para elegir.", COLOR_DIM))
            else:
                model = raw_model
                print(paint(f"Modelo cambiado a: {model}", COLOR_CYAN))
            continue
        if user_text.startswith("/models"):
            try:
                data = api_call("GET", f"{base_url}/models", api_key)
                print(paint(hr(), COLOR_DIM))
                print(paint("Modelos disponibles:", COLOR_BOLD + COLOR_MAGENTA))
                models = data.get("data", [])
                if not models:
                    print(" (sin modelos disponibles)")
                for item in models:
                    print(f" - {item.get('id')}")
                print(paint(hr(), COLOR_DIM))
            except Exception as exc:
                print(paint(f"No se pudo listar modelos: {exc}", COLOR_RED))
            continue
        if user_text.startswith("/key "):
            new_key_val = user_text.split(" ", 1)[1].strip()
            if new_key_val.lower() == "new":
                try:
                    admin_url = f"{base_url.rsplit('/v1', 1)[0]}/api/keys"
                    resp = api_call("POST", admin_url, api_key, {"name": "CLI Auto Generated"})
                    new_api_key = resp.get("api_key")
                    cfg["api_key"] = new_api_key
                    save_config(cfg)
                    api_key = new_api_key
                    print(paint(f"Nueva API key generada y guardada en config: {api_key}", COLOR_GREEN))
                except Exception as exc:
                    print(paint(f"No se pudo generar API key: {exc}", COLOR_RED))
            else:
                api_key = new_key_val
                cfg["api_key"] = api_key
                save_config(cfg)
                print(paint("API key actualizada en memoria y guardada en config.", COLOR_CYAN))
            continue
        if user_text.startswith("/context "):
            raw_n = user_text.split(" ", 1)[1].strip()
            try:
                max_context_messages = max(2, int(raw_n))
                cfg["max_context_messages"] = max_context_messages
                print(paint(f"Contexto ajustado a {max_context_messages} mensajes.", COLOR_CYAN))
            except ValueError:
                print(paint("Valor invalido. Usa /context 12", COLOR_RED))
            continue
        if user_text == "/new":
            conversation_id = str(uuid.uuid4())
            history = []
            print(paint("Nueva conversacion iniciada.", COLOR_CYAN))
            continue
        if user_text == "/history":
            turns = len([m for m in history if m.get("role") == "user"])
            print(paint(hr(), COLOR_DIM))
            print(f"{paint('Historial', COLOR_BOLD + COLOR_MAGENTA)} turnos={turns} mensajes={len(history)}")
            print(paint(hr(), COLOR_DIM))
            continue
        if user_text == "/save":
            cfg["model"] = model
            cfg["api_key"] = api_key
            cfg["mode"] = mode
            cfg["auto_approve_tools"] = auto_approve_tools
            cfg["max_context_messages"] = max_context_messages
            save_config(cfg)
            print(paint(f"Configuracion guardada en: {CONFIG_FILE}", COLOR_CYAN))
            continue
        if user_text == "/update":
            cmd_update(args)
            continue
        if user_text == "/usage":
            try:
                server_base = base_url.rsplit('/v1', 1)[0] if base_url.endswith("/v1") else base_url
                usage_data = api_call("GET", f"{server_base}/api/usage", api_key)
                print(paint(hr(), COLOR_DIM))
                print(
                    f"{paint('Uso global', COLOR_BOLD + COLOR_MAGENTA)} "
                    f"conv={usage_data.get('conversations', 0)} "
                    f"msg={usage_data.get('messages', 0)} "
                    f"tokens={usage_data.get('total_tokens', 0)}"
                )
                print(paint(hr(), COLOR_DIM))
            except Exception as exc:
                print(paint(f"No se pudo obtener usage. Error: {exc}", COLOR_RED))
            continue
        if user_text == "/nodes":
            try:
                server_base = base_url.rsplit('/v1', 1)[0] if base_url.endswith("/v1") else base_url
                nodos_data = api_call("GET", f"{server_base}/api/nodes", api_key)
                nodos = nodos_data.get("nodos", [])
                print(paint(hr(), COLOR_DIM))
                print(paint("Nodos del cluster FOLAX DTC:", COLOR_BOLD + COLOR_CYAN))
                if not nodos:
                    print(paint("  Sin nodos registrados. Se usa Ollama local.", COLOR_YELLOW))
                else:
                    for n in nodos:
                        status_icon = paint("●", COLOR_GREEN) if n.get("online") else paint("○", COLOR_RED)
                        cb = paint(" [CB]", COLOR_YELLOW) if n.get("circuit_breaker") else ""
                        score = n.get("score", 0)
                        print(
                            f"  {status_icon} {paint(n.get('name', n.get('id')), COLOR_BOLD)}"
                            f"  score={score}{cb}"
                            f"  modelos={len(n.get('modelos', []))}"
                        )
                print(paint(hr(), COLOR_DIM))
            except Exception as exc:
                print(paint(f"No se pudo obtener nodos. Error: {exc}", COLOR_RED))
            continue
        if user_text == "/status":
            cfg["model"] = model
            cfg["api_key"] = api_key
            render_status_compact(cfg, model)
            continue
        if user_text == "/setup":
            cmd_setup(args)
            cfg = load_config()
            base_url = cfg.get("base_url") or DEFAULT_BASE_URL
            api_key = cfg.get("api_key") or ""
            model = cfg.get("model") or model
            max_context_messages = int(cfg.get("max_context_messages", 12))
            mode = cfg.get("mode", "ask")
            auto_approve_tools = bool(cfg.get("auto_approve_tools", False))
            print(paint("Configuracion recargada.", COLOR_CYAN))
            continue
        if user_text == "/copy":
            if not history or history[-1].get("role") != "assistant":
                print(paint("No hay una respuesta reciente de la IA para copiar.", COLOR_YELLOW))
                continue
            last_text = history[-1].get("content", "")
            try:
                subprocess.run("clip", input=last_text, text=True, check=True)
                print(paint("Respuesta copiada al portapapeles.", COLOR_GREEN))
            except Exception as e:
                print(paint(f"Error al copiar: {e}", COLOR_RED))
            continue
        if user_text == "/clear":
            os.system("cls" if IS_WINDOWS else "clear")
            print_cli_header(base_url, model, client_id)
            continue
        if user_text.startswith("/"):
            print(paint("Comando no reconocido. Usa /help", COLOR_RED))
            continue

        # ── Modo delegacion: envia al router inteligente ─────────────────
        if mode == "delegate":
            stop_event = threading.Event()
            spinner_thread = threading.Thread(target=spinner_while_thinking, args=(stop_event,), daemon=True)
            spinner_thread.start()
            try:
                result = delegate_request(base_url, api_key, user_text)
            except Exception as exc:
                stop_event.set()
                spinner_thread.join()
                print(paint(f"Error: {exc}", COLOR_RED))
                continue
            finally:
                stop_event.set()
                spinner_thread.join()
            print_delegate_result(result)
            # Guardar en historial local tambien
            history.append({"role": "user", "content": user_text})
            history.append({"role": "assistant", "content": result.get('response', '')})
            continue

        history.append({"role": "user", "content": user_text})
        started_at = time.perf_counter()
        stop_event = threading.Event()
        spinner_thread = threading.Thread(target=spinner_while_thinking, args=(stop_event,), daemon=True)
        spinner_thread.start()
        try:
            if mode == "agent":
                assistant, history = run_agent_turn(
                    base_url=base_url,
                    api_key=api_key,
                    model=model,
                    conversation_id=conversation_id,
                    history=history,
                    workspace=workspace,
                    auto_approve_tools=auto_approve_tools,
                    max_context_messages=max_context_messages,
                )
            else:
                messages_to_send = history[-max_context_messages:]
                payload = {
                    "model": model,
                    "messages": messages_to_send,
                    "conversation_id": conversation_id,
                    "client_id": client_id,
                    "title": title,
                }
                response = api_call("POST", f"{base_url}/chat/completions", api_key, payload)
                assistant = (
                    response.get("choices", [{}])[0]
                    .get("message", {})
                    .get("content", "")
                    .strip()
                )
                history.append({"role": "assistant", "content": assistant})
        except Exception as exc:
            stop_event.set()
            spinner_thread.join(timeout=1.0)
            print(paint(f"Error > {exc}", COLOR_RED))
            history.pop()
            continue
        finally:
            stop_event.set()
            spinner_thread.join(timeout=1.0)

        elapsed_ms = int((time.perf_counter() - started_at) * 1000)
        print(paint(hr(), COLOR_DIM))
        print(f"{paint('IA >', COLOR_BOLD + COLOR_MAGENTA)}\n{format_assistant_output(assistant)}")
        print(paint(f"T: {elapsed_ms} ms", COLOR_DIM))
        print(paint(hr(), COLOR_DIM))


def run_tui(args: argparse.Namespace, cfg: dict) -> None:
    from textual.app import App, ComposeResult
    from textual.containers import Horizontal, Vertical, VerticalScroll, Container
    from textual.widgets import Header, Footer, Input, Static, Markdown, LoadingIndicator, Button, Label
    from textual.screen import ModalScreen
    from textual.binding import Binding
    from textual import work
    import queue
    import threading
    import uuid
    from pathlib import Path
    import pyperclip
    import os

    base_url = cfg.get("base_url") or DEFAULT_BASE_URL
    api_key = cfg.get("api_key") or ""
    model = getattr(args, "model", None) or cfg.get("model") or ""
    max_context_messages = int(cfg.get("max_context_messages", 12))
    mode = cfg.get("mode", "ask")
    workspace = Path.cwd().resolve()
    auto_approve_tools = bool(cfg.get("auto_approve_tools", False))
    client_id = getattr(args, "client_id", os.getenv("HOSTNAME", "cli-client"))
    title = getattr(args, "title", "Sesion CLI")

    if not api_key or not model:
        print("Falta API key o modelo. Ejecuta la CLI tradicional y usa '/setup'.")
        return

    class ToolApprovalScreen(ModalScreen[bool]):
        CSS = """
        ToolApprovalScreen {
            align: center middle;
        }
        #dialog {
            grid-size: 2;
            grid-gutter: 1 2;
            grid-rows: 1fr 3;
            padding: 1 2;
            width: 60;
            height: 15;
            border: thick $background 80%;
            background: $surface;
        }
        #question {
            column-span: 2;
            height: 1fr;
            width: 1fr;
            content-align: center middle;
        }
        Button {
            width: 100%;
        }
        """

        def __init__(self, tool_name: str, args_dict: dict):
            super().__init__()
            self.tool_name = tool_name
            self.args_dict = args_dict

        def compose(self) -> ComposeResult:
            yield Container(
                Label(f"Agent solicita ejecutar:\nHerramienta: {self.tool_name}\nArgumentos: {self.args_dict}\n\n¿Aprobar?", id="question"),
                Button("Aprobar", variant="success", id="btn_yes"),
                Button("Rechazar", variant="error", id="btn_no"),
                id="dialog",
            )

        def on_button_pressed(self, event: Button.Pressed) -> None:
            if event.button.id == "btn_yes":
                self.dismiss(True)
            else:
                self.dismiss(False)

    class ChatMessage(Static):
        def __init__(self, text: str, role: str):
            super().__init__()
            self.text = text
            self.role = role

        def compose(self) -> ComposeResult:
            yield Markdown(self.text)

    class AgentToolBox(Static):
        def __init__(self):
            super().__init__()
            self.lines = []

        def compose(self) -> ComposeResult:
            yield Markdown("⏳ **Ejecutando herramientas...**", id="toolbox-content")

        def on_mount(self) -> None:
            self.add_class("-visible")

        def add_tool_execution(self, tool_name: str, args_dict: dict):
            args_str = str(args_dict)
            if len(args_str) > 50:
                args_str = args_str[:47] + "..."
            self.lines.append(f"- **{tool_name}** `{args_str}`")
            self.update_content()

        def add_tool_result(self, tool_name: str, result: str):
            # Si el resultado es un diff de write_file, renderizarlo como bloque diff coloreado
            if result.startswith("[DIFF]"):
                header = result.split("\n")[0]  # ej: "[DIFF] src/app.js"
                diff_body = "\n".join(result.split("\n")[1:])
                # Formatea el diff como bloque markdown para que se vea con colores
                formatted = f"\n\n```diff\n{diff_body}\n```"
                self.lines[-1] += f" ➔ {header}{formatted}"
            elif result.startswith("[NEW]") or result.startswith("[DEL]") or result.startswith("[MOVE]") or result.startswith("[EXIT") or result.startswith("[OK]"):
                self.lines[-1] += f" ➔ *{result}*"
            else:
                display_result = result.replace('\n', ' ')
                if len(display_result) > 80:
                    display_result = display_result[:77] + "..."
                self.lines[-1] += f" ➔ *{display_result}*"
            self.update_content()

        def mark_done(self):
            self.add_class("-done")
            self.update_content(done=True)

        def update_content(self, done: bool = False):
            md = self.query_one("#toolbox-content", Markdown)
            status = "✅ **Herramientas ejecutadas**" if done else "⏳ **Ejecutando herramientas...**"
            content = f"{status}\n\n" + "\n".join(self.lines)
            md.update(content)

    class LanLLMApp(App):
        CSS = """
        Screen {
            layout: horizontal;
        }
        #sidebar {
            width: 30;
            height: 100%;
            dock: left;
            background: $panel;
            border-right: vkey $background;
            padding: 1;
        }
        #main {
            width: 1fr;
            height: 100%;
            layout: vertical;
        }
        #chat_area {
            height: 1fr;
            overflow-y: scroll;
            padding: 1 2;
        }
        #input_area {
            height: 3;
            dock: bottom;
            layout: horizontal;
            border-top: solid $panel;
        }
        Input {
            width: 1fr;
        }
        ChatMessage {
            margin: 1 0;
            padding: 1;
            border: solid $accent;
            background: $surface;
        }
        .user_msg {
            border: solid $success;
            background: $surface-lighten-1;
        }
        .loader {
            display: none;
            height: 3;
            content-align: center middle;
        }
        .loader.-active {
            display: block;
        }
        Label.info {
            color: $text-muted;
            margin-bottom: 1;
        }
        AgentToolBox {
            margin: 1 0;
            padding: 1;
            border: solid $accent;
            background: $surface;
            opacity: 0;
            transition: opacity 300ms linear, background 300ms linear;
        }
        AgentToolBox.-visible {
            opacity: 1;
        }
        AgentToolBox.-done {
            border: solid $success;
            background: $surface-lighten-1;
        }
        """

        BINDINGS = [
            Binding("ctrl+q", "quit", "Salir"),
            Binding("ctrl+l", "clear", "Limpiar"),
            Binding("ctrl+c", "copy_last", "Copiar"),
        ]

        def __init__(self):
            super().__init__()
            self.conversation_id = str(uuid.uuid4())
            self.history = []
            self.app_mode = mode
            self.app_model = model
            self.app_workspace = workspace
            self.app_auto_approve = auto_approve_tools
            self.app_max_context = max_context_messages
            self.approval_queue = queue.Queue()

        def compose(self) -> ComposeResult:
            yield Header()
            with Container(id="sidebar"):
                yield Label("[bold cyan] F-GBX [/]", classes="info")
                yield Static("="*20)
                yield Label(f"Modo: {self.app_mode}", id="lbl_mode", classes="info")
                yield Label(f"Modelo: {self.app_model}", id="lbl_model", classes="info")
                yield Label(f"WS: {self.app_workspace.name}", id="lbl_ws", classes="info")
                yield Label(f"Auto-Approve: {'On' if self.app_auto_approve else 'Off'}", id="lbl_approve", classes="info")
                yield Static("="*20)
                yield Label("Comandos Principales:\n/help (Ver todos)\n/mode <ask|agent>\n/model <nombre>\n/workspace <ruta>\n/status\n/usage\n/update\n/setup\n/save\n/clear\n/exit", classes="info")

            with Vertical(id="main"):
                yield VerticalScroll(id="chat_area")
                yield LoadingIndicator(id="loader", classes="loader")
                with Horizontal(id="input_area"):
                    yield Input(placeholder="Escribe un mensaje o comando...", id="user_input")
            yield Footer()

        def on_mount(self) -> None:
            self.query_one("#user_input").focus()
            self.append_chat("¡Bienvenido al CLI Interactivo de M-LAB! (Modo TUI)\nEscribe `/help` para ver la lista completa de comandos.", "assistant")

        def append_chat(self, text: str, role: str) -> None:
            chat_area = self.query_one("#chat_area", VerticalScroll)
            msg = ChatMessage(text, role)
            if role == "user":
                msg.add_class("user_msg")
            chat_area.mount(msg)
            chat_area.scroll_end(animate=False)
            chat_area.scroll_end(animate=False)

        async def action_clear(self) -> None:
            chat_area = self.query_one("#chat_area", VerticalScroll)
            await chat_area.query("ChatMessage").remove()
            self.history = []
            self.conversation_id = str(uuid.uuid4())
            self.append_chat("Historial limpiado.", "assistant")

        async def action_copy_last(self) -> None:
            if not self.history or self.history[-1].get("role") != "assistant":
                self.notify("No hay respuesta para copiar", severity="warning")
                return
            try:
                pyperclip.copy(self.history[-1].get("content", ""))
                self.notify("Respuesta copiada al portapapeles")
            except Exception as e:
                self.notify(f"Error al copiar: {e}", severity="error")

        async def on_input_submitted(self, message: Input.Submitted) -> None:
            text = message.value.strip()
            if not text:
                return
            
            inp = self.query_one("#user_input", Input)
            inp.value = ""
            
            if text.startswith("/"):
                await self.handle_slash_command(text)
                return

            self.append_chat(text, "user")
            self.history.append({"role": "user", "content": text})
            self.query_one("#loader").add_class("-active")
            inp.disabled = True
            
            self.process_chat()

        async def handle_slash_command(self, text: str) -> None:
            nonlocal api_key
            cmd = text.split(" ")[0].lower()
            if cmd == "/help":
                help_msg = (
                    "**Comandos TUI soportados:**\n"
                    "- `/mode <ask|agent>`: Cambiar modo\n"
                    "- `/workspace <ruta>`: Definir carpeta para agente\n"
                    "- `/approve <on|off>`: Confirmación de herramientas\n"
                    "- `/model <nombre>`: Cambiar modelo actual\n"
                    "- `/key <api_key|new>`: Cambiar API key o generar nueva\n"
                    "- `/models`: Listar modelos disponibles\n"
                    "- `/new`: Iniciar nueva conversación\n"
                    "- `/history`: Ver resumen del historial actual\n"
                    "- `/context <n>`: Ajustar tamaño del contexto\n"
                    "- `/usage`: Ver uso global\n"
                    "- `/update`: Actualizar CLI (info)\n"
                    "- `/save`: Guardar configuración local\n"
                    "- `/status`: Ver estado rápido\n"
                    "- `/setup`: Configuración interactiva (info)\n"
                    "- `/copy`: Copiar la última respuesta\n"
                    "- `/clear`: Limpiar pantalla\n"
                    "- `/exit`: Salir"
                )
                self.append_chat(help_msg, "assistant")
            elif cmd == "/mode" and " " in text:
                new_mode = text.split(" ", 1)[1].strip().lower()
                if new_mode in ("ask", "agent"):
                    self.app_mode = new_mode
                    self.query_one("#lbl_mode", Label).update(f"Modo: {self.app_mode}")
                    self.append_chat(f"*Modo cambiado a {self.app_mode}*", "assistant")
            elif cmd == "/mode":
                if " " not in text:
                    self.append_chat("**Uso:** `/mode ask` o `/mode agent`", "assistant")
                else:
                    new_mode = text.split(" ", 1)[1].strip().lower()
                    if new_mode in ("ask", "agent"):
                        self.app_mode = new_mode
                        self.query_one("#lbl_mode", Label).update(f"Modo: {self.app_mode}")
                        self.append_chat(f"*Modo cambiado a {self.app_mode}*", "assistant")
                    else:
                        self.append_chat("**Error:** Modo inválido. Usa `/mode ask` o `/mode agent`", "assistant")
            elif cmd == "/model":
                if " " not in text:
                    # Lista los modelos disponibles para elegir
                    self.query_one("#loader").add_class("-active")
                    self.fetch_models_for_selection()
                else:
                    self.app_model = text.split(" ", 1)[1].strip()
                    self.query_one("#lbl_model", Label).update(f"Modelo: {self.app_model}")
                    self.append_chat(f"*Modelo cambiado a {self.app_model}*", "assistant")
            elif cmd == "/workspace":
                if " " not in text:
                    self.append_chat(f"**Workspace actual:** `{self.app_workspace}`\n\n**Uso:** `/workspace <ruta>`", "assistant")
                else:
                    raw_ws = text.split(" ", 1)[1].strip()
                    new_ws = Path(raw_ws).expanduser().resolve()
                    if new_ws.exists() and new_ws.is_dir():
                        self.app_workspace = new_ws
                        self.query_one("#lbl_ws", Label).update(f"WS: {self.app_workspace.name}")
                        self.append_chat(f"*Workspace actualizado a: {self.app_workspace}*", "assistant")
                    else:
                        self.append_chat("**Error:** Ruta inválida o no es carpeta.", "assistant")
            elif cmd == "/approve":
                if " " not in text:
                    estado = "On" if self.app_auto_approve else "Off"
                    self.append_chat(f"**Auto-Approve actual:** {estado}\n\n**Uso:** `/approve on` o `/approve off`", "assistant")
                else:
                    raw_app = text.split(" ", 1)[1].strip().lower()
                    if raw_app in ("on", "off"):
                        self.app_auto_approve = (raw_app == "on")
                        self.query_one("#lbl_approve", Label).update(f"Auto-Approve: {'On' if self.app_auto_approve else 'Off'}")
                        self.append_chat(f"*Auto-Approve cambiado a: {raw_app}*", "assistant")
                    else:
                        self.append_chat("**Error:** Usa `/approve on` o `/approve off`", "assistant")
            elif cmd == "/key":
                if " " not in text:
                    self.append_chat("**Uso:** `/key <api_key>` o `/key new` para generar una nueva.", "assistant")
                else:
                    new_key_val = text.split(" ", 1)[1].strip()
                    if new_key_val.lower() == "new":
                        try:
                            admin_url = f"{base_url.rsplit('/v1', 1)[0]}/api/keys"
                            resp = api_call("POST", admin_url, api_key, {"name": "CLI Auto Generated"})
                            new_api_key = resp.get("api_key")
                            cfg["api_key"] = new_api_key
                            save_config(cfg)
                            api_key = new_api_key
                            self.append_chat("*Nueva API key generada y guardada.*", "assistant")
                        except Exception as exc:
                            self.append_chat(f"**Error al generar API key:** {exc}", "assistant")
                    else:
                        api_key = new_key_val
                        cfg["api_key"] = api_key
                        save_config(cfg)
                        self.append_chat("*API key actualizada.*", "assistant")
            elif cmd == "/context":
                if " " not in text:
                    self.append_chat(f"**Contexto actual:** {self.app_max_context} mensajes.\n\n**Uso:** `/context <n>`", "assistant")
                else:
                    try:
                        self.app_max_context = max(2, int(text.split(" ", 1)[1].strip()))
                        self.append_chat(f"*Contexto ajustado a {self.app_max_context} mensajes.*", "assistant")
                    except ValueError:
                        self.append_chat("**Error:** Valor inválido. Ejemplo: `/context 12`", "assistant")
            elif cmd == "/history":
                turns = len([m for m in self.history if m.get("role") == "user"])
                self.append_chat(f"**Historial:** turnos={turns} mensajes={len(self.history)}", "assistant")
            elif cmd == "/status":
                masked = ""
                k = cfg.get("api_key", "")
                if k:
                    masked = f"{k[:6]}...{k[-4:]}" if len(k) > 10 else "***"
                self.append_chat(
                    f"**Estado:**\n"
                    f"- Modo: {self.app_mode}\n"
                    f"- Modelo: {self.app_model}\n"
                    f"- Workspace: {self.app_workspace}\n"
                    f"- Auto Approve: {'On' if self.app_auto_approve else 'Off'}\n"
                    f"- Max Context: {self.app_max_context}\n"
                    f"- API Key: {masked or 'no configurada'}\n"
                    f"- Base URL: {base_url}",
                    "assistant"
                )
            elif cmd == "/new":
                self.history = []
                self.conversation_id = str(uuid.uuid4())
                self.append_chat("*Nueva conversación iniciada.*", "assistant")
            elif cmd == "/save":
                cfg["mode"] = self.app_mode
                cfg["model"] = self.app_model
                cfg["workspace"] = str(self.app_workspace)
                cfg["auto_approve_tools"] = self.app_auto_approve
                cfg["max_context_messages"] = self.app_max_context
                save_config(cfg)
                self.append_chat("*Configuración guardada en archivo local.*", "assistant")
            elif cmd == "/models":
                self.query_one("#loader").add_class("-active")
                self.fetch_models_bg()
            elif cmd == "/usage":
                self.query_one("#loader").add_class("-active")
                self.fetch_usage_bg()
            elif cmd == "/update":
                self.append_chat("*Para actualizar la CLI, por favor sal (con /exit) y ejecuta `lanllm update` en la terminal normal.*", "assistant")
            elif cmd == "/setup":
                self.append_chat("*El comando `/setup` interactivo requiere salir de la TUI. Por favor usa `/exit` y ejecuta `lanllm setup`.*", "assistant")
            elif cmd == "/copy":
                await self.action_copy_last()
            elif cmd == "/clear":
                await self.action_clear()
            elif cmd == "/exit":
                self.exit()
            else:
                self.append_chat(f"Comando no reconocido: `{text}`. Escribe `/help` para ver la lista.", "assistant")

        @work(thread=True)
        def fetch_models_bg(self):
            try:
                data = api_call("GET", f"{base_url}/models", api_key)
                models = data.get("data", [])
                lines = ["**Modelos disponibles:**"] + [f"- {m.get('id')}" for m in models] if models else ["Sin modelos"]
                self.call_from_thread(self.on_chat_success, "\n".join(lines))
            except Exception as exc:
                self.call_from_thread(self.on_chat_error, str(exc))

        @work(thread=True)
        def fetch_usage_bg(self):
            try:
                s_base = base_url.rsplit('/v1', 1)[0] if base_url.endswith("/v1") else base_url
                usage_data = api_call("GET", f"{s_base}/api/usage", api_key)
                msg = f"**Uso global:** conv={usage_data.get('conversations',0)} msg={usage_data.get('messages',0)} tokens={usage_data.get('total_tokens',0)}"
                self.call_from_thread(self.on_chat_success, msg)
            except Exception as exc:
                self.call_from_thread(self.on_chat_error, str(exc))

        @work(thread=True)
        def fetch_models_for_selection(self):
            try:
                data = api_call("GET", f"{base_url}/models", api_key)
                models = data.get("data", [])
                if not models:
                    self.call_from_thread(self.on_chat_success, "*No hay modelos disponibles.*")
                    return
                lines = ["**Modelos disponibles** (usa `/model <nombre>` para elegir):\n"]
                for m in models:
                    lines.append(f"- `{m.get('id')}`")
                self.call_from_thread(self.on_chat_success, "\n".join(lines))
            except Exception as exc:
                self.call_from_thread(self.on_chat_error, str(exc))

        @work(thread=True)
        def process_chat(self) -> None:
            try:
                if self.app_mode == "agent":
                    self.run_agent_turn_tui()
                else:
                    self.run_ask_turn()
            except Exception as exc:
                self.call_from_thread(self.on_chat_error, str(exc))

        def on_chat_error(self, err: str) -> None:
            self.append_chat(f"**Error:** {err}", "assistant")
            if self.history and self.history[-1].get("role") == "user":
                self.history.pop()
            self.query_one("#loader").remove_class("-active")
            inp = self.query_one("#user_input", Input)
            inp.disabled = False
            inp.focus()

        def on_chat_success(self, assistant_text: str) -> None:
            self.append_chat(assistant_text, "assistant")
            self.query_one("#loader").remove_class("-active")
            inp = self.query_one("#user_input", Input)
            inp.disabled = False
            inp.focus()

        def run_ask_turn(self):
            messages_to_send = self.history[-max_context_messages:]
            payload = {
                "model": self.app_model,
                "messages": messages_to_send,
                "conversation_id": self.conversation_id,
                "client_id": client_id,
                "title": title,
            }
            response = api_call("POST", f"{base_url}/chat/completions", api_key, payload)
            assistant = response.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
            self.history.append({"role": "assistant", "content": assistant})
            self.call_from_thread(self.on_chat_success, assistant)

        def request_approval_sync(self, tool_name: str, args: dict) -> bool:
            self.call_from_thread(self._show_approval_modal, tool_name, args)
            return self.approval_queue.get()

        def _show_approval_modal(self, tool_name: str, args: dict):
            def callback(result: bool):
                self.approval_queue.put(result)
            self.push_screen(ToolApprovalScreen(tool_name, args), callback)

        def mount_tool_box(self):
            chat_area = self.query_one("#chat_area", VerticalScroll)
            self.current_tool_box = AgentToolBox()
            chat_area.mount(self.current_tool_box)
            chat_area.scroll_end(animate=False)

        def add_tool_execution_ui(self, tool_name: str, args_dict: dict):
            if hasattr(self, "current_tool_box") and self.current_tool_box:
                self.current_tool_box.add_tool_execution(tool_name, args_dict)
                self.query_one("#chat_area", VerticalScroll).scroll_end(animate=False)

        def add_tool_result_ui(self, tool_name: str, result: str):
            if hasattr(self, "current_tool_box") and self.current_tool_box:
                self.current_tool_box.add_tool_result(tool_name, result)

        def mark_tool_box_done_ui(self):
            if hasattr(self, "current_tool_box") and self.current_tool_box:
                self.current_tool_box.mark_done()
                self.current_tool_box = None

        def run_agent_turn_tui(self):
            agent_system = {
                "role": "system",
                "content": (
                    "Eres un agente de codigo experto. Ejecutas acciones sobre archivos usando herramientas JSON.\n"
                    f"Workspace: {self.app_workspace}\n"
                    "Rutas siempre RELATIVAS al workspace.\n\n"
                    "=== HERRAMIENTAS DISPONIBLES ===\n"
                    '{"tool":"list_files","args":{"path":"."}}\n'
                    '{"tool":"read_file","args":{"path":"archivo.txt"}}\n'
                    '{"tool":"write_file","args":{"path":"archivo.txt","content":"contenido completo"}}\n'
                    '{"tool":"append_file","args":{"path":"archivo.txt","content":"texto nuevo al final"}}\n'
                    '{"tool":"mkdir","args":{"path":"carpeta/subcarpeta"}}\n'
                    '{"tool":"search","args":{"pattern":"texto a buscar","path":"."}}\n'
                    '{"tool":"delete_file","args":{"path":"archivo.txt"}}\n'
                    '{"tool":"rename_file","args":{"src":"viejo.txt","dst":"nuevo.txt"}}\n'
                    '{"tool":"run_command","args":{"command":"npm install","timeout":60}}\n\n'
                    "=== REGLAS OBLIGATORIAS ===\n"
                    "1. Responde SIEMPRE con JSON puro para herramientas. NUNCA uses markdown (```) alrededor del JSON.\n"
                    "2. Para EDITAR un archivo existente: primero read_file para leer, luego write_file con el contenido COMPLETO modificado.\n"
                    "3. Puedes encadenar varias herramientas en una misma respuesta.\n"
                    "4. Si la tarea es compleja o ambigua, DEBES generar un plan paso a paso primero (SOLO texto, sin JSON). El usuario confirmara antes de ejecutar.\n"
                    "5. Cuando termines todas las acciones, responde con texto normal resumiendo lo que hiciste.\n"
                    "6. Los resultados de herramientas te llegan como TOOL_RESULT. Usalos para continuar.\n"
                    "7. Si la tarea involucra ejecutar comandos del sistema (npm, pip, git, etc), usa run_command.\n"
                ),
            }
            working = self.history[:]
            max_steps = 12
            for _ in range(max_steps):
                messages_to_send = [agent_system] + working[-self.app_max_context:]
                payload = {
                    "model": self.app_model,
                    "messages": messages_to_send,
                    "conversation_id": self.conversation_id,
                    "client_id": "cli-agent",
                    "title": "Sesion Agent CLI",
                }
                response = api_call("POST", f"{base_url}/chat/completions", api_key, payload, timeout=300)
                assistant = response.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
                working.append({"role": "assistant", "content": assistant})

                tool_calls = extract_all_tool_calls(assistant)
                if not tool_calls:
                    self.history = working
                    if hasattr(self, "current_tool_box") and self.current_tool_box:
                        self.call_from_thread(self.mark_tool_box_done_ui)
                    self.call_from_thread(self.on_chat_success, assistant)
                    return

                if not hasattr(self, "current_tool_box") or not self.current_tool_box:
                    self.call_from_thread(self.mount_tool_box)
                    import time
                    time.sleep(0.05)

                combined_results = []
                for tool_call in tool_calls:
                    tool_name = tool_call.get("tool", "")
                    t_args = tool_call.get("args", {})
                    
                    self.call_from_thread(self.add_tool_execution_ui, tool_name, t_args)
                    
                    if not self.app_auto_approve:
                        decision = self.request_approval_sync(tool_name, t_args)
                        if not decision:
                            result = "Ejecucion cancelada por usuario"
                        else:
                            result = execute_tool_call(self.app_workspace, tool_name, t_args)
                    else:
                        result = execute_tool_call(self.app_workspace, tool_name, t_args)
                    
                    self.call_from_thread(self.add_tool_result_ui, tool_name, result)
                    combined_results.append(f"TOOL_RESULT {tool_name}: {result}")

                working.append({"role": "user", "content": "\n".join(combined_results)})
            
            self.history = working
            if hasattr(self, "current_tool_box") and self.current_tool_box:
                self.call_from_thread(self.mark_tool_box_done_ui)
            self.call_from_thread(self.on_chat_success, "No se pudo finalizar: se alcanzo maximo de pasos.")

    app = LanLLMApp()
    app.run()

def ensure_textual_installed() -> bool:
    try:
        import textual
        import pyperclip
        return True
    except ImportError:
        print(paint("Instalando interfaz grafica moderna (Textual)...", COLOR_CYAN))
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "textual", "pyperclip"])
            return True
        except Exception as exc:
            print(paint(f"Error autoinstalando TUI: {exc}", COLOR_RED))
            return False

def cmd_chat(args: argparse.Namespace) -> None:
    cfg = load_config()
    if ensure_textual_installed():
        run_tui(args, cfg)
    else:
        print(paint("Iniciando modo fallback de consola (TUI no disponible).", COLOR_YELLOW))
        cmd_chat_fallback(args)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="folax",
        description="Cliente CLI para el orquestador FOLAX DTC",
    )
    sub = parser.add_subparsers(dest="command")

    p_init = sub.add_parser("init", help="Guardar base_url, api_key y modelo")
    p_init.add_argument("--base-url", help="Ej: http://192.168.1.50:8000/v1")
    p_init.add_argument("--api-key", help="API key lan_...")
    p_init.add_argument("--model", help="Modelo por defecto")
    p_init.add_argument("--admin-token", help="Token admin opcional para /usage")
    p_init.add_argument("--max-context-messages", type=int, help="Mensajes maximos para acelerar respuestas")
    p_init.add_argument("--mode", choices=["ask", "agent"], help="Modo por defecto")
    p_init.add_argument("--workspace", help="Ruta de workspace para modo agent")
    p_init.add_argument(
        "--auto-approve-tools",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Aprobar automaticamente herramientas en modo agent",
    )
    p_init.set_defaults(func=cmd_init)

    p_setup = sub.add_parser("setup", help="Configuracion guiada interactiva")
    p_setup.set_defaults(func=cmd_setup)

    p_status = sub.add_parser("status", help="Ver configuracion local")
    p_status.set_defaults(func=cmd_status)

    p_models = sub.add_parser("models", help="Listar modelos disponibles")
    p_models.set_defaults(func=cmd_models)

    p_usage = sub.add_parser("usage", help="Ver uso global del gateway")
    p_usage.set_defaults(func=cmd_usage)

    p_update = sub.add_parser("update", help="Actualizar CLI desde servidor")
    p_update.set_defaults(func=cmd_update)

    p_chat = sub.add_parser("chat", help="Abrir chat interactivo en terminal")
    p_chat.add_argument("--model", help="Sobrescribe modelo por defecto")
    p_chat.add_argument("--client-id", default=os.getenv("HOSTNAME", "cli-client"))
    p_chat.add_argument("--title", default="Sesion CLI")
    p_chat.set_defaults(func=cmd_chat)

    p_run = sub.add_parser("run", help="Alias de chat")
    p_run.add_argument("--model", help="Sobrescribe modelo por defecto")
    p_run.add_argument("--client-id", default=os.getenv("HOSTNAME", "cli-client"))
    p_run.add_argument("--title", default="Sesion CLI")
    p_run.set_defaults(func=cmd_chat)

    p_start = sub.add_parser("start", help="Alias de chat")
    p_start.add_argument("--model", help="Sobrescribe modelo por defecto")
    p_start.add_argument("--client-id", default=os.getenv("HOSTNAME", "cli-client"))
    p_start.add_argument("--title", default="Sesion CLI")
    p_start.set_defaults(func=cmd_chat)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if not args.command:
        cmd_chat(args)
        return 0
    args.func(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
