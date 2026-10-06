"""Corpus dorado de la lógica pura del agente: ventana de contexto, política de
comandos, prompts y árbol del workspace.

Oráculo: lixbon_cli.context y lixbon_cli.agent. Las implementaciones portadas
(Go) cargan fixtures/agent_corpus.json y comparan.

    python apps/cli/validation/gen_agent_corpus.py          # reescribe
    python apps/cli/validation/gen_agent_corpus.py --check  # falla si cambió
"""
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from lixbon_cli import agent, context, diffs  # noqa: E402

CORPUS = HERE / "fixtures" / "agent_corpus.json"


def u(content): return {"role": "user", "content": content}
def a(content, calls=None):
    msg = {"role": "assistant", "content": content}
    if calls is not None:
        msg["tool_calls"] = calls
    return msg
def t(content, ident="c1", name="read_file"):
    return {"role": "tool", "content": content, "tool_call_id": ident, "name": name}
def tr(content): return u("TOOL_RESULT read_file: " + content)


def call(ident="c1", name="read_file", **args):
    return {"id": ident, "function": {"name": name, "arguments": args}}


def txt(n, seed="palabra "):
    return (seed * (n // len(seed) + 1))[:n]


def with_calibration(value, fn):
    old = context._calibrated
    context._calibrated = value
    try:
        return fn()
    finally:
        context._calibrated = old


# ── context.py ───────────────────────────────────────────────────────────────

TOOLS_SAMPLE = agent.TOOL_SCHEMAS[:3]

HISTORY_MESSAGES = {
    "empty": [],
    "short_chat": [u("hola"), a("¿en qué te ayudo?")],
    "with_images": [u("mira"), {"role": "user", "content": "otra", "images": ["aGk=", "aGk="]}],
    "content_none": [{"role": "assistant", "content": None}, u("x")],
    "with_tool_calls": [u("lee a.py"), a("", [call(path="a.py"), call("c2", "mkdir", path="d")]),
                        t("contenido", "c1")],
    "tool_calls_quotes": [a("", [call(content="él dijo \"hola\" y 'adiós'"),
                                 call("c2", content='solo "dobles"'),
                                 call("c3", content="solo 'simples'"),
                                 call("c4", content="línea\ncon\ttab\\ y é ñ  ")])],
    "tool_calls_scalars": [a("", [{"id": "c", "function": {"name": "x", "arguments": {
        "n": 30, "neg": -4, "f": 1.5, "big": 100000.0, "tiny": 0.00001, "edge_lo": 0.0001,
        "edge_hi_in": 1e15, "edge_hi_out": 1e16, "sci": 1.5e-7, "neg_f": -2.25, "whole": 3.0,
        "yes": True, "no": False,
        "nothing": None, "list": [1, "a", None, [True]], "empty_dict": {}, "empty_list": []}}}])],
}

BIG_AGENT_TURN = [
    u("arregla el login en auth.py"),
    a("", [call("c1", path="auth.py")]),
    t(txt(900, "def login(): pass\n"), "c1"),
    a("", [call("c2", "edit_file", path="auth.py", old_text="pass", new_text="return 1")]),
    t("Archivo editado: auth.py (1 reemplazo en la línea 1)", "c2", "edit_file"),
    a("", [call("c3", "run_command", command="pytest")]),
    t("[EXIT 1] " + txt(700, "fallo "), "c3", "run_command"),
    a("", [call("c4", path="auth.py")]),
    t(txt(1200, "linea larga de codigo\n"), "c4"),
    a("Listo, corregido."),
]

TEXT_PROTOCOL_TURN = [
    u("crea a.py"),
    a('{"tool":"write_file","args":{"path":"a.py","content":"x"}}'),
    tr(txt(1500, "resultado ")),
    a('{"tool":"read_file","args":{"path":"a.py"}}'),
    tr(txt(1500, "otro ")),
    a("fin"),
    u("y ahora b.py"),
    a('{"tool":"write_file","args":{"path":"b.py","content":"y"}}'),
    tr("Archivo creado: b.py (1 chars)"),
    a("hecho"),
]

ORPHAN_AFTER_CUT = [u("petición original")] + [
    m for i in range(6) for m in (a("", [call(f"c{i}", path=f"f{i}.py")]), t(txt(500, f"f{i} "), f"c{i}"))
]


def history_cases() -> dict:
    cases: dict = {}

    cases["clip"] = []
    for name, text, limit in [
        ("empty", "", None), ("short", "corto", None), ("at_limit", "x" * 6000, None),
        ("one_over", "x" * 6001, None), ("long_default", txt(20000), None),
        ("custom_limit", txt(5000), 1200), ("tiny_limit", txt(100), 10),
        ("multibyte", "ñé日本🎵" * 400, 500),
    ]:
        kwargs = {} if limit is None else {"limit": limit}
        cases["clip"].append({"name": name, "text": text, "limit": limit,
                              "output": context.clip_tool_output(text, **kwargs)})

    cases["shrink"] = []
    for name, msgs, keep, limit in [
        ("short_list_untouched", BIG_AGENT_TURN[:4], 6, None),
        ("native_turn", BIG_AGENT_TURN, 6, None),
        ("native_turn_tight_limit", BIG_AGENT_TURN, 3, 100),
        ("text_protocol", TEXT_PROTOCOL_TURN, 4, None),
        ("keep_zero", BIG_AGENT_TURN, 0, 200),
        ("not_a_result_is_never_clipped", [u(txt(5000)), a(txt(5000)), u("fin")], 1, 100),
    ]:
        kwargs = {"keep_recent": keep}
        if limit is not None:
            kwargs["limit"] = limit
        cases["shrink"].append({"name": name, "messages": msgs, "keep_recent": keep, "limit": limit,
                                "output": context.shrink_old_results(msgs, **kwargs)})

    cases["estimate"] = []
    for name, msgs in HISTORY_MESSAGES.items():
        for calibrated in (None, 4.0):
            cases["estimate"].append({
                "name": f"{name}/{calibrated}", "messages": msgs, "calibrated": calibrated,
                "payload_chars": context.payload_chars(msgs),
                "tokens": with_calibration(calibrated, lambda: context.estimate_tokens(msgs)),
                "images": context.image_count(msgs)})

    cases["payload_with_tools"] = [
        {"name": "sample_tools", "messages": HISTORY_MESSAGES["short_chat"], "tools": "sample",
         "chars": context.payload_chars(HISTORY_MESSAGES["short_chat"], TOOLS_SAMPLE)},
        {"name": "all_tools", "messages": [], "tools": "all",
         "chars": context.payload_chars([], agent.TOOL_SCHEMAS)},
    ]

    refs = {"all": agent.TOOL_SCHEMAS, "sample": TOOLS_SAMPLE, None: None}
    cases["budget"] = []
    for window, ref, system in [(8192, None, 0), (16384, "all", 900), (4096, "all", 900),
                                (1024, "all", 2000), (0, None, 0), (32768, "sample", 100)]:
        tools = refs[ref]
        for calibrated in (None, 2.0):
            cases["budget"].append({
                "window": window, "tools": ref, "system_tokens": system, "calibrated": calibrated,
                "tools_tokens": with_calibration(calibrated, lambda: context.tools_tokens(tools)),
                "budget": with_calibration(calibrated, lambda: context.prompt_budget(window, tools, system))})

    cases["compaction_needed"] = []
    for name, msgs in (("short", HISTORY_MESSAGES["short_chat"]), ("native_turn", BIG_AGENT_TURN)):
        for window in (512, 1000, 2000, 100000):
            cases["compaction_needed"].append({
                "name": name, "messages": msgs, "window": window,
                "output": context.needs_compaction(msgs, window)})

    cases["fit"] = []
    fit_inputs = [
        ("fits_untouched", BIG_AGENT_TURN, 100000, 6),
        ("fits_after_shrinking_only", BIG_AGENT_TURN, 1100, 6),
        ("needs_head_and_tail", BIG_AGENT_TURN, 400, 6),
        ("tight_keeps_request_and_note", BIG_AGENT_TURN, 250, 6),
        ("last_resort_tail", BIG_AGENT_TURN, 120, 4),
        ("impossible_budget", BIG_AGENT_TURN, 5, 4),
        ("text_protocol", TEXT_PROTOCOL_TURN, 450, 4),
        ("orphan_results_skipped", ORPHAN_AFTER_CUT, 350, 4),
        ("assistant_first", [a("hola")] + BIG_AGENT_TURN[1:], 300, 4),
        ("large_first_message_tight", [u(txt(1500))] + BIG_AGENT_TURN[1:], 520, 4),
        ("large_first_message_medium", [u(txt(1500))] + BIG_AGENT_TURN[1:], 700, 4),
        ("large_first_message_loose", [u(txt(1500))] + BIG_AGENT_TURN[1:], 900, 4),
        ("zero_budget_is_noop", BIG_AGENT_TURN, 0, 6),
        ("negative_budget_is_noop", BIG_AGENT_TURN, -10, 6),
        ("empty", [], 100, 6),
        ("single_message", [u(txt(2000))], 100, 6),
    ]
    for name, msgs, budget, keep in fit_inputs:
        fitted, pruned = context.fit_history(msgs, budget, keep)
        cases["fit"].append({"name": name, "messages": msgs, "budget": budget, "keep_recent": keep,
                             "output": fitted, "pruned": pruned})

    cases["compact"] = []
    long_chat = [u("p1"), a("r1"), u("p2"), a("", [call(path="x")]), t("res"), a("r2"), u("p3"), a("r3"),
                 u("p4"), a("r4"), u("p5"), a("r5")]
    for name, msgs, keep, summary in [
        ("summarizes_old_keeps_recent", long_chat, 4, "  resumen de prueba \n"),
        ("keeps_all_when_short", long_chat[:3], 4, "no se usa"),
        ("drops_empty_and_tool_messages", [u("a"), a(""), u(" "), t("x"), a("b"), u("c"), a("d"), u("e")], 2, "S"),
        ("recent_starts_after_tool_result", [u("1"), a("2"), u("TOOL_RESULT x: y"), a("3"), u("4"), a("5")], 2, "S"),
        ("strips_tool_calls_but_keeps_text",
         [u("p0"), a("voy a leer", [call(path="x")]), t("res"), a("ok", [call("c9", path="y")]),
          u("p1"), a("r1"), u("p2"), a("r2")], 2, "S"),
        ("empty_summary_fails", long_chat, 4, "   "),
    ]:
        received = []

        def ask(m, _s=summary, _r=received):
            _r.append(m)
            return _s
        case = {"name": name, "messages": msgs, "keep_recent": keep, "summary": summary}
        try:
            case["output"] = context.compact_messages(msgs, ask, keep)
            case["ask_received"] = received[0] if received else None
        except RuntimeError as exc:
            case["error"] = str(exc)
            case["ask_received"] = received[0] if received else None
        cases["compact"].append(case)

    cases["constants"] = {
        "PROMPT_BUDGET_RATIO": context.PROMPT_BUDGET_RATIO, "CHARS_PER_TOKEN": context.CHARS_PER_TOKEN,
        "TOKENS_PER_IMAGE": context.TOKENS_PER_IMAGE, "MAX_TOOL_OUTPUT_CHARS": context.MAX_TOOL_OUTPUT_CHARS,
        "MAX_OLD_TOOL_OUTPUT_CHARS": context.MAX_OLD_TOOL_OUTPUT_CHARS, "KEEP_RECENT": context.KEEP_RECENT,
        "AUTO_COMPACT_RATIO": context.AUTO_COMPACT_RATIO, "COMPACT_KEEP_RECENT": context.COMPACT_KEEP_RECENT,
        "PRUNE_NOTE": context.PRUNE_NOTE, "COMPACT_PROMPT": context.COMPACT_PROMPT,
        "CLIP_MARK": context.CLIP_MARK,
    }
    return cases


# ── agent.py: política, prompts, árbol ───────────────────────────────────────

COMMANDS = [
    "npm test", "npm", "npm run build", "npm -v", "git status", "git commit -m 'x'", "pytest",
    "python -m pytest", "  ls   -la  ", "", "   ", "cd demo && npm install", "echo a || echo b",
    "a ; b", "cat x | grep y", "ls\tdocs", "./script.sh arg", "make  build", "docker compose up",
    "déploy ñu", "npm_test run", "go test ./...",
]
ALLOWED_SETS = [
    [], ["npm test"], ["npm"], ["npm test", "git status"], ["pytest", "cd demo", "npm install"],
    ["cd", "npm install", "echo", "a", "b"], ["", "ls"], ["git"], ["go test"],
]


def policy_cases() -> dict:
    prefixes = [{"command": c, "prefix": agent.command_prefix(c)} for c in COMMANDS]
    allowed = [{"command": c, "allowed": al, "output": agent.command_allowed(c, al)}
               for c in COMMANDS for al in ALLOWED_SETS]
    return {"prefix": prefixes, "allowed": allowed}


TREE_FILES = {
    "README.md": "x", "src/app.py": "x", "src/util.js": "x", "src/Zeta.txt": "x",
    "src/deep/a/b/c/d/e/f.txt": "x", "docs/guide.md": "x", "node_modules/m/i.js": "x",
    ".git/config": "x", "build/out.js": "x", "ñandú/é.txt": "x", ".env": "x",
}


def tree_cases() -> list:
    cases = []

    def materialize(root: Path, files: dict, empty_dirs=()):
        for rel, data in files.items():
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(data, encoding="utf-8")
        for rel in empty_dirs:
            (root / rel).mkdir(parents=True, exist_ok=True)

    scenarios = [
        ("empty", {}, (), None),
        ("only_ignored_dirs", {"node_modules/x.js": "x", ".git/c": "x"}, (), None),
        ("normal", TREE_FILES, ("vacia",), None),
        ("truncated", TREE_FILES, (), 5),
        ("exactly_at_limit", {"a.txt": "x", "b.txt": "x"}, (), 2),
        ("one_over_limit", {"a.txt": "x", "b.txt": "x", "c.txt": "x"}, (), 2),
    ]
    for name, files, empty_dirs, limit in scenarios:
        with tempfile.TemporaryDirectory(prefix="lxa") as tmp:
            root = Path(tmp).resolve()
            materialize(root, files, empty_dirs)
            kwargs = {} if limit is None else {"max_entries": limit}
            cases.append({"name": name, "files": files, "empty_dirs": list(empty_dirs),
                          "max_entries": limit, "output": agent.workspace_tree(root, **kwargs)})
    return cases


def prompt_cases() -> dict:
    with tempfile.TemporaryDirectory(prefix="lxa") as tmp:
        root = Path(tmp).resolve()
        for rel, data in TREE_FILES.items():
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(data, encoding="utf-8")
        (root / "vacia").mkdir()
        marker = "<WS>"
        native = agent.build_native_system_prompt(root).replace(str(root), marker)
        text = agent.build_agent_system_prompt(root).replace(str(root), marker)
    return {"files": TREE_FILES, "empty_dirs": ["vacia"], "native": native, "text": text}


MCP_SCHEMAS = [
    {"type": "function", "function": {"name": f"mcp__srv__tool{i}", "description": "d" * (50 + i * 20),
                                      "parameters": {"properties": {f"p{j}": {} for j in range(i % 10)}}}}
    for i in range(45)
] + [
    {"type": "function", "function": {"name": "sin_params", "description": ""}},
    {"type": "function", "function": {"name": "orden_servidor", "description": "propiedades fuera de orden alfabético",
                                      "parameters": {"properties": {k: {} for k in
                                                                    ("zeta", "alfa", "medio", "p3", "b", "a", "z9", "m", "extra1", "extra2")}}}},
    {"type": "function", "function": {"name": "descripcion_ñ", "description": "ñ" * 150, "parameters": {"properties": {}}}},
]


MCP_SCHEMAS = MCP_SCHEMAS[-2:] + MCP_SCHEMAS[:-2]  # los especiales dentro del tope de 40


def misc_cases() -> dict:
    sanitize_inputs = {
        "drops_tool_roundtrip": [u("crea a.txt"), a("", [{"id": "c1"}]), t("Archivo creado", "c1", "write_file"),
                                 a("Listo.")],
        "keeps_assistant_text_but_strips_calls": [u("x"), a("pienso", [{"id": "c"}]), a("fin")],
        "whitespace_only_content_dropped": [u("x"), a("  \n", [{"id": "c"}]), a("fin")],
        "plain_untouched": [u("a"), a("b")],
        "empty": [],
    }
    return {
        "constants": {name: getattr(agent, name) for name in (
            "NUDGE_PROMPT", "NATIVE_NUDGE_PROMPT", "NO_OUTPUT_PROMPT", "TRUNCATED_PROMPT", "PLAN_MODE_PROMPT",
            "TODO_PROMPT", "TOOL_IMAGES_PROMPT", "MAX_AGENT_STEPS", "MAX_REPEATED_CALLS")},
        "sanitize": [{"name": n, "messages": m, "output": agent.sanitize_for_plain_chat(m)}
                     for n, m in sanitize_inputs.items()],
        "mcp_text_prompt": {"schemas": MCP_SCHEMAS, "output": agent.mcp_text_prompt(MCP_SCHEMAS)},
    }


# ── diffs.py y resúmenes ─────────────────────────────────────────────────────

def numbered(prefix, n, every=1, changed=()):
    return "\n".join(f"{prefix}{i}{'*' if i in changed else ''}" for i in range(1, n + 1, every))


LONG_A = "\n".join(f"linea {i}" for i in range(1, 61)) + "\n"
LONG_B = LONG_A.replace("linea 5\n", "LINEA 5\n").replace("linea 30\n", "linea 30\nnueva A\nnueva B\n") \
    .replace("linea 58\n", "")

DIFF_CASES: list[tuple[str, str, str]] = [
    ("identical", "a\nb\nc\n", "a\nb\nc\n"),
    ("both_empty", "", ""),
    ("empty_to_text", "", "a\nb\n"),
    ("text_to_empty", "a\nb\n", ""),
    ("insert_in_middle", "a\nb\nc\n", "a\nb\nX\nc\n"),
    ("delete_in_middle", "a\nb\nc\nd\n", "a\nd\n"),
    ("replace_line", "a\nb\nc\n", "a\nB\nc\n"),
    ("replace_block_of_different_size", "a\nb\nc\nd\ne\n", "a\nX\nY\nZ\ne\n"),
    ("long_file_three_hunks", LONG_A, LONG_B),
    ("change_at_start", LONG_A, LONG_A.replace("linea 1\n", "primera\n", 1)),
    ("change_at_end", LONG_A, LONG_A.replace("linea 60\n", "ultima\n")),
    ("one_equal_line_between_hunks", "a\nb\nc\nd\ne\n", "A\nb\nC\nd\nE\n"),
    ("repeated_lines_tie_breaking", "x\nx\nx\ny\nx\nx\n", "x\nx\ny\nx\nx\nx\n"),
    ("many_duplicates", "a\nb\na\nb\na\nb\n", "b\na\nb\na\nb\na\n"),
    ("reordered_blocks", "uno\ndos\ntres\ncuatro\n", "tres\ncuatro\nuno\ndos\n"),
    ("trailing_newline_only", "a\nb", "a\nb\n"),
    ("crlf_text", "a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n"),
    ("unicode_separators", "a b\x0bc\n", "a B\x0bc\n"),
    ("tabs_and_unicode", "\tañadir 🎵\n", "\tañadir 🎶\n"),
    ("swap_adjacent", "1\n2\n3\n4\n5\n6\n7\n8\n", "1\n2\n4\n3\n5\n6\n7\n8\n"),
    ("shifted_block", "p\nq\nr\ns\nt\nu\n", "q\nr\ns\nt\nu\np\n"),
    ("only_blank_lines", "\n\n\n", "\n\n\n\n\n"),
]


def diff_cases() -> list:
    out = []
    for name, old, new in DIFF_CASES:
        change = diffs.FileChange("update", "f.txt", old, new)
        rows = diffs.diff_rows(change)
        adds, dels = diffs.diff_counts(change)
        out.append({"name": name, "old": old, "new": new, "rows": [list(r) for r in rows],
                    "context_rows": [list(r) for r in diffs.diff_rows(change, context=1)],
                    "adds": adds, "dels": dels})
    return out


CHANGE_FILES = {"a.txt": "uno\ndos\ntres\n", "c.py": "def f():\n    return 1\n", "dup.txt": "x\nx\n",
                "crlf.txt": b"uno\r\ndos\r\n", "d/inner.txt": "dentro\n"}
CHANGE_CASES: list[tuple[str, str, dict]] = [
    ("write_new", "write_file", {"path": "nuevo.txt", "content": "hola\n"}),
    ("write_overwrite", "write_file", {"path": "a.txt", "content": "uno\nDOS\ntres\n"}),
    ("write_over_directory", "write_file", {"path": "d", "content": "x"}),
    ("write_outside", "write_file", {"path": "../fuera.txt", "content": "x"}),
    ("append_existing", "append_file", {"path": "a.txt", "content": "cuatro\n"}),
    ("append_new", "append_file", {"path": "n.txt", "content": "x"}),
    ("edit_single", "edit_file", {"path": "a.txt", "old_text": "dos", "new_text": "DOS"}),
    ("edit_all", "edit_file", {"path": "dup.txt", "old_text": "x", "new_text": "y", "all": True}),
    ("edit_not_found_keeps_old", "edit_file", {"path": "a.txt", "old_text": "zzz", "new_text": "y"}),
    ("edit_missing_file", "edit_file", {"path": "nada.txt", "old_text": "a", "new_text": "b"}),
    ("edit_crlf_file_universal_newlines", "edit_file", {"path": "crlf.txt", "old_text": "uno", "new_text": "UNO"}),
    ("multi_edit_two", "multi_edit", {"path": "c.py", "edits": [{"old_text": "def f", "new_text": "def g"},
                                                                {"old_text": "return 1", "new_text": "return 2"}]}),
    ("multi_edit_not_list", "multi_edit", {"path": "a.txt", "edits": "x"}),
    ("insert_middle", "insert_at_line", {"path": "a.txt", "line": 2, "content": "X\n"}),
    ("delete_file", "delete_file", {"path": "a.txt"}),
    ("delete_dir", "delete_file", {"path": "d"}),
    ("delete_missing", "delete_file", {"path": "nada"}),
    ("rename", "rename_file", {"src": "a.txt", "dst": "b.txt"}),
    ("mkdir", "mkdir", {"path": "x/y"}),
    ("command", "run_command", {"command": "npm test"}),
    ("read_only_is_none", "read_file", {"path": "a.txt"}),
    ("search_is_none", "search", {"pattern": "x"}),
]


def change_cases() -> dict:
    cases = []
    with tempfile.TemporaryDirectory(prefix="lxc") as tmp:
        root = Path(tmp).resolve()
        for rel, data in CHANGE_FILES.items():
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data if isinstance(data, bytes) else data.encode("utf-8"))
        for name, tool, args in CHANGE_CASES:
            change = diffs.compute_change(root, tool, args, agent.resolve_safe_path)
            cases.append({"name": name, "tool": tool, "args": args,
                          "change": None if change is None else {
                              "kind": change.kind, "path": change.path, "old_text": change.old_text,
                              "new_text": change.new_text, "detail": change.detail}})
    files = {rel: ({"b64": __import__("base64").b64encode(d).decode()} if isinstance(d, bytes) else {"text": d})
             for rel, d in CHANGE_FILES.items()}
    return {"files": files, "cases": cases}


SUMMARY_ARGS = [
    ("run_command", {"command": "npm test"}), ("run_command", {"command": "x" * 300, "background": True}),
    ("run_command", {}), ("read_output", {"id": "p1"}), ("stop_command", {"id": "p2"}),
    ("ask_user", {"question": "¿a?" * 100}), ("rename_file", {"src": "a", "dst": "b"}), ("rename_file", {}),
    ("search", {"pattern": "foo", "path": "src"}), ("search", {"pattern": "foo"}), ("search", {"pattern": "f", "path": ""}),
    ("web_search", {"query": "go"}), ("fetch_url", {"url": "https://x.test/" + "a" * 300}),
    ("edit_file", {"path": "a.py", "old_text": "abc"}), ("edit_file", {}),
    ("multi_edit", {"path": "a.py", "edits": [1, 2, 3]}), ("multi_edit", {"path": "a.py"}),
    ("insert_at_line", {"path": "a.py", "line": 7}), ("insert_at_line", {}),
    ("write_file", {"path": "a.py", "content": "ñandú"}), ("append_file", {"path": "a.py"}),
    ("mkdir", {"path": "d/e"}), ("delete_file", {"path": "x"}), ("read_file", {"path": "a.txt"}),
    ("list_files", {}), ("find_files", {"pattern": "*.py"}),
]
RESULTS = [
    "Archivo editado: a.py (1 reemplazo en la línea 3)", "Archivo creado: x.txt (14 chars)",
    "Archivo sobrescrito: x (2 chars)", "Archivo actualizado: ñ.txt (+4 chars)", "[EXIT 0] ok\nmás",
    "  [ERROR] algo  \nsegunda", "Archivo editado: a (2 ediciones: 1 reemplazo; 1 reemplazo)", "",
    "x" * 300, "Archivo editado: a b.py (1 reemplazo)",
]


def summary_cases() -> dict:
    from lixbon_cli.remote import _args_summary
    return {
        "args": [{"tool": t, "args": a, "output": _args_summary(t, a)} for t, a in SUMMARY_ARGS],
        "result": [{"result": r, "output": agent._result_summary(r)} for r in RESULTS],
    }


def build() -> dict:
    return {
        "version": 1,
        "oracle": "apps/cli/lixbon_cli/context.py y agent.py",
        "history": history_cases(),
        "policy": policy_cases(),
        "tree": tree_cases(),
        "prompts": prompt_cases(),
        "misc": misc_cases(),
        "diff": diff_cases(),
        "change": change_cases(),
        "summary": summary_cases(),
    }


def render() -> str:
    return json.dumps(build(), ensure_ascii=False, indent=1) + "\n"


def main() -> int:
    text = render()
    if "--check" in sys.argv:
        current = CORPUS.read_text(encoding="utf-8") if CORPUS.exists() else ""
        if current != text:
            print("agent_corpus.json desactualizado: ejecuta gen_agent_corpus.py", file=sys.stderr)
            return 1
        return 0
    CORPUS.write_text(text, encoding="utf-8", newline="\n")
    print(f"escrito {CORPUS} ({len(text) // 1024} kB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
