"""Corpus dorado de sesiones persistentes y de contexto de workspace.

Oráculo: lixbon_cli.sessions y lixbon_cli.commands / app._load_project_context.
Las sesiones se guardan con el SessionStore de Python (reloj simulado) y el
corpus recoge los archivos tal cual quedan en disco, para que otra
implementación demuestre que sabe leerlos y listarlos igual.

    python apps/cli/validation/gen_state_corpus.py          # reescribe
    python apps/cli/validation/gen_state_corpus.py --check  # falla si cambió
"""
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from lixbon_cli import commands, sessions  # noqa: E402

CORPUS = HERE / "fixtures" / "state_corpus.json"


def u(content, **extra): return {"role": "user", "content": content, **extra}
def a(content, calls=None):
    msg = {"role": "assistant", "content": content}
    if calls is not None:
        msg["tool_calls"] = calls
    return msg
def t(content, name="write_file"): return {"role": "tool", "content": content, "name": name}


SESSIONS: list[tuple[str, list[dict], dict]] = [
    ("s-agente", [u("crea una API REST"),
                  a("", [{"id": "c1", "function": {"name": "write_file", "arguments": "{}"}}]),
                  t("Archivo creado: api.py"), a("Listo: creé api.py.")],
     {"model": "qwen", "mode": "agent", "workspace": "/proj", "tokens": 1234}),
    ("s-largo", [u("lee el archivo " + "x" * 120), a("y" * 30000)], {"model": "llama"}),
    ("s-imagen", [u("mira esto", images=["AAAA" * 100])], {}),
    ("s-titulo-fijo", [u("hola"), a("qué tal")], {"title": "Mi título", "model": "m", "mode": "ask"}),
    ("s-unicode", [u("canción 🎵   con   espacios\ny salto"), a("ok")], {"workspace": "C:\\proj\\ñandú"}),
    ("s-titulo-largo", [u("p" * 100)], {}),
    ("s-sin-conversacion", [u("   "), u("TOOL_RESULT read_file: x"), a("")], {}),
    ("s-solo-tool-result-primero", [u("TOOL_RESULT x: y"), u("pregunta real")], {}),
]


def clock():
    state = {"now": 1_700_000_000.0}

    def tick() -> float:
        state["now"] += 10.0
        return state["now"]
    return state, tick


def session_cases() -> dict:
    state, tick = clock()
    original = sessions._now
    sessions._now = tick
    try:
        with tempfile.TemporaryDirectory(prefix="lxs") as tmp:
            base = Path(tmp)
            store = sessions.SessionStore(base)
            for sid, messages, kwargs in SESSIONS:
                store.save(sid, messages, **kwargs)
            # Guardar de nuevo conserva created_at y avanza updated_at.
            store.save("s-agente", SESSIONS[0][1] + [u("gracias"), a("de nada")], tokens=2000)
            files = {p.name: p.read_text(encoding="utf-8") for p in sorted(store.dir.glob("*"))}
            listed = store.list_sessions()
            loaded = {sid: store.load(sid) for sid, _m, _k in SESSIONS}
            rebuilt = []
            store.index_file.unlink()
            rebuilt = store.list_sessions()
            store.index_file.write_text("{no es json", encoding="utf-8")
            corrupt = store.list_sessions()
            deleted = store.delete("s-largo")
            after_delete = [s["id"] for s in store.list_sessions()]
    finally:
        sessions._now = original
    return {"files": files, "listed": listed, "loaded": loaded, "rebuilt_ids": [s["id"] for s in rebuilt],
            "corrupt_index_ids": [s["id"] for s in corrupt], "deleted": deleted, "after_delete": after_delete,
            "max_sessions": sessions.MAX_SESSIONS, "max_stored_chars": sessions.MAX_STORED_CHARS}


def relative_cases() -> list:
    out = []
    state = {"now": 1_800_000_000.0}
    original = sessions._now
    sessions._now = lambda: state["now"]
    try:
        for delta in (0, 5, 59, 60, 61, 119, 120, 3599, 3600, 3601, 7199, 7200, 86399, 86400, 172800,
                      86400 * 29, 86400 * 30, 86400 * 59, 86400 * 60, 86400 * 364, 86400 * 365, 86400 * 800):
            out.append({"delta": delta, "output": sessions.relative_time(state["now"] - delta)})
        out.append({"delta": -50, "output": sessions.relative_time(state["now"] + 50)})
        out.append({"delta": None, "output": sessions.relative_time(0)})
    finally:
        sessions._now = original
    return out


def title_cases() -> list:
    inputs = [
        ("first_user", [u("hola mundo")]),
        ("collapses_whitespace", [u("  a \n b\t\tc  ")]),
        ("skips_tool_result", [u("TOOL_RESULT x: y"), u("el bueno")]),
        ("assistant_first", [a("x"), u("pregunta")]),
        ("long", [u("z" * 61)]),
        ("exactly_60", [u("z" * 60)]),
        ("empty", []),
        ("only_blank", [u("   ")]),
        ("unicode_long", [u("ñ" * 70)]),
    ]
    return [{"name": n, "messages": m, "output": sessions.derive_title(m)} for n, m in inputs]


# ── contexto de workspace ────────────────────────────────────────────────────

CUSTOM_FILES = {
    "home/commands/review.md": "# Revisar cambios\nRevisa el diff y señala bugs.\n",
    "home/commands/fix.md": "Arregla: $ARGUMENTS",
    "home/commands/solo-titulo.md": "# Solo título",
    "home/commands/Ñandú Raro!.md": "# Nombre raro\ncuerpo",
    "home/commands/help.md": "no debe cargarse (pisaría un comando del CLI)",
    "home/commands/vacio.md": "",
    "home/commands/notas.txt": "no es .md",
    "ws/.lixbon/commands/fix.md": "# Fix del proyecto\nArregla el proyecto: $ARGUMENTS",
    "ws/.lixbon/commands/deploy.md": "###   Desplegar   \n\n  Pasos de despliegue  \n\n",
    "ws/.lixbon/commands/largo.md": "# " + "t" * 120 + "\ncuerpo",
}
EXPAND = [
    ("Arregla: $ARGUMENTS", "login"), ("Arregla: $ARGUMENTS y $ARGUMENTS", "  dos "), ("Revisa el diff.", ""),
    ("Revisa el diff.", "solo src"), ("Revisa el diff.", "   "), ("", "x"), ("$ARGUMENTS", ""),
]
PROJECT_FILES = [
    ("lixbon_md", {"LIXBON.md": "# Proyecto\n\nReglas.\n"}),
    ("lowercase", {"lixbon.md": "minúsculas"}),
    ("none", {}),
    ("blank_file", {"LIXBON.md": "  \n  "}),
    ("long_is_cut", {"LIXBON.md": "x" * 13000}),
    ("unicode_cut", {"LIXBON.md": "ñ" * 13000}),
    ("invalid_utf8", {"LIXBON.md": b"ok \xff fin"}),
]


def project_cases() -> list:
    out = []
    for name, files in PROJECT_FILES:
        with tempfile.TemporaryDirectory(prefix="lxp") as tmp:
            root = Path(tmp)
            for rel, data in files.items():
                (root / rel).write_bytes(data if isinstance(data, bytes) else data.encode("utf-8"))
            context = _load_project_context(root)
        out.append({"name": name,
                    "files": {k: (v.decode("latin-1") if isinstance(v, bytes) else v) for k, v in files.items()},
                    "raw_bytes": {k: list(v) for k, v in files.items() if isinstance(v, bytes)},
                    "output": context})
    return out


def _load_project_context(workspace: Path) -> str:
    """Copia literal de ChatApp._load_project_context (que no se puede importar sin consola)."""
    for name in ("LIXBON.md", "lixbon.md"):
        candidate = workspace / name
        try:
            if candidate.is_file():
                text = candidate.read_text(encoding="utf-8", errors="replace").strip()
                if text:
                    return text[:12000]
                return ""
        except OSError:
            return ""
    return ""


def command_cases() -> dict:
    with tempfile.TemporaryDirectory(prefix="lxc") as tmp:
        root = Path(tmp)
        for rel, data in CUSTOM_FILES.items():
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(data, encoding="utf-8")
        found = commands.load_custom_commands(root / "ws", root / "home")
    return {
        "files": CUSTOM_FILES,
        "reserved": [spec[0] for spec in commands.COMMAND_SPECS],
        "found": {name: {"desc": c["desc"], "body": c["body"], "file": Path(c["path"]).name}
                  for name, c in sorted(found.items())},
        "expand": [{"body": b, "arguments": args, "output": commands.expand_custom_command(b, args)}
                   for b, args in EXPAND],
    }


def build() -> dict:
    return {
        "version": 1,
        "oracle": "apps/cli/lixbon_cli/sessions.py y commands.py",
        "sessions": session_cases(),
        "relative_time": relative_cases(),
        "titles": title_cases(),
        "project": project_cases(),
        "commands": command_cases(),
    }


def render() -> str:
    return json.dumps(build(), ensure_ascii=False, indent=1) + "\n"


def main() -> int:
    text = render()
    if "--check" in sys.argv:
        current = CORPUS.read_text(encoding="utf-8") if CORPUS.exists() else ""
        if current != text:
            print("state_corpus.json desactualizado: ejecuta gen_state_corpus.py", file=sys.stderr)
            return 1
        return 0
    CORPUS.write_text(text, encoding="utf-8", newline="\n")
    print(f"escrito {CORPUS} ({len(text) // 1024} kB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
