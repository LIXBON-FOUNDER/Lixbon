"""Entrada del CLI: argparse y comandos no interactivos (stdlib puro).

Los comandos `init/status/models/usage/update` funcionan sin dependencias.
`chat` (y `setup`/`ui-demo`) instalan prompt_toolkit + rich si faltan.
"""
import argparse
import hashlib
import os
import sys
import time
from pathlib import Path
from urllib import request

from lixbon_cli.api import ApiClient, ApiError
from lixbon_cli.config import (
    CLI_VERSION,
    CONFIG_FILE,
    DEFAULT_BASE_URL,
    load_config,
    mask_key,
    save_config,
    server_base,
)

REQUIRED_PACKAGES = ("prompt_toolkit", "rich")


def ensure_deps() -> bool:
    """Instala las dependencias de la interfaz si faltan (patrón autoinstalable)."""
    missing = []
    for pkg in REQUIRED_PACKAGES:
        try:
            __import__(pkg)
        except ImportError:
            missing.append(pkg)
    if not missing:
        return True
    print(f"Instalando la interfaz del CLI ({', '.join(missing)})…")
    import subprocess

    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", *missing])
        return True
    except Exception as exc:
        print(f"No se pudieron instalar las dependencias: {exc}")
        print(f"Instálalas manualmente: {sys.executable} -m pip install {' '.join(missing)}")
        return False


# ── comandos no interactivos ────────────────────────────────────────────────

def cmd_init(args: argparse.Namespace) -> int:
    cfg = load_config()
    if args.base_url:
        cfg["base_url"] = args.base_url.rstrip("/")
    if args.api_key:
        cfg["api_key"] = args.api_key.strip()
    if args.model:
        cfg["model"] = args.model.strip()
    if args.max_context_messages is not None:
        cfg["max_context_messages"] = max(2, int(args.max_context_messages))
    if args.context_window is not None:
        cfg["context_window"] = max(1024, int(args.context_window))
    if args.mode:
        cfg["mode"] = args.mode
    if args.workspace:
        cfg["workspace"] = str(Path(args.workspace).resolve())
    save_config(cfg)
    print(f"Configuración guardada en: {CONFIG_FILE}")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    cfg = load_config()
    print(f"lixbon CLI v{CLI_VERSION}")
    print(f"- Config:              {CONFIG_FILE}")
    print(f"- Base URL:            {cfg.get('base_url') or DEFAULT_BASE_URL}")
    print(f"- API key:             {mask_key(cfg.get('api_key', ''))}")
    print(f"- Cuenta:              {cfg.get('account_email') or '-'}")
    print(f"- Modelo por defecto:  {cfg.get('model') or 'no configurado'}")
    print(f"- Modo:                {cfg.get('mode', 'ask')}")
    print(f"- Ventana de contexto: {cfg.get('context_window', 8192)} tokens")
    print(f"- Workspace:           {cfg.get('workspace') or Path.cwd()}")
    return 0


def cmd_models(args: argparse.Namespace) -> int:
    cfg = load_config()
    if not cfg.get("api_key"):
        print("Primero inicia sesión: lixbon (o lixbon setup)")
        return 1
    api = ApiClient(cfg["base_url"], cfg["api_key"])
    try:
        models = api.models()
    except ApiError as exc:
        print(f"No se pudieron listar los modelos: {exc}")
        return 1
    if not models:
        print("No hay modelos disponibles.")
        return 0
    print("Modelos disponibles:")
    for model in models:
        print(f"- {model}")
    return 0


def cmd_usage(args: argparse.Namespace) -> int:
    cfg = load_config()
    api = ApiClient(cfg["base_url"], cfg.get("api_key", ""))
    try:
        data = api.usage()
    except ApiError as exc:
        print(f"No se pudo obtener el uso. Verifica tu sesión. Error: {exc}")
        return 1
    print(
        f"Uso global: conversaciones={data.get('conversations', 0)} "
        f"mensajes={data.get('messages', 0)} tokens={data.get('total_tokens', 0)}"
    )
    return 0


def cmd_update(args: argparse.Namespace | None) -> int:
    """Descarga la última versión del archivo único y se re-ejecuta."""
    target_path = Path(sys.argv[0]).resolve() if sys.argv else None
    module_path = Path(__file__).resolve()
    if module_path.name != "client_cli.py":
        # Ejecutando desde el paquete fuente (dev): el update sobreescribiría
        # un módulo del repo. El artefacto se regenera con apps/cli/build.py.
        if not target_path or target_path.name != "client_cli.py":
            print("Estás ejecutando el CLI desde el código fuente.")
            print("Regenera el artefacto con: python apps/cli/build.py")
            return 1
    real_target = module_path if module_path.name == "client_cli.py" else target_path

    cfg = load_config()
    base = server_base(cfg.get("base_url") or DEFAULT_BASE_URL)
    # El update descarga CÓDIGO que luego se ejecuta: nunca por http plano
    # (un MitM podría inyectar lo que quisiera). localhost queda exento (dev).
    if base.startswith("http://") and "//localhost" not in base and "//127.0.0.1" not in base:
        print("Por seguridad el update requiere HTTPS (tu base_url es http://).")
        return 1
    url = f"{base}/install/client_cli.py?ts={int(time.time() * 1000)}"
    print(f"Actualizando CLI desde: {url}")
    try:
        req = request.Request(
            url=url,
            headers={"Cache-Control": "no-cache", "Pragma": "no-cache"},
            method="GET",
        )
        with request.urlopen(req, timeout=120) as resp:
            content = resp.read().decode("utf-8")
        # Sanity check antes de sobreescribirnos: que sea Python válido y
        # parezca el CLI (si el servidor devuelve un HTML de error o un
        # archivo truncado, no nos autodestruimos).
        try:
            compile(content, "client_cli.py", "exec")
        except SyntaxError:
            print("La descarga no es un CLI válido (¿error del servidor?). No se actualizó nada.")
            return 1
        if "lixbon" not in content:
            print("La descarga no parece el CLI de lixbon. No se actualizó nada.")
            return 1
        old_content = real_target.read_text(encoding="utf-8") if real_target.exists() else ""
        old_hash = hashlib.sha256(old_content.encode("utf-8")).hexdigest() if old_content else ""
        new_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
        if old_hash == new_hash:
            print("El CLI ya está actualizado (sin cambios remotos).")
            return 0
        real_target.write_text(content, encoding="utf-8")
        print("CLI actualizado correctamente. Recargando…")
        sys.stdout.flush()  # os.execv descarta lo que quede en el buffer
        os.execv(sys.executable, [sys.executable, str(real_target), *sys.argv[1:]])
    except Exception as exc:
        print(f"No se pudo actualizar el CLI: {exc}")
        return 1
    return 0


# ── comandos interactivos ───────────────────────────────────────────────────

def cmd_chat(args: argparse.Namespace) -> int:
    if not ensure_deps():
        return 1
    from lixbon_cli.app import ChatApp

    app = ChatApp(
        model_override=getattr(args, "model", "") or "",
        client_id=getattr(args, "client_id", "") or "",
        title=getattr(args, "title", "") or "",
    )
    try:
        return app.run(once=getattr(args, "once", "") or "")
    except (KeyboardInterrupt, EOFError):
        print("")
        return 0


def cmd_setup(args: argparse.Namespace) -> int:
    """Rehace el login (alias del onboarding interactivo)."""
    if not ensure_deps():
        return 1
    from lixbon_cli.app import ChatApp
    from lixbon_cli.theme import make_console
    from lixbon_cli.ui import render_header

    app = ChatApp()
    render_header(make_console(), CLI_VERSION)
    ok = app.onboarding_flow()
    if ok and not app.model:
        app.pick_model()
    return 0 if ok else 1


def cmd_ui_demo(args: argparse.Namespace) -> int:
    if not ensure_deps():
        return 1
    from lixbon_cli.term import setup_terminal
    from lixbon_cli.ui import ui_demo

    setup_terminal()
    return ui_demo()


# ── parser ──────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lixbon",
        description="Lixbon CLI — asistente de código en tu terminal",
    )
    sub = parser.add_subparsers(dest="command")

    p_init = sub.add_parser("init", help="Guardar base_url, api_key y modelo")
    p_init.add_argument("--base-url")
    p_init.add_argument("--api-key")
    p_init.add_argument("--model")
    p_init.add_argument("--max-context-messages", type=int)
    p_init.add_argument("--context-window", type=int)
    p_init.add_argument("--mode", choices=["ask", "agent", "delegate"])
    p_init.add_argument("--workspace")
    p_init.set_defaults(func=cmd_init)

    sub.add_parser("setup", help="Iniciar sesión (interactivo)").set_defaults(func=cmd_setup)
    sub.add_parser("status", help="Ver configuración local").set_defaults(func=cmd_status)
    sub.add_parser("models", help="Listar modelos disponibles").set_defaults(func=cmd_models)
    sub.add_parser("usage", help="Ver uso global").set_defaults(func=cmd_usage)
    sub.add_parser("update", help="Actualizar CLI desde el servidor").set_defaults(func=cmd_update)
    sub.add_parser("ui-demo", help=argparse.SUPPRESS).set_defaults(func=cmd_ui_demo)

    for name in ("chat", "run", "start"):
        p = sub.add_parser(name, help="Abrir el chat interactivo" if name == "chat" else argparse.SUPPRESS)
        p.add_argument("--model", help="Sobrescribe el modelo por defecto")
        p.add_argument("--client-id", default=os.getenv("HOSTNAME", "cli-client"))
        p.add_argument("--title", default="Sesión CLI")
        p.add_argument("--once", default="", help="Enviar un único mensaje y salir (modo no interactivo)")
        p.set_defaults(func=cmd_chat)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if not args.command:
        args = parser.parse_args(["chat"])
    return int(args.func(args) or 0)
