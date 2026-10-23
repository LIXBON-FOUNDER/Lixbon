-- BORRADOR DE DISEÑO (LXO-112). NO es una migración: no vive en store/migrations/, build.rs no lo
-- embebe y ningún binario lo ejecuta. Fija, de forma ejecutable, el mapeo legacy_state → tablas que
-- la ADR (docs/core/CORTE_TASK_ATTEMPT.md) describe. `verificar.py` lo aplica a la fixture sobre TODAS las
-- migraciones publicadas anteriores al corte (001..008) y compara el resultado con `normalizado.after.json`.
--
-- El esquema de cada entidad llega antes, en su propia migración e INERTE (`007_tasks`: runs y tasks, LXO-113;
-- `008_attempts`: attempts, LXO-114; `009_sessions_threads`: provider_sessions, threads y thread_messages, LXO-115).
-- Este borrador crea solo lo que todavía no está publicado; según se publique cada entidad, su CREATE sale de
-- aquí. El corte real será `NNN_task_attempt_cut` (el siguiente número libre) y, desde ese momento, su texto
-- no se edita (checksum). Mismas reglas que toda migración: una transacción (sin BEGIN/COMMIT), STRICT, ms
-- epoch, identificadores TEXT.
--
-- Orden dentro de la transacción:
--   0. Activar el modelo (`meta.agentic_model`): los triggers de la 007 impiden escribir sin esa clave.
--   1. DDL de las entidades que aún no tienen migración propia.
--   2. Copia determinista desde legacy_state (solo SQL + JSON1: mismo documento ⇒ mismas filas).
--   3. Residuo: lo que NO se mapea va a legacy_residue con un motivo, nunca se descarta en silencio.
--   4. Asserts de conteo (una fila con CHECK (ok = 1)): si algo no cuadra, aborta TODA la migración.
--   5. Congelar legacy_state (triggers) y registrar el corte en meta.

-- ───────────────────────────── 0. Activar ─────────────────────────────
-- Primero: sin esta clave, los triggers `*_inert_*` de la 007 abortan cualquier INSERT en runs y tasks.

INSERT INTO meta (key, value) VALUES ('agentic_model', 'task_attempt_v1');

-- ───────────────────────────── 1. DDL ─────────────────────────────
-- `runs` y `tasks` ya existen (007_tasks, LXO-113): tasks guarda la intención (`intent` = 'open' por defecto).

-- `attempts` ya existe (008_attempts, LXO-114): identidad, selección, ciclo de vida y resultado mínimo. Un retry o un
-- seguimiento crea otra fila (n + 1); nunca se pisa. Las columnas de RUNTIME (cwd, política, entrega, modelo efectivo…)
-- llegan con la migración del slice que las usa, como `ALTER TABLE ... ADD COLUMN`; aquí se añaden para que el borrador
-- sea ejecutable de punta a punta y el corte real las omitirá según se vayan publicando.
ALTER TABLE attempts ADD COLUMN instruction           TEXT;                 -- encargo propio del intento (seguimiento); NULL en legacy
ALTER TABLE attempts ADD COLUMN cwd                   TEXT    NOT NULL DEFAULT '';
ALTER TABLE attempts ADD COLUMN checkout_branch       TEXT;                 -- rama del checkout cuando NO hay Worktree propio (raíz)
ALTER TABLE attempts ADD COLUMN policy                TEXT    CHECK (policy IS NULL OR json_valid(policy));
ALTER TABLE attempts ADD COLUMN ack_unverified        INTEGER NOT NULL DEFAULT 0 CHECK (ack_unverified IN (0, 1));
ALTER TABLE attempts ADD COLUMN requested_argv        TEXT    CHECK (requested_argv IS NULL OR json_valid(requested_argv));
ALTER TABLE attempts ADD COLUMN plan_mode             INTEGER NOT NULL DEFAULT 0 CHECK (plan_mode IN (0, 1));
ALTER TABLE attempts ADD COLUMN stream_json           INTEGER NOT NULL DEFAULT 0 CHECK (stream_json IN (0, 1));
ALTER TABLE attempts ADD COLUMN report_nonce          TEXT;
ALTER TABLE attempts ADD COLUMN delivered             TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(delivered));
ALTER TABLE attempts ADD COLUMN delivery_channel      TEXT;
ALTER TABLE attempts ADD COLUMN model_requested       TEXT;
ALTER TABLE attempts ADD COLUMN model_effective       TEXT;
ALTER TABLE attempts ADD COLUMN model_source          TEXT;
ALTER TABLE attempts ADD COLUMN model_mismatch        INTEGER NOT NULL DEFAULT 0 CHECK (model_mismatch IN (0, 1));
ALTER TABLE attempts ADD COLUMN model_mismatch_reason TEXT;
ALTER TABLE attempts ADD COLUMN approval_deadline     INTEGER;
ALTER TABLE attempts ADD COLUMN files                 TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(files));
ALTER TABLE attempts ADD COLUMN integrated            INTEGER NOT NULL DEFAULT 0 CHECK (integrated IN (0, 1));

CREATE TABLE attempt_phases (
  attempt_id TEXT    NOT NULL REFERENCES attempts (id),
  ord        INTEGER NOT NULL CHECK (ord >= 0),
  name       TEXT    NOT NULL,
  done       INTEGER NOT NULL CHECK (done IN (0, 1)),
  note       TEXT    NOT NULL DEFAULT '',
  at         INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, ord)
) STRICT;

-- Worktree: lo posee la Task (dura más que un intento); lo crea un Attempt concreto.
CREATE TABLE worktrees (
  id                    TEXT    PRIMARY KEY,
  task_id               TEXT    NOT NULL REFERENCES tasks (id),
  created_by_attempt_id TEXT    NOT NULL REFERENCES attempts (id) DEFERRABLE INITIALLY DEFERRED,
  repo                  TEXT    NOT NULL,
  path                  TEXT,                 -- NULL una vez liberado (la rama puede conservarse)
  branch                TEXT,
  base_branch           TEXT,
  base_commit           TEXT,
  env_plan              TEXT    CHECK (env_plan IS NULL OR json_valid(env_plan)),
  state                 TEXT    NOT NULL CHECK (state IN ('active', 'released')),
  origin                TEXT    NOT NULL CHECK (origin IN ('legacy', 'core')),
  CHECK ((state = 'active') = (path IS NOT NULL)),
  CHECK (state = 'active' OR branch IS NOT NULL)
) STRICT;

-- `provider_sessions`, `threads` y `thread_messages` ya existen (009_sessions_threads, LXO-115): solo vínculos declarados
-- por el proveedor (`cwd_time` no es un vínculo), ciclo de vida `open` · `idle` · `closed` y Thread por Task.

-- Artifact: lo que deja un Attempt concreto.
CREATE TABLE artifacts (
  id         TEXT    PRIMARY KEY,
  attempt_id TEXT    NOT NULL REFERENCES attempts (id),
  kind       TEXT    NOT NULL CHECK (kind IN ('report', 'pull_request', 'last_message')),
  uri        TEXT    NOT NULL,
  created_at INTEGER,
  origin     TEXT    NOT NULL CHECK (origin IN ('legacy', 'core')),
  CHECK (created_at IS NOT NULL OR origin = 'legacy')
) STRICT;

CREATE TABLE decisions (
  id          INTEGER PRIMARY KEY,            -- id legacy conservado (los eventos lo citan)
  task_id     TEXT    NOT NULL REFERENCES tasks (id),
  attempt_id  TEXT    REFERENCES attempts (id),
  kind        TEXT    NOT NULL,
  actor       TEXT    NOT NULL,
  detail_json TEXT    CHECK (detail_json IS NULL OR json_valid(detail_json)),
  at          INTEGER NOT NULL
) STRICT;

-- Review targeting: una revisión apunta a (Attempt, commit), no a la Task.
CREATE TABLE reviews (
  decision_id INTEGER PRIMARY KEY REFERENCES decisions (id),
  attempt_id  TEXT    NOT NULL REFERENCES attempts (id),
  head_commit TEXT    NOT NULL,
  verdict     TEXT    NOT NULL CHECK (verdict IN ('accepted', 'rejected')),
  at          INTEGER NOT NULL
) STRICT;

CREATE TABLE env_blocks (
  scope TEXT NOT NULL,
  cause TEXT NOT NULL CHECK (cause IN ('cli_missing', 'cli_flags_unsupported', 'windows_sandbox_elevated')),
  PRIMARY KEY (scope, cause)
) STRICT;

CREATE TABLE legacy_residue (
  entity_kind TEXT NOT NULL,
  legacy_id   TEXT NOT NULL,
  field       TEXT NOT NULL,
  value       TEXT NOT NULL CHECK (json_valid(value)),
  reason      TEXT NOT NULL,
  PRIMARY KEY (entity_kind, legacy_id, field)
) STRICT;

CREATE INDEX decisions_by_attempt ON decisions (attempt_id, kind, id);
CREATE INDEX reviews_by_attempt ON reviews (attempt_id, decision_id);
CREATE UNIQUE INDEX worktrees_one_active_path ON worktrees (path) WHERE path IS NOT NULL;

-- ───────────────────────────── 2. Copia ─────────────────────────────
-- `L` = cada Task del documento. Los booleanos de serde ausentes son `false` (serde(default)).

INSERT INTO runs (id, objective, root_task_id, created_at, closed, last_activity)
SELECT r.key,
       json_extract(r.value, '$.objective'),
       json_extract(r.value, '$.root'),
       json_extract(r.value, '$.created'),
       coalesce(json_extract(r.value, '$.closed'), 0),
       coalesce(json_extract(r.value, '$.last_activity'), 0)
FROM legacy_state, json_each(legacy_state.doc, '$.runs') AS r;

INSERT INTO tasks (id, run_id, parent_task_id, depth, project_id, title, spec, repo, origin, created_at, updated_at)
SELECT t.key,
       json_extract(t.value, '$.run'),
       json_extract(t.value, '$.parent'),
       json_extract(t.value, '$.depth'),
       -- Un project_id que el registro no conoce no se inventa ni se resuelve por ruta: queda NULL (+ residuo).
       (SELECT p.id FROM projects AS p WHERE p.id = json_extract(t.value, '$.project_id')),
       json_extract(t.value, '$.title'),
       coalesce(json_extract(t.value, '$.spec'), ''),
       json_extract(t.value, '$.repo'),
       'legacy',
       json_extract(t.value, '$.created'),
       json_extract(t.value, '$.updated')
FROM legacy_state, json_each(legacy_state.doc, '$.tasks') AS t;

-- Un Attempt por Task, n = 1, id determinista `<task>-a1`. El historial de seguimientos anteriores
-- (`reopen` pisaba la Task) no existe en el legado y NO se reconstruye (decisión D5).
INSERT INTO attempts (id, task_id, n, status, external, provider, role, profile, model, effort, instruction, cwd,
                      checkout_branch, worktree_id, provider_session_id, policy, ack_unverified, requested_argv,
                      plan_mode, stream_json, report_nonce, delivered, delivery_channel, model_requested,
                      model_effective, model_source, model_mismatch, model_mismatch_reason, approval_deadline,
                      failure_reason, summary, files, integrated, started_at, ended_at, created_at, updated_at, origin)
SELECT t.key || '-a1', t.key, 1,
       json_extract(t.value, '$.status'),
       coalesce(json_extract(t.value, '$.external'), 0),
       json_extract(t.value, '$.agent'),
       json_extract(t.value, '$.role'),
       json_extract(t.value, '$.profile'),
       json_extract(t.value, '$.model'),
       json_extract(t.value, '$.effort'),
       NULL,
       json_extract(t.value, '$.cwd'),
       CASE WHEN json_extract(t.value, '$.worktree') IS NULL AND json_extract(t.value, '$.base') IS NULL
            THEN json_extract(t.value, '$.branch') END,
       CASE WHEN json_extract(t.value, '$.worktree') IS NOT NULL
              OR (json_extract(t.value, '$.branch') IS NOT NULL AND json_extract(t.value, '$.base') IS NOT NULL)
            THEN 'wt-' || t.key || '-a1' END,
       CASE WHEN (json_extract(t.value, '$.agent') = 'claude' AND coalesce(json_extract(t.value, '$.stream_json'), 0) = 1
                  OR json_extract(t.value, '$.session_match') = 'session_id')
             AND json_extract(t.value, '$.session_ref') IS NOT NULL
            THEN 'ps-' || t.key || '-a1' END,
       json_extract(t.value, '$.policy'),
       coalesce(json_extract(t.value, '$.ack_unverified'), 0),
       json_extract(t.value, '$.requested_argv'),
       coalesce(json_extract(t.value, '$.plan_mode'), 0),
       coalesce(json_extract(t.value, '$.stream_json'), 0),
       json_extract(t.value, '$.report_nonce'),
       coalesce(json_extract(t.value, '$.delivered'), '[]'),
       json_extract(t.value, '$.delivery_channel'),
       json_extract(t.value, '$.model_requested'),
       json_extract(t.value, '$.model_effective'),
       -- Un modelo que se leyó de una sesión atada por cwd+tiempo no tiene procedencia verificada (D3).
       CASE WHEN json_extract(t.value, '$.session_match') = 'cwd_time' THEN 'unknown'
            ELSE json_extract(t.value, '$.model_source') END,
       coalesce(json_extract(t.value, '$.model_mismatch'), 0),
       json_extract(t.value, '$.model_mismatch_reason'),
       json_extract(t.value, '$.approval_deadline'),
       json_extract(t.value, '$.failure_reason'),
       coalesce(json_extract(t.value, '$.summary'), ''),
       coalesce(json_extract(t.value, '$.files'), '[]'),
       coalesce(json_extract(t.value, '$.merged'), 0),
       json_extract(t.value, '$.attempt_started'),
       NULL,                                         -- el legado no registra el fin: no se inventa
       json_extract(t.value, '$.created'),
       json_extract(t.value, '$.updated'),
       'legacy'
FROM legacy_state, json_each(legacy_state.doc, '$.tasks') AS t;

INSERT INTO attempt_phases (attempt_id, ord, name, done, note, at)
SELECT t.key || '-a1', CAST(p.key AS INTEGER),
       json_extract(p.value, '$.name'), json_extract(p.value, '$.done'),
       coalesce(json_extract(p.value, '$.note'), ''), json_extract(p.value, '$.at')
FROM legacy_state, json_each(legacy_state.doc, '$.tasks') AS t, json_each(t.value, '$.phases') AS p;

INSERT INTO worktrees (id, task_id, created_by_attempt_id, repo, path, branch, base_branch, base_commit, env_plan, state, origin)
SELECT 'wt-' || t.key || '-a1', t.key, t.key || '-a1',
       json_extract(t.value, '$.repo'),
       json_extract(t.value, '$.worktree'),
       json_extract(t.value, '$.branch'),
       json_extract(t.value, '$.base'),
       json_extract(t.value, '$.base_commit'),
       json_extract(t.value, '$.env'),
       CASE WHEN json_extract(t.value, '$.worktree') IS NOT NULL THEN 'active' ELSE 'released' END,
       'legacy'
FROM legacy_state, json_each(legacy_state.doc, '$.tasks') AS t
WHERE json_extract(t.value, '$.worktree') IS NOT NULL
   OR (json_extract(t.value, '$.branch') IS NOT NULL AND json_extract(t.value, '$.base') IS NOT NULL);

-- Las dos formas de vínculo admiten reanudar (Claude `--resume`, Codex `resume`): resumible. Sigue `open` mientras su
-- Attempt no ha terminado; si terminó, queda en espera de un seguimiento (`idle`). El legado no fecha la sesión: se
-- toma el arranque del intento o, sin él, la creación de la Task.
INSERT INTO provider_sessions (id, task_id, opened_by_attempt_id, provider, external_ref, binding, resumable, status,
                               created_at, updated_at, origin)
SELECT 'ps-' || t.key || '-a1', t.key, t.key || '-a1',
       json_extract(t.value, '$.agent'),
       json_extract(t.value, '$.session_ref'),
       CASE WHEN json_extract(t.value, '$.session_match') = 'session_id' THEN 'session_id' ELSE 'stream_json' END,
       1,
       CASE WHEN json_extract(t.value, '$.status') IN ('done', 'failed', 'stopped', 'exited') THEN 'idle' ELSE 'open' END,
       coalesce(json_extract(t.value, '$.attempt_started'), json_extract(t.value, '$.created')),
       json_extract(t.value, '$.updated'),
       'legacy'
FROM legacy_state, json_each(legacy_state.doc, '$.tasks') AS t
WHERE json_extract(t.value, '$.session_ref') IS NOT NULL
  AND (json_extract(t.value, '$.agent') = 'claude' AND coalesce(json_extract(t.value, '$.stream_json'), 0) = 1
       OR json_extract(t.value, '$.session_match') = 'session_id');

INSERT INTO artifacts (id, attempt_id, kind, uri, created_at, origin)
SELECT t.key || '-a1-' || k.kind, t.key || '-a1', k.kind, json_extract(t.value, k.path), NULL, 'legacy'
FROM legacy_state, json_each(legacy_state.doc, '$.tasks') AS t,
     (SELECT 'report' AS kind, '$.report' AS path
      UNION ALL SELECT 'pull_request', '$.pr_url'
      UNION ALL SELECT 'last_message', '$.last_message_path') AS k
WHERE json_extract(t.value, k.path) IS NOT NULL;

-- Mensajes: el Thread es el de la Task de MAYOR profundidad entre emisor y destino (la hija); un
-- mensaje a sí misma (nota de la persona a la raíz) va al Thread de esa Task. Sin atribución a Attempt.
CREATE TEMP TABLE f3_msg AS
SELECT CAST(json_extract(m.value, '$.id') AS INTEGER) AS id,
       json_extract(m.value, '$.run')  AS run_id,
       json_extract(m.value, '$.from') AS from_id,
       json_extract(m.value, '$.to')   AS to_id,
       m.value AS value,
       (SELECT CASE WHEN f.depth >= d.depth THEN f.id ELSE d.id END
          FROM tasks AS f, tasks AS d
         WHERE f.id = json_extract(m.value, '$.from') AND d.id = json_extract(m.value, '$.to')
           AND f.run_id = json_extract(m.value, '$.run') AND d.run_id = json_extract(m.value, '$.run')
           AND (f.id = d.id OR f.depth <> d.depth)) AS owner
FROM legacy_state, json_each(legacy_state.doc, '$.messages') AS m;

INSERT INTO threads (id, task_id, run_id, origin)
SELECT DISTINCT 'th-' || owner, owner, run_id, 'legacy' FROM f3_msg WHERE owner IS NOT NULL;

INSERT INTO thread_messages (id, thread_id, from_task_id, to_task_id, from_attempt_id, kind, body, reply_to, read, at)
SELECT id, 'th-' || owner, from_id, to_id, NULL,
       json_extract(value, '$.kind'), json_extract(value, '$.body'),
       json_extract(value, '$.reply_to'),
       coalesce(json_extract(value, '$.read'), 0),
       json_extract(value, '$.at')
FROM f3_msg WHERE owner IS NOT NULL;

INSERT INTO decisions (id, task_id, attempt_id, kind, actor, detail_json, at)
SELECT json_extract(d.value, '$.id'), json_extract(d.value, '$.task'), json_extract(d.value, '$.task') || '-a1',
       json_extract(d.value, '$.kind'), json_extract(d.value, '$.actor'), json_extract(d.value, '$.detail_json'),
       json_extract(d.value, '$.at')
FROM legacy_state, json_each(legacy_state.doc, '$.decisions') AS d
WHERE EXISTS (SELECT 1 FROM tasks WHERE id = json_extract(d.value, '$.task'));

INSERT INTO reviews (decision_id, attempt_id, head_commit, verdict, at)
SELECT id, attempt_id, json_extract(detail_json, '$.head_commit'), json_extract(detail_json, '$.decision'), at
FROM decisions
WHERE kind = 'review'
  AND json_extract(detail_json, '$.head_commit') IS NOT NULL
  AND json_extract(detail_json, '$.decision') IN ('accepted', 'rejected');

-- env_blocks admite los dos formatos legacy: una causa (texto) o una lista.
INSERT INTO env_blocks (scope, cause)
SELECT e.key, e.value
FROM legacy_state, json_each(legacy_state.doc, '$.env_blocks') AS e WHERE e.type = 'text'
UNION
SELECT e.key, c.value
FROM legacy_state, json_each(legacy_state.doc, '$.env_blocks') AS e, json_each(e.value) AS c WHERE e.type = 'array';

-- ───────────────────────────── 3. Residuo ─────────────────────────────

INSERT INTO legacy_residue (entity_kind, legacy_id, field, value, reason)
SELECT 'task', t.key, 'session',
       json_object('session_ref', json_extract(t.value, '$.session_ref'),
                   'session_match', json_extract(t.value, '$.session_match'),
                   'model_source', json_extract(t.value, '$.model_source')),
       'session_not_verified'
FROM legacy_state, json_each(legacy_state.doc, '$.tasks') AS t
WHERE json_extract(t.value, '$.session_ref') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM provider_sessions WHERE id = 'ps-' || t.key || '-a1');

INSERT INTO legacy_residue (entity_kind, legacy_id, field, value, reason)
SELECT 'task', t.key, 'project_id', json_quote(json_extract(t.value, '$.project_id')), 'project_not_registered'
FROM legacy_state, json_each(legacy_state.doc, '$.tasks') AS t
WHERE json_extract(t.value, '$.project_id') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM projects WHERE id = json_extract(t.value, '$.project_id'));

INSERT INTO legacy_residue (entity_kind, legacy_id, field, value, reason)
SELECT 'message', CAST(id AS TEXT), 'message', json(value), 'dangling_participant'
FROM f3_msg WHERE owner IS NULL;

INSERT INTO legacy_residue (entity_kind, legacy_id, field, value, reason)
SELECT 'decision', CAST(json_extract(d.value, '$.id') AS TEXT), 'decision', json(d.value), 'dangling_task'
FROM legacy_state, json_each(legacy_state.doc, '$.decisions') AS d
WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE id = json_extract(d.value, '$.task'));

INSERT INTO legacy_residue (entity_kind, legacy_id, field, value, reason)
SELECT 'decision', CAST(d.id AS TEXT), 'review', json(d.detail_json), 'review_without_target'
FROM decisions AS d
WHERE d.kind = 'review' AND NOT EXISTS (SELECT 1 FROM reviews AS r WHERE r.decision_id = d.id);

-- ───────────────────────────── 4. Asserts ─────────────────────────────
-- Cada fila exige ok = 1; una sola que falle aborta la transacción y deja la base en la versión previa.

CREATE TEMP TABLE f3_assert (what TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO f3_assert VALUES
  ('doc_schema_0', (SELECT count(*) = count(CASE WHEN doc_schema = 0 THEN 1 END) FROM legacy_state)),
  ('runs', (SELECT count(*) FROM runs) = (SELECT count(*) FROM legacy_state, json_each(doc, '$.runs'))),
  ('tasks', (SELECT count(*) FROM tasks) = (SELECT count(*) FROM legacy_state, json_each(doc, '$.tasks'))),
  ('attempts_1_por_task', (SELECT count(*) FROM attempts) = (SELECT count(*) FROM tasks)),
  ('messages', (SELECT count(*) FROM thread_messages)
               + (SELECT count(*) FROM legacy_residue WHERE entity_kind = 'message')
               = (SELECT count(*) FROM legacy_state, json_each(doc, '$.messages'))),
  ('decisions', (SELECT count(*) FROM decisions)
                + (SELECT count(*) FROM legacy_residue WHERE entity_kind = 'decision' AND reason = 'dangling_task')
                = (SELECT count(*) FROM legacy_state, json_each(doc, '$.decisions'))),
  ('reviews', (SELECT count(*) FROM reviews)
              + (SELECT count(*) FROM legacy_residue WHERE reason = 'review_without_target')
              = (SELECT count(*) FROM decisions WHERE kind = 'review')),
  ('sin_sesion_inferida', (SELECT count(*) FROM provider_sessions AS s JOIN legacy_state
                           JOIN json_each(legacy_state.doc, '$.tasks') AS t ON t.key = s.task_id
                           WHERE json_extract(t.value, '$.session_match') = 'cwd_time') = 0),
  ('sesiones_cuadran', (SELECT count(*) FROM legacy_state, json_each(doc, '$.tasks') AS t
                        WHERE json_extract(t.value, '$.session_ref') IS NOT NULL)
                       = (SELECT count(*) FROM provider_sessions)
                         + (SELECT count(*) FROM legacy_residue WHERE reason = 'session_not_verified')),
  ('raices', (SELECT count(*) FROM runs AS r JOIN tasks AS t ON t.id = r.root_task_id
              WHERE t.run_id = r.id AND t.parent_task_id IS NULL) = (SELECT count(*) FROM runs));
DROP TABLE f3_assert;
DROP TABLE f3_msg;

-- ───────────────────────────── 5. Congelar y registrar ─────────────────────────────
-- legacy_state se conserva intacto (pieza de auditoría y de rollback) pero ya no se escribe: cualquier
-- ruta de código vieja que intente persistir en él aborta en lugar de crear una segunda autoridad.

INSERT INTO meta (key, value) SELECT 'id_seq', CAST(coalesce(json_extract(doc, '$.seq'), 0) AS TEXT) FROM legacy_state;
INSERT INTO meta (key, value) SELECT 'f3_cut_legacy_rev', CAST(rev AS TEXT) FROM legacy_state;

CREATE TRIGGER legacy_state_frozen_insert BEFORE INSERT ON legacy_state
BEGIN SELECT RAISE(ABORT, 'legacy_state está congelado desde el corte Task/Attempt'); END;
CREATE TRIGGER legacy_state_frozen_update BEFORE UPDATE ON legacy_state
BEGIN SELECT RAISE(ABORT, 'legacy_state está congelado desde el corte Task/Attempt'); END;
CREATE TRIGGER legacy_state_frozen_delete BEFORE DELETE ON legacy_state
BEGIN SELECT RAISE(ABORT, 'legacy_state está congelado desde el corte Task/Attempt'); END;
