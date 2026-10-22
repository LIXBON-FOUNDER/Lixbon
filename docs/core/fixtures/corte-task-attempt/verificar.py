"""Prueba conceptual del corte Task/Attempt y de su rollback por copia (LXO-112).

NO es código productivo: ejercita la ADR (docs/core/CORTE_TASK_ATTEMPT.md) sobre la fixture con SQLite
real y TODAS las migraciones publicadas anteriores al corte (001..008, con el esquema inerte de Task y Attempt), sin
tocar ningún binario ni ~/.lixbon.

    python -I docs/core/fixtures/corte-task-attempt/verificar.py            # comprueba
    python -I docs/core/fixtures/corte-task-attempt/verificar.py --escribir # regenera normalizado.after.json

Escenarios:
  S0  base anterior al corte (001..008) con legacy_state = fixture y las tablas de Task y Attempt vacías e inertes.
  S1  copia previa obligatoria (VACUUM INTO + integrity_check + sidecar con SHA-256).
  S2  corte (borrador SQL en UNA transacción) → tablas normalizadas == normalizado.after.json.
  S3  invariantes: sin ProviderSession por cwd+tiempo, 1 Attempt por Task, legacy congelado,
      FKs íntegras, mismo documento ⇒ mismas filas, vista legacy reconstruible.
  S4  corte que falla a mitad ⇒ la base sigue exactamente en S0 (atomicidad).
  S5  rollback = restaurar la copia de S1: versión 6, documento idéntico, legacy escribible.
"""

import hashlib
import json
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parents[3]
MIGRACIONES = RAIZ / "apps" / "desktop" / "src-tauri" / "src" / "store" / "migrations"
BEFORE = AQUI / "legacy_state.before.json"
AFTER = AQUI / "normalizado.after.json"
CORTE = AQUI / "corte.borrador.sql"
# «F2» = cualquier binario anterior al corte, aunque ya traiga el esquema inerte (007 tasks, 008 attempts).
VERSION_F2 = 8
VERSION_CORTE = 9
LEGACY_REV = 42

TABLAS = ["runs", "tasks", "attempts", "attempt_phases", "worktrees", "provider_sessions", "threads",
          "thread_messages", "artifacts", "decisions", "reviews", "env_blocks", "legacy_residue"]

fallos = []


def ok(cond, que):
    print(("  ok    " if cond else "  FALLA ") + que)
    if not cond:
        fallos.append(que)


def sha(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode()).hexdigest()


def conectar(path):
    c = sqlite3.connect(path, isolation_level=None)
    c.execute("PRAGMA foreign_keys = ON")
    return c


def aplicar(c, version, nombre, sql):
    c.execute("BEGIN IMMEDIATE")
    try:
        for stmt in partir(sql):
            c.execute(stmt)
        c.execute("INSERT INTO schema_migrations VALUES (?, ?, ?, 'verificar.py', 0)", (version, nombre, sha(sql.replace("\r", ""))))
        c.execute(f"PRAGMA user_version = {version}")
        c.execute("COMMIT")
    except Exception:
        c.execute("ROLLBACK")
        raise


def partir(sql):
    """Divide un script en sentencias completas (respeta BEGIN … END de los triggers)."""
    out, buf = [], ""
    for linea in sql.splitlines(keepends=True):
        buf += linea
        if sqlite3.complete_statement(buf):
            if buf.strip():
                out.append(buf)
            buf = ""
    if buf.strip() and not all(l.strip().startswith("--") or not l.strip() for l in buf.splitlines()):
        raise ValueError("sentencia incompleta al final del script")
    return out


def base_f2(path, doc):
    """S0: una base con 001..VERSION_F2 aplicadas, un Project registrado y legacy_state = doc."""
    c = conectar(path)
    c.execute("PRAGMA journal_mode = WAL")
    for f in sorted(MIGRACIONES.glob("*.sql")):
        n = int(f.name[:3])
        if n > VERSION_F2:
            break
        sql = f.read_text(encoding="utf-8")
        if n == 1:
            c.executescript(sql)
            c.execute("INSERT INTO schema_migrations VALUES (1, ?, ?, 'verificar.py', 0)", (f.stem[4:], sha(sql.replace("\r", ""))))
            c.execute("PRAGMA user_version = 1")
        else:
            aplicar(c, n, f.stem[4:], sql)
    c.execute("INSERT INTO projects (id, name, created_at, updated_at, fingerprint) VALUES ('p-1', 'app', 0, 0, '{}')")
    c.execute("INSERT INTO legacy_state (id, rev, doc_schema, doc, updated_at) VALUES (1, ?, 0, ?, 0)", (LEGACY_REV, doc))
    return c


def esquema(c):
    return sorted(r[0] for r in c.execute("SELECT type || ':' || name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"))


def volcar(c):
    out = {}
    for t in TABLAS:
        cur = c.execute(f"SELECT * FROM {t} ORDER BY 1, 2")
        cols = [d[0] for d in cur.description]
        filas = []
        for r in cur.fetchall():
            fila = dict(zip(cols, r))
            for k in ("policy", "requested_argv", "delivered", "files", "env_plan", "detail_json", "value"):
                if isinstance(fila.get(k), str):
                    fila[k] = json.loads(fila[k])
            filas.append(fila)
        out[t] = filas
    out["meta"] = dict(c.execute("SELECT key, value FROM meta WHERE key IN ('id_seq', 'f3_cut_legacy_rev', 'agentic_model') ORDER BY key").fetchall())
    return out


def copia_previa(c, dir_backups):
    """S1: VACUUM INTO a *.tmp, integrity_check, rename y sidecar. Nunca se copia el .db en caliente."""
    dir_backups.mkdir(parents=True)
    tmp = dir_backups / "lixbon-1792100000000-0-pre-f3-cut.db.tmp"
    final = tmp.with_suffix("")
    c.execute("VACUUM INTO ?", (str(tmp),))
    v = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
    integridad = v.execute("PRAGMA integrity_check").fetchone()[0]
    version = v.execute("PRAGMA user_version").fetchone()[0]
    rev, doc = v.execute("SELECT rev, doc FROM legacy_state WHERE id = 1").fetchone()
    v.close()
    tmp.rename(final)
    sidecar = {
        "v": 1, "label": "pre-f3-cut", "db": final.name, "db_sha256": sha(final.read_bytes()),
        "user_version": version, "legacy_rev": rev, "legacy_doc_sha256": sha(doc), "integrity_check": integridad,
    }
    (dir_backups / (final.name + ".json")).write_text(json.dumps(sidecar, indent=2), encoding="utf-8")
    return final, sidecar


def cortar(c):
    aplicar(c, VERSION_CORTE, "task_attempt", CORTE.read_text(encoding="utf-8"))


# ── vista legacy (lo que el Core expondría a los clientes F2 tras el corte) ──

DEFAULTS_TASK = {
    "model": None, "effort": None, "role": None, "spec": "", "project_id": None, "phases": [], "summary": "", "files": [],
    "report": None, "external": False, "merged": False, "pr_url": None, "env": None, "base_commit": None, "profile": None,
    "ack_unverified": False, "requested_argv": None, "policy": None, "report_nonce": None, "delivered": [],
    "delivery_channel": None, "model_effective": None, "model_requested": None, "model_mismatch": False,
    "model_mismatch_reason": None, "plan_mode": False, "approval_deadline": None, "failure_reason": None,
    "session_ref": None, "model_source": None, "session_match": None, "attempt_started": None,
    "last_message_path": None, "stream_json": False,
}


def vista_legacy(c):
    c.row_factory = sqlite3.Row
    q = lambda sql, *a: c.execute(sql, a).fetchall()
    tareas = {}
    for t in q("SELECT * FROM tasks"):
        a = q("SELECT * FROM attempts WHERE task_id = ? ORDER BY n DESC LIMIT 1", t["id"])[0]
        wt = q("SELECT * FROM worktrees WHERE id = ?", a["worktree_id"])
        wt = wt[0] if wt else None
        ps = q("SELECT * FROM provider_sessions WHERE id = ?", a["provider_session_id"])
        ps = ps[0] if ps else None
        art = {r["kind"]: r["uri"] for r in q("SELECT kind, uri FROM artifacts WHERE attempt_id = ?", a["id"])}
        fases = [{"name": f["name"], "done": bool(f["done"]), "note": f["note"], "at": f["at"]}
                 for f in q("SELECT * FROM attempt_phases WHERE attempt_id = ? ORDER BY ord", a["id"])]
        js = lambda v: json.loads(v) if v is not None else None
        tareas[t["id"]] = {
            "id": t["id"], "run": t["run_id"], "parent": t["parent_task_id"], "depth": t["depth"], "agent": a["provider"],
            "model": a["model"], "effort": a["effort"], "role": a["role"], "title": t["title"], "spec": t["spec"],
            "repo": t["repo"], "project_id": t["project_id"], "cwd": a["cwd"],
            "branch": wt["branch"] if wt else a["checkout_branch"], "base": wt["base_branch"] if wt else None,
            "worktree": wt["path"] if wt else None, "status": a["status"], "phases": fases, "summary": a["summary"],
            "files": json.loads(a["files"]), "report": art.get("report"), "external": bool(a["external"]),
            "merged": bool(a["integrated"]), "pr_url": art.get("pull_request"), "env": js(wt["env_plan"]) if wt else None,
            "base_commit": wt["base_commit"] if wt else None, "profile": a["profile"],
            "ack_unverified": bool(a["ack_unverified"]), "requested_argv": js(a["requested_argv"]), "policy": js(a["policy"]),
            "report_nonce": a["report_nonce"], "delivered": json.loads(a["delivered"]),
            "delivery_channel": a["delivery_channel"], "model_effective": a["model_effective"],
            "model_requested": a["model_requested"], "model_mismatch": bool(a["model_mismatch"]),
            "model_mismatch_reason": a["model_mismatch_reason"], "plan_mode": bool(a["plan_mode"]),
            "approval_deadline": a["approval_deadline"], "failure_reason": a["failure_reason"],
            "session_ref": ps["external_ref"] if ps else None, "model_source": a["model_source"],
            "session_match": ("session_id" if ps["binding"] == "session_id" else None) if ps else None,
            "attempt_started": a["started_at"], "last_message_path": art.get("last_message"),
            "stream_json": bool(a["stream_json"]), "created": t["created_at"], "updated": t["updated_at"],
        }
    mensajes = [{"id": m["id"], "run": th["run_id"], "from": m["from_task_id"], "to": m["to_task_id"], "kind": m["kind"],
                 "body": m["body"], "reply_to": m["reply_to"], "read": bool(m["read"]), "at": m["at"]}
                for m in q("SELECT * FROM thread_messages ORDER BY id")
                for th in q("SELECT run_id FROM threads WHERE id = ?", m["thread_id"])]
    c.row_factory = None
    return tareas, mensajes


# Diferencias DELIBERADAS entre el legado y la vista tras el corte (ADR §Decisiones D3).
DIFERENCIAS_ESPERADAS = {
    ("t4", "session_ref"): ("/home/ana/.codex/sessions/2026/10/rollout-quiza-t4.jsonl", None),
    ("t4", "session_match"): ("cwd_time", None),
    ("t4", "model_source"): ("session_declared", "unknown"),
}


def main():
    escribir = "--escribir" in sys.argv
    doc = BEFORE.read_text(encoding="utf-8")
    legacy = json.loads(doc)
    with tempfile.TemporaryDirectory(prefix="lxo112-") as tmp:
        tmp = Path(tmp)
        core = tmp / "core"
        core.mkdir()
        db = core / "lixbon.db"

        print(f"S0  base anterior al corte (migraciones 001..{VERSION_F2:03} publicadas) con legacy_state = fixture")
        c = base_f2(str(db), doc)
        esquema_f2 = esquema(c)
        ok(c.execute("PRAGMA user_version").fetchone()[0] == VERSION_F2, f"user_version = {VERSION_F2}")
        try:
            c.execute("INSERT INTO runs (id, objective, root_task_id, created_at, last_activity) VALUES ('r0', 'o', 't0', 0, 0)")
            ok(False, "antes del corte las tablas de Task son inertes")
        except sqlite3.DatabaseError as e:
            ok("inerte" in str(e), "antes del corte las tablas de Task son inertes (la 007 aborta la escritura)")

        print("S1  copia previa obligatoria")
        copia, sidecar = copia_previa(c, core / "backups")
        ok(sidecar["integrity_check"] == "ok", "la copia pasa integrity_check")
        ok(sidecar["user_version"] == VERSION_F2 and sidecar["legacy_rev"] == LEGACY_REV, f"la copia es la base anterior al corte (v{VERSION_F2}, rev 42)")
        ok(sidecar["legacy_doc_sha256"] == sha(doc), "el SHA-256 del documento coincide con la fixture")

        print("S2  corte en una transacción")
        cortar(c)
        ok(c.execute("PRAGMA user_version").fetchone()[0] == VERSION_CORTE, f"user_version = {VERSION_CORTE}")
        dump = volcar(c)
        if escribir:
            AFTER.write_text(json.dumps(dump, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            print(f"  escrito {AFTER.name}")
        ok(dump == json.loads(AFTER.read_text(encoding="utf-8")), "tablas normalizadas == normalizado.after.json")

        print("S3  invariantes")
        ok(c.execute("PRAGMA foreign_key_check").fetchall() == [], "foreign_key_check vacío")
        ok(not any(s["task_id"] == "t4" for s in dump["provider_sessions"]), "t4 (cwd_time) NO tiene ProviderSession")
        ok(any(r["legacy_id"] == "t4" and r["reason"] == "session_not_verified" for r in dump["legacy_residue"]),
           "la sesión de t4 queda en legacy_residue, no se descarta")
        ok(sorted(a["task_id"] for a in dump["attempts"]) == sorted(legacy["tasks"]) and all(a["n"] == 1 for a in dump["attempts"]),
           "exactamente un Attempt n=1 por Task legacy")
        ok({t["id"] for t in dump["tasks"]} == set(legacy["tasks"]), "los ids de Task se conservan")
        ok({m["id"] for m in dump["thread_messages"]} == {m["id"] for m in legacy["messages"]} - {15},
           "los ids de mensaje se conservan (el 15, colgante, va a residuo)")
        ok([r["attempt_id"] for r in dump["reviews"]] == ["t3-a1", "t5-a1"], "las revisiones apuntan a Attempt + head_commit")
        for sql in ("UPDATE legacy_state SET rev = rev + 1", "DELETE FROM legacy_state", "INSERT INTO legacy_state VALUES (2, 1, 0, '{}', 0)"):
            try:
                c.execute(sql)
                ok(False, f"legacy_state congelado: {sql.split()[0]}")
            except sqlite3.DatabaseError as e:
                ok("congelado" in str(e), f"legacy_state congelado: {sql.split()[0]} aborta")
        c2 = base_f2(str(tmp / "otra.db"), doc)
        cortar(c2)
        ok(volcar(c2) == dump, "determinismo: el mismo documento produce las mismas filas")
        c2.close()

        tareas, mensajes = vista_legacy(c)
        difs = {}
        for tid, t in legacy["tasks"].items():
            esperado = {**DEFAULTS_TASK, **t}
            for k in esperado.keys() | tareas[tid].keys():
                if esperado.get(k) != tareas[tid].get(k):
                    difs[(tid, k)] = (esperado.get(k), tareas[tid].get(k))
        ok(difs == DIFERENCIAS_ESPERADAS, "vista legacy de Tasks == legado salvo las diferencias declaradas (D3)")
        for k, v in sorted(difs.items()):
            print(f"        {k[0]}.{k[1]}: {v[0]!r} -> {v[1]!r}")
        legacy_msgs = [{"reply_to": None, "read": False, **m} for m in legacy["messages"] if m["id"] != 15]
        ok(mensajes == legacy_msgs, "vista legacy de mensajes == legado (sin el colgante)")
        c.close()

        print("S4  un corte que falla a mitad no deja nada")
        roto = json.loads(doc)
        roto["tasks"]["t17"]["status"] = "zombie"
        c3 = base_f2(str(tmp / "rota.db"), json.dumps(roto))
        antes = (esquema(c3), c3.execute("SELECT rev, doc FROM legacy_state").fetchone())
        try:
            cortar(c3)
            ok(False, "el corte con un estado desconocido aborta")
        except sqlite3.DatabaseError:
            ok(True, "el corte con un estado desconocido aborta")
        ok(c3.execute("PRAGMA user_version").fetchone()[0] == VERSION_F2, f"la base sigue en v{VERSION_F2}")
        ok((esquema(c3), c3.execute("SELECT rev, doc FROM legacy_state").fetchone()) == antes,
           "mismo esquema y mismo legacy_state que antes del intento")
        c3.close()

        print("S5  rollback = restaurar la copia previa (nunca downgrade del esquema)")
        ok(VERSION_CORTE > VERSION_F2, f"un binario anterior al corte (máx. {VERSION_F2}) abre la base cortada con DatabaseNewer: no la toca")
        apartado = core / "rollback-1792200000000"
        apartado.mkdir()
        for f in core.glob("lixbon.db*"):
            shutil.move(str(f), apartado / f.name)
        ok(sha(copia.read_bytes()) == sidecar["db_sha256"], "la copia no cambió desde S1 (SHA-256 del sidecar)")
        shutil.copyfile(copia, db)
        r = conectar(str(db))
        ok(r.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "la base restaurada pasa integrity_check")
        ok(r.execute("PRAGMA user_version").fetchone()[0] == VERSION_F2, f"la base restaurada está en v{VERSION_F2}")
        ok(esquema(r) == esquema_f2, "el esquema restaurado es exactamente el anterior al corte (sin tablas ni triggers del corte)")
        rev, doc_r = r.execute("SELECT rev, doc FROM legacy_state").fetchone()
        ok(rev == LEGACY_REV and sha(doc_r) == sidecar["legacy_doc_sha256"], "legacy_state restaurado: rev 42 y mismo SHA-256")
        r.execute("UPDATE legacy_state SET rev = rev + 1")
        ok(True, "un binario anterior al corte vuelve a poder escribir legacy_state")
        ok((apartado / "lixbon.db").exists(), "la base cortada queda apartada, no borrada")
        r.close()

    print()
    if fallos:
        print(f"{len(fallos)} comprobación(es) fallaron")
        sys.exit(1)
    print("todo ok")


if __name__ == "__main__":
    main()
