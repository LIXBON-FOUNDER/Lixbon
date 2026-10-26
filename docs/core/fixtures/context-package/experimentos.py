"""Experimentos A–D de ContextPackage (LXO-132). Reproducible: `python -I -X utf8 experimentos.py <fase> [salida.json]`.

Fases:
  medir      sin modelo: tamaños por componente, secretos que detecta la red de seguridad actual y su efecto en el diff.
  git        sin modelo: escenario C (otro host) y D (traspaso con el worktree sucio), verificados con git.
  modelos    con modelos baratos: escenarios A (misma CLI, sesión nueva) y B (otro proveedor) con una rúbrica automática.
  todo       las tres, en ese orden.

La tarea real es la propia LXO-205 (commit BASE → HEAD de este repositorio). Nada de lo que escribe va a la salida con un
secreto: el centinela de la prueba de redacción es una cadena falsa y el paquete que se entrega siempre sale redactado.
"""
import hashlib, json, os, re, shutil, subprocess, sys, tempfile, time

REPO = os.environ.get("LXO_REPO") or subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, encoding="utf-8").stdout.strip()
BASE, HEAD = "e73a74da", "b1cc12e3"
SENTINEL = "sk-ant-api03-SENTINELA-FALSA-0123456789abcdef"
HAIKU, LUNA = "haiku", "gpt-5.6-luna"
MAX_BUDGET_USD = "0.30"


def sh(*args, cwd=None, inp=None, check=True):
    p = subprocess.run(["git", *args] if args and args[0] != "RAW" else list(args[1:]), cwd=cwd or REPO, input=inp, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if check and p.returncode != 0:
        raise RuntimeError(f"{' '.join(args)}: {p.stderr[:300]}")
    return p.stdout


def sha256(b):
    return hashlib.sha256(b if isinstance(b, bytes) else b.encode("utf-8")).hexdigest()


def tokens(text):
    """Aproximación gruesa (1 token ≈ 4 caracteres); los números reales salen de las llamadas a los modelos."""
    return (len(text) + 3) // 4


# ── Red de seguridad actual (port de `store::looks_secret` y `adapter::redact`) ─────────────────────────────────────────

PREFIXES = ["sk-", "ghp_", "gho_", "ghs_", "ghu_", "github_pat_", "xoxb-", "xoxp-", "glpat-", "akia", "aiza", "lxb_"]
MARKERS = ["-----begin", "bearer ", "authorization:", "api_key", "apikey", "password=", "token=", "secret="]
SEPS = re.compile("[\\s\"'`,;()\\[\\]{}<>/\\\\?&=:@]")


def looks_secret(s):
    lower = s.lower()
    if any(m in lower for m in MARKERS):
        return True
    return any(any(w.startswith(p) and len(w) >= len(p) + 8 for p in PREFIXES) for w in SEPS.split(lower))


def redact(text):
    out, announced, last = [], False, 0
    for m in re.finditer(r"\S+", text):
        out.append(text[last:m.start()])
        w = m.group(0)
        ann = w.rstrip(":").lower() in ("bearer", "basic", "authorization")
        out.append("[redactado]" if (announced or ann or looks_secret(w)) else w)
        announced, last = ann, m.end()
    out.append(text[last:])
    return "".join(out)


# ── El paquete candidato (v0 de investigación; el schema v1 sale del ADR) ───────────────────────────────────────────────

OBJECTIVE = "Normalizar el uso (cuota y ventanas de rate limit) de cada proveedor sin fingir métricas que no expone (LXO-205)."
DECISIONS = [
    "Claude se consulta con el comando local `claude -p /usage` (sin modelo) solo en versiones verificadas (2.1.296); en otra versión se usa el último rate_limit_event de una ejecución.",
    "Si /usage llega al modelo (mensaje con un modelo distinto de <synthetic>) se mata el proceso al instante y no se usa el texto.",
    "resets_at de Claude queda desconocido: /usage da la hora como texto con zona IANA (America/Bogota) y no hay base de zonas horarias.",
    "La cuenta sale en el informe como huella de 8 hex de un SHA-256, nunca como identificador.",
    "La caché de uso tiene un TTL de 5 minutos y, tras un fallo, no se reintenta en 30 s salvo refresco manual.",
    "El informe es una lista por proveedor sin totales: no se suman magnitudes incompatibles.",
    "Codex se consulta con account/rateLimits/read de codex app-server.",
]
CONSTRAINTS = [
    "Todo el trabajo del Core F4 queda en ramas locales apiladas: sin push ni PR hasta un único PR final.",
    "Ramas tipo/lxo-N-resumen y commits tipo(ámbito): resumen.",
    "No se guardan secretos ni identificadores de cuenta en Events ni en el informe.",
]
THREAD_SUMMARY = (
    "La persona pidió leer la cuota exacta de cada proveedor y no solo la observada. Se descubrió que `claude -p /usage` es un comando "
    f"local. Una prueba de redacción usó la clave falsa {SENTINEL} como dato de ejemplo. Quedó pendiente la hora de reinicio de Claude."
)
TESTS = {"command": "cargo test --lib", "passed": 1441, "failed": 0, "ignored": 19, "manual": ["claude /usage real: ok", "codex account/rateLimits/read real: ok"]}

QUESTIONS = [
    ("q1", "¿Qué comando exacto usa el adapter para consultar el uso de Claude?", lambda a: bool(re.search(r"-p\s+[\"'`]?/usage", a))),
    ("q2", "¿Por qué resets_at de Claude queda desconocido?", lambda a: bool(re.search(r"zona|timezone|tz\b|iana|bogot", a))),
    ("q3", "¿Qué hace el adapter si /usage llega al modelo?", lambda a: bool(re.search(r"mata|corta|kill|aborta|termina|cancela", a))),
    ("q4", "¿Cuántas pruebas pasaron en la suite completa (cargo test --lib)?", lambda a: "1441" in a.replace(".", "").replace(",", "")),
    ("q5", "¿Se puede hacer push o abrir un PR de este trabajo ahora? ¿Por qué?", lambda a: bool(re.search(r"único pr|un solo pr|single pr|al final|local", a))),
    ("q6", "¿Cómo se identifica la cuenta en el informe de uso?", lambda a: bool(re.search(r"huella|fingerprint|sha-?256|hash", a))),
    ("q7", "¿Cuál es el TTL de la caché de uso y cuánto es el backoff tras un fallo?", lambda a: "5" in a and "30" in a),
    ("q8", "¿Cómo trata el informe los totales entre proveedores?", lambda a: bool(re.search(r"sin totales|no (se )?(suma|hay total|agrega)|lista|no total", a))),
    ("q9", "¿Cuál es el commit final (head) del trabajo?", lambda a: HEAD in a),
    ("q10", "¿Qué dos archivos nuevos de pruebas/módulo de uso se añadieron en orch/adapter/ (nombres)?", lambda a: "usage.rs" in a and "usage_tests.rs" in a),
]
UNKNOWN = re.compile(r"desconocid|unknown|no (lo )?s[ée]\b|no (se )?(dispone|indica|menciona|puedo)|no (hay|tengo) (informaci|contexto|datos)|sin informaci")


def diff_bytes():
    return subprocess.run(["git", "diff", BASE, HEAD, "--binary"], cwd=REPO, capture_output=True).stdout


def revision():
    files = []
    for line in sh("diff", "--numstat", BASE, HEAD).splitlines():
        a, d, path = line.split("\t", 2)
        files.append({"path": path, "added": int(a) if a.isdigit() else None, "deleted": int(d) if d.isdigit() else None})
    d = diff_bytes()
    return {"base": BASE, "head": HEAD, "branch": sh("branch", "--show-current", cwd=REPO).strip() or "(desacoplada)", "files": files, "diff_sha256": sha256(d), "diff_bytes": len(d)}


def artifacts():
    out = [{"kind": "commit", "uri": HEAD}]
    for rel in ("docs/core/ADAPTERS.md", "docs/core/fixtures/api/usage_report.v1.json"):
        b = subprocess.run(["git", "show", f"{HEAD}:{rel}"], cwd=REPO, capture_output=True).stdout
        out.append({"kind": "file", "uri": rel, "sha256": sha256(b), "bytes": len(b)})
    return out


def package(variant):
    """Variantes del experimento. `completo` es lo que propone el ADR; las demás aíslan qué aporta cada pieza."""
    rev, art = revision(), artifacts()
    raw = {
        "source": {"task": "LXO-205", "attempt": "a-demo-1", "provider": "claude"},
        "objective": OBJECTIVE, "decisions": DECISIONS, "constraints": CONSTRAINTS, "thread_summary": THREAD_SUMMARY,
        "revision": rev, "test_results": TESTS, "artifacts": art,
    }
    keep = {
        "completo": raw.keys(),
        "solo_resumen": ["source", "objective", "decisions", "constraints", "thread_summary"],
        "solo_refs": ["source", "objective", "revision", "artifacts"],
    }.get(variant)
    if variant == "nada":
        raw = {"source": {"task": "LXO-205"}, "objective": "Continuar el trabajo de la tarea LXO-205."}
    elif variant == "diff_inline":
        raw = {"source": raw["source"], "objective": OBJECTIVE, "diff": diff_bytes().decode("utf-8", "replace")}
    else:
        raw = {k: raw[k] for k in keep}
    return json.loads(redact_json(raw))


def redact_json(obj):
    """Redacta cada texto del paquete ANTES de serializarlo (la tubería real redactaría antes de persistir/exportar)."""
    def walk(x):
        if isinstance(x, str):
            return redact(x)
        if isinstance(x, list):
            return [walk(i) for i in x]
        if isinstance(x, dict):
            return {k: walk(v) for k, v in x.items()}
        return x
    return json.dumps(walk(obj), ensure_ascii=False)


# Secretos FALSOS con formas reales, y textos que NO son secretos: mide qué cubre la red de seguridad actual.
MUESTRAS_SECRETAS = [
    ("clave Anthropic", "sk-ant-api03-xxxxxxxxxxxxxxxxxxxx"), ("token GitHub", "ghp_abcdefghijklmnopqrstuvwx"), ("AWS access key", "AKIAABCDEFGHIJKLMNOP"),
    ("password=", "password=hunter2"), ("Bearer", "Authorization: Bearer abc.def.ghi"), ("clave privada", "-----BEGIN PRIVATE KEY-----"),
    ("JWT", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789"),
    ("URL con credenciales", "postgres://admin:S3cr3tPass@db.internal:5432/app"), ("token npm", "npm_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"),
    ("token Google OAuth", "ya29.a0AfH6SMBx1234567890abcdefghij"), ("AWS secret key", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
    ("Stripe", "sk_live_abcdefghijklmnop"), ("variable .env", "STRIPE_SECRET_VALUE=rk_live_51abcdefghijklmno"),
]
MUESTRAS_NO_SECRETAS = [
    ("sha de commit", "0123456789abcdef0123456789abcdef01234567"), ("uuid", "6f1c2a9e-0b7d-4d1e-9a51-3c2f8e7d9b10"),
    ("ruta", "/home/ana/.codex/sessions/rollout-t3.jsonl"), ("hash de integridad", "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
    ("palabra común", "token de acceso (texto)"),
]


def cobertura_redaccion():
    cogidas = [n for n, s in MUESTRAS_SECRETAS if "[redactado]" in redact(s)]
    falsos = [n for n, s in MUESTRAS_NO_SECRETAS if "[redactado]" in redact(s)]
    return {
        "secretos_probados": len(MUESTRAS_SECRETAS), "secretos_detectados": len(cogidas), "detectados": cogidas,
        "no_detectados": [n for n, _ in MUESTRAS_SECRETAS if n not in cogidas],
        "no_secretos_probados": len(MUESTRAS_NO_SECRETAS), "falsos_positivos": falsos,
    }


# ── Fase: medir ─────────────────────────────────────────────────────────────────────────────────────────────────────────

def medir():
    rev = revision()
    comp = {
        "objective": OBJECTIVE, "decisions": json.dumps(DECISIONS, ensure_ascii=False), "constraints": json.dumps(CONSTRAINTS, ensure_ascii=False),
        "thread_summary": THREAD_SUMMARY, "revision_refs": json.dumps(rev, ensure_ascii=False), "test_results": json.dumps(TESTS, ensure_ascii=False),
        "artifacts": json.dumps(artifacts(), ensure_ascii=False), "diff_completo": diff_bytes().decode("utf-8", "replace"),
    }
    tam = {k: {"bytes": len(v.encode("utf-8")), "tokens_aprox": tokens(v)} for k, v in comp.items()}
    variantes = {}
    for v in ("nada", "solo_refs", "solo_resumen", "completo", "diff_inline"):
        s = json.dumps(package(v), ensure_ascii=False)
        variantes[v] = {"bytes": len(s.encode("utf-8")), "tokens_aprox": tokens(s)}

    # Red de seguridad sobre material REAL.
    diff = diff_bytes().decode("utf-8", "replace")
    lineas = diff.splitlines()
    marcadas = [l for l in lineas if looks_secret(l)]
    palabras_red = diff.count("[redactado]"), redact(diff).count("[redactado]")
    redactado = redact(diff)
    red = {
        "lineas_del_diff": len(lineas), "lineas_marcadas": len(marcadas),
        "palabras_redactadas": redact(diff).count("[redactado]"),
        "muestra_marcadas": [m[:110] for m in marcadas[:6]],
        "el_diff_redactado_conserva_el_hash": sha256(redactado) == sha256(diff),
        "centinela_sale_del_paquete": SENTINEL in json.dumps(package("completo"), ensure_ascii=False),
    }
    # ¿El diff redactado sigue aplicándose? (sobre un worktree temporal en BASE)
    tmp = tempfile.mkdtemp(prefix="lxo-cp-")
    try:
        sh("worktree", "add", "-q", "--detach", tmp, BASE)
        orig = os.path.join(tmp, "orig.patch"); red_p = os.path.join(tmp, "red.patch")
        open(orig, "wb").write(diff_bytes()); open(red_p, "w", encoding="utf-8", newline="").write(redactado)
        r1 = subprocess.run(["git", "apply", "--check", "--binary", orig], cwd=tmp, capture_output=True, text=True)
        r2 = subprocess.run(["git", "apply", "--check", "--binary", red_p], cwd=tmp, capture_output=True, text=True)
        red["el_diff_original_se_aplica"] = r1.returncode == 0
        red["el_diff_redactado_se_aplica"] = r2.returncode == 0
        red["error_redactado"] = r2.stderr.strip()[:160]
    finally:
        sh("worktree", "remove", "--force", tmp, check=False)
    red["cobertura_de_la_red_actual"] = cobertura_redaccion()
    return {"tamanos": tam, "variantes": variantes, "redaccion": red}


# ── Fase: git (escenarios C y D) ────────────────────────────────────────────────────────────────────────────────────────

def escenario_c():
    """Otro host: solo tiene lo que hay en el remoto. ¿Resuelven las referencias del paquete?"""
    noalcanzables = int(sh("rev-list", "--count", HEAD, "--not", "--remotes=origin").strip())
    host = tempfile.mkdtemp(prefix="lxo-host-b-")
    res = {"commits_no_publicados": noalcanzables}
    try:
        # Host B: un repositorio sin esos commits (sus objetos llegan solo por transporte explícito).
        sh("init", "-q", host, cwd=REPO)
        res["head_resuelve_en_host_b_sin_transporte"] = subprocess.run(["git", "cat-file", "-e", HEAD], cwd=host, capture_output=True).returncode == 0
        # Transporte 1: bundle de lo que falta; transporte 2: parches; transporte 3: solo el diff.
        bundle = os.path.join(host, "t.bundle")
        sh("update-ref", "refs/lxo-cp/head", HEAD)
        try:
            subprocess.run(["git", "bundle", "create", bundle, f"{BASE}..refs/lxo-cp/head"], cwd=REPO, capture_output=True, text=True)
        finally:
            sh("update-ref", "-d", "refs/lxo-cp/head", check=False)
        res["bundle_bytes"] = os.path.getsize(bundle) if os.path.exists(bundle) else None
        patches = subprocess.run(["git", "format-patch", "--stdout", f"{BASE}..{HEAD}"], cwd=REPO, capture_output=True).stdout
        d = diff_bytes()
        res["transportes_bytes"] = {"diff_binario": len(d), "format_patch": len(patches), "bundle": res["bundle_bytes"]}
        # Verificación en el host B: aplicar el diff sobre BASE debe producir EXACTAMENTE el árbol de HEAD.
        wt = tempfile.mkdtemp(prefix="lxo-host-b-wt-")
        try:
            sh("worktree", "add", "-q", "--detach", wt, BASE)
            p = os.path.join(wt, "..", "t.patch"); open(p, "wb").write(d)
            subprocess.run(["git", "apply", "--index", "--binary", p], cwd=wt, check=True, capture_output=True)
            arbol = subprocess.run(["git", "write-tree"], cwd=wt, capture_output=True, text=True).stdout.strip()
            esperado = sh("rev-parse", f"{HEAD}^{{tree}}").strip()
            res["diff_aplicado_reproduce_el_arbol_de_head"] = arbol == esperado
            res["arbol_head"] = esperado[:12]
        finally:
            sh("worktree", "remove", "--force", wt, check=False)
        # Qué es específico del host y NO debe viajar como identidad.
        res["especifico_del_host"] = ["ruta del worktree", "id de máquina", "rama local no publicada", "ProviderSession (opaca, de ese proveedor y host)"]
    finally:
        shutil.rmtree(host, ignore_errors=True)
    return res


def escenario_d():
    """Traspaso con un worktree sucio (cambios sin commit + archivo sin seguimiento)."""
    a = tempfile.mkdtemp(prefix="lxo-d-a-"); b = tempfile.mkdtemp(prefix="lxo-d-b-")
    res = {}
    try:
        sh("worktree", "add", "-q", "--detach", a, HEAD); sh("worktree", "add", "-q", "--detach", b, HEAD)
        # El agente A deja trabajo a medias: una edición, una preparada y un archivo nuevo.
        with open(os.path.join(a, "docs/core/ADAPTERS.md"), "a", encoding="utf-8", newline="\n") as f:
            f.write("\n<!-- nota del agente A: pendiente documentar resets_at -->\n")
        with open(os.path.join(a, "docs/core/SESIONES_THREADS.md"), "a", encoding="utf-8", newline="\n") as f:
            f.write("\n<!-- edición preparada -->\n")
        sh("add", "docs/core/SESIONES_THREADS.md", cwd=a)
        open(os.path.join(a, "NOTAS_AGENTE_A.md"), "w", encoding="utf-8", newline="\n").write("Siguiente paso: convertir la hora de reinicio.\n")

        def arbol(cwd):
            idx = os.path.join(cwd, ".git_idx_tmp")
            env = {**os.environ, "GIT_INDEX_FILE": idx}
            subprocess.run(["git", "read-tree", "HEAD"], cwd=cwd, env=env, check=True, capture_output=True)
            subprocess.run(["git", "add", "-A", "--", ".", ":(exclude).git_idx_tmp"], cwd=cwd, env=env, check=True, capture_output=True)
            t = subprocess.run(["git", "write-tree"], cwd=cwd, env=env, capture_output=True, text=True).stdout.strip()
            os.remove(idx)
            return t

        ta, tb0 = arbol(a), arbol(b)
        res["solo_con_head_el_host_b_reproduce_el_estado"] = ta == tb0
        # Lo que añade el paquete: parche de lo sin commit (con lo preparado) + archivos sin seguimiento con su hash.
        parche = subprocess.run(["git", "diff", "HEAD", "--binary"], cwd=a, capture_output=True).stdout
        preparado = subprocess.run(["git", "diff", "--cached", "--binary"], cwd=a, capture_output=True).stdout
        no_preparado = subprocess.run(["git", "diff", "--binary"], cwd=a, capture_output=True).stdout
        nuevos = [p for p in subprocess.run(["git", "ls-files", "--others", "--exclude-standard"], cwd=a, capture_output=True, text=True).stdout.split("\n") if p and p != ".git_idx_tmp"]
        res["parche_sin_commit_bytes"] = len(parche)
        res["archivos_sin_seguimiento"] = [{"path": p, "sha256": sha256(open(os.path.join(a, p), "rb").read())[:16]} for p in nuevos]
        p = os.path.join(b, "..", "d.patch"); open(p, "wb").write(parche)
        subprocess.run(["git", "apply", "--binary", p], cwd=b, check=True, capture_output=True)
        for n in nuevos:
            shutil.copy2(os.path.join(a, n), os.path.join(b, n))
        res["con_parche_y_archivos_el_host_b_reproduce_el_estado"] = arbol(b) == ta
        # ¿Distingue el paquete lo preparado de lo no preparado? El parche contra HEAD los une; se pierde la separación.
        # Lo preparado y lo no preparado se transportan por separado y así se reproduce también el índice.
        sep_b = tempfile.mkdtemp(prefix="lxo-d-c-")
        try:
            sh("worktree", "add", "-q", "--detach", sep_b, HEAD)
            pp = os.path.join(sep_b, "..", "d_prep.patch"); pn = os.path.join(sep_b, "..", "d_noprep.patch")
            open(pp, "wb").write(preparado); open(pn, "wb").write(no_preparado)
            subprocess.run(["git", "apply", "--index", "--binary", pp], cwd=sep_b, check=True, capture_output=True)
            subprocess.run(["git", "apply", "--binary", pn], cwd=sep_b, check=True, capture_output=True)
            for n in nuevos:
                shutil.copy2(os.path.join(a, n), os.path.join(sep_b, n))
            estado = lambda cwd: sorted(l for l in subprocess.run(["git", "status", "--porcelain=v1"], cwd=cwd, capture_output=True, text=True).stdout.splitlines() if ".git_idx_tmp" not in l)
            res["preparado_y_no_preparado_por_separado_reproducen_el_indice"] = estado(a) == estado(sep_b)
            res["bytes_preparado_y_no_preparado"] = [len(preparado), len(no_preparado)]
        finally:
            sh("worktree", "remove", "--force", sep_b, check=False)
        res["bytes_sin_commit_frente_al_diff_completo"] = [len(parche), len(diff_bytes())]
    finally:
        for w in (a, b):
            sh("worktree", "remove", "--force", w, check=False)
    return res


# ── Fase: modelos (escenarios A y B) ────────────────────────────────────────────────────────────────────────────────────

PROMPT_HEAD = (
    "Continúas una tarea de ingeniería que empezó otro agente. Solo tienes el contexto que sigue (puede estar incompleto). "
    "Responde las preguntas SOLO con un objeto JSON {\"q1\": \"...\", ...}; cada respuesta, máximo 25 palabras. "
    "Si el contexto no te lo permite saber, responde exactamente \"desconocido\": no adivines.\n\n"
)


def prompt_for(variant, tools):
    ctx = json.dumps(package(variant), ensure_ascii=False, indent=None)
    extra = ""
    if not tools:
        extra = "\n\nNo uses herramientas ni leas archivos: responde solo con lo que aparece en este contexto."
    if tools:
        extra = (f"\n\nPuedes leer el repositorio del directorio actual (es el checkout del trabajo; el commit final es {HEAD}) con Read, Grep, Glob y `git`. "
                 "Usa lo mínimo necesario.")
    qs = "\n".join(f"{q}: {t}" for q, t, _ in QUESTIONS)
    return f"{PROMPT_HEAD}CONTEXTO:\n{ctx}{extra}\n\nPREGUNTAS:\n{qs}\n"


def resolve(cmd):
    exe = shutil.which(cmd)
    return ["cmd", "/C", exe] if exe and exe.lower().endswith((".cmd", ".bat")) else [exe]


def clean_env():
    return {k: v for k, v in os.environ.items() if not k.startswith("CLAUDECODE") and k != "CLAUDE_CODE_ENTRYPOINT"}


def call_claude(prompt, tools):
    scratch = tempfile.mkdtemp(prefix="lxo-cp-claude-")
    args = resolve("claude") + ["-p", "--model", HAIKU, "--output-format", "json", "--no-session-persistence", "--disable-slash-commands",
                                "--strict-mcp-config", "--max-budget-usd", MAX_BUDGET_USD,
                                "--system-prompt", "Eres un agente de ingeniería que responde con precisión y brevedad."]
    if tools:
        args += ["--tools", "Read,Grep,Glob,Bash", "--allowedTools", "Read", "Grep", "Glob", "Bash(git *)"]
        cwd = REPO
    else:
        args += ["--tools", ""]
        cwd = scratch
    t0 = time.time()
    p = subprocess.run(args, cwd=cwd, env=clean_env(), input=prompt, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
    shutil.rmtree(scratch, ignore_errors=True)
    try:
        j = json.loads(p.stdout)
    except Exception:
        return {"error": (p.stdout + p.stderr)[:300]}
    u = j.get("usage", {})
    return {"text": j.get("result", ""), "segundos": round(time.time() - t0, 1), "costo_usd": j.get("total_cost_usd"),
            "tokens": {"entrada": u.get("input_tokens"), "cache_creada": u.get("cache_creation_input_tokens"), "cache_leida": u.get("cache_read_input_tokens"), "salida": u.get("output_tokens")},
            "turnos": j.get("num_turns")}


def call_codex(prompt, tools):
    scratch = tempfile.mkdtemp(prefix="lxo-cp-codex-")
    cwd = REPO if tools else scratch
    args = resolve("codex") + ["exec", "--json", "-m", LUNA, "-s", "read-only", "--skip-git-repo-check", "--ephemeral"]
    t0 = time.time()
    try:
        p = subprocess.run(args, cwd=cwd, env=os.environ.copy(), input=prompt, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    except subprocess.TimeoutExpired:
        shutil.rmtree(scratch, ignore_errors=True)
        return {"error": "codex no terminó en 300 s (explorando el disco)"}
    shutil.rmtree(scratch, ignore_errors=True)
    text, usage, herramientas = "", {}, []
    for l in p.stdout.splitlines():
        try:
            v = json.loads(l)
        except Exception:
            continue
        if v.get("type") == "item.completed" and v.get("item", {}).get("type") == "agent_message":
            text = v["item"].get("text", "")
        elif v.get("type") == "item.completed" and v.get("item", {}).get("type") not in ("reasoning", "agent_message"):
            it = v["item"]
            herramientas.append(f'{it.get("type")}: {str(it.get("command") or it.get("tool") or "")[:90]}')
        if v.get("type") == "turn.completed":
            usage = v.get("usage", {})
    if not text:
        return {"error": (p.stdout + p.stderr)[-300:]}
    return {"text": text, "segundos": round(time.time() - t0, 1), "costo_usd": None,
            "tokens": {"entrada": usage.get("input_tokens"), "cache_leida": usage.get("cached_input_tokens"), "salida": usage.get("output_tokens")}, "herramientas_usadas": herramientas}


def score(text):
    m = re.search(r"\{.*\}", text, re.S)
    try:
        ans = json.loads(m.group(0)) if m else {}
    except Exception:
        ans = {}
    out, res = {}, {"correcta": 0, "desconocido": 0, "incorrecta": 0}
    for qid, _, ok in QUESTIONS:
        a = str(ans.get(qid, "")).strip()
        low = a.lower()
        if not a or UNKNOWN.search(low) and not ok(low):
            kind = "desconocido"
        elif ok(low):
            kind = "correcta"
        else:
            kind = "incorrecta"
        out[qid] = kind
        res[kind] += 1
    return {"detalle": out, **res, "fuga_del_centinela": SENTINEL in text}


EXPERIMENTOS = [
    # id, escenario, proveedor, variante, con herramientas
    ("A1", "A", "claude", "nada", False),
    ("A2", "A", "claude", "solo_resumen", False),
    ("A3", "A", "claude", "completo", False),
    ("A4", "A", "claude", "diff_inline", False),
    ("A5", "A", "claude", "solo_refs", True),
    ("B1", "B", "codex", "nada", False),
    ("B2", "B", "codex", "completo", False),
    ("B3", "B", "codex", "solo_refs", True),
]


def modelos(solo=None):
    out = {}
    for eid, esc, prov, var, tools in EXPERIMENTOS:
        if solo and eid not in solo:
            continue
        prompt = prompt_for(var, tools)
        print(f"{eid}: {prov} · {var} · herramientas={tools} · prompt≈{tokens(prompt)} tokens", flush=True)
        r = (call_claude if prov == "claude" else call_codex)(prompt, tools)
        entry = {"escenario": esc, "proveedor": prov, "modelo": HAIKU if prov == "claude" else LUNA, "variante": var, "herramientas": tools, "prompt_tokens_aprox": tokens(prompt)}
        if "error" in r:
            entry["error"] = r["error"]
        else:
            entry.update({k: r[k] for k in ("segundos", "costo_usd", "tokens", "herramientas_usadas", "turnos") if k in r})
            entry["puntaje"] = score(r["text"])
            # Un experimento "sin herramientas" en el que el proveedor las usó igualmente no mide el contexto: se marca.
            entry["contaminado"] = (not tools) and bool(r.get("herramientas_usadas"))
            print(f"   → {entry['puntaje']['correcta']}/10 correctas, {entry['puntaje']['desconocido']} desconocidas, {entry['puntaje']['incorrecta']} incorrectas · coste={r.get('costo_usd')}", flush=True)
        out[eid] = entry
    return out


def main():
    fase = sys.argv[1] if len(sys.argv) > 1 else "medir"
    salida = sys.argv[2] if len(sys.argv) > 2 else None
    res = {"tarea": "LXO-205", "base": BASE, "head": HEAD, "version_arnes": 1}
    if fase in ("medir", "todo"):
        res["medicion"] = medir()
    if fase in ("git", "todo"):
        res["escenario_c"] = escenario_c()
        res["escenario_d"] = escenario_d()
    if fase in ("modelos", "todo"):
        res["modelos"] = modelos(sys.argv[3].split(",") if len(sys.argv) > 3 else None)
    texto = json.dumps(res, ensure_ascii=False, indent=2)
    assert SENTINEL not in texto, "el resultado no debe contener el centinela"
    if salida:
        open(salida, "w", encoding="utf-8", newline="\n").write(texto + "\n")
    else:
        print(texto)


if __name__ == "__main__":
    main()
