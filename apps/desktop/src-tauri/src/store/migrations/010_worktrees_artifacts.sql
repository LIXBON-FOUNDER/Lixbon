-- 010_worktrees_artifacts: Worktree y Artifact como entidades de ejecución (LXO-116, épica F3). Contrato:
-- docs/core/WORKTREES_ARTIFACTS.md.
--
-- UNA responsabilidad: dónde corrió un Attempt (su Worktree) y qué dejó (sus Artifacts), separados de la Task y de las
-- rutas sueltas del documento legacy. Nada destructivo: el almacén registra hechos; borrar carpetas y ramas es del
-- runtime.
--
-- Se aplica DESPUÉS de la 009 y de la valla. INERTE HASTA EL CORTE, como 007..009.
--
-- Decisiones:
--   * LA RUTA NO ES IDENTIDAD: el id es `wt-<attempt que lo registró>`; `machine` + `path` son solo su ubicación, que
--     se pierde (`NULL`) al quitarlo.
--   * PROCEDENCIA: `created` (lo creó Lixbon), `adopted` (existía y pasó a gestionarlo Lixbon) o `external` (Lixbon lo
--     usa pero no es suyo: nunca lo limpia). No cambia.
--   * CICLO DE VIDA: `active` <-> `missing` (la carpeta no está en disco) -> `removed` (final). Quitarlo exige un motivo:
--     `integrated`, `discarded` (lo confirmó una persona) o `gone` (ya no existía). Uno externo solo sale con `gone`.
--   * DUEÑA = la Task (ADR §5); lo registra un Attempt (`attempt_id`) y lo reutilizan sus seguimientos
--     (`attempts.worktree_id`, el vínculo blando de la 008 que aquí se valida).
--   * ARTIFACT: lo deja UN Attempt; tipo cerrado, localizador (ruta, URL o commit) y verificación mínima (`sha256`,
--     `bytes`). Nunca el contenido. Inmutable.
--   * SIN BORRADO: ni DELETE ni cascadas.

CREATE TABLE worktrees (
  id             TEXT    PRIMARY KEY NOT NULL CHECK (id = 'wt-' || attempt_id),
  task_id        TEXT    NOT NULL REFERENCES tasks (id),
  attempt_id     TEXT    NOT NULL UNIQUE REFERENCES attempts (id) DEFERRABLE INITIALLY DEFERRED,
  provenance     TEXT    NOT NULL CHECK (provenance IN ('created', 'adopted', 'external')),
  machine        TEXT    CHECK (machine IS NULL OR length(trim(machine)) > 0),
  repo           TEXT    NOT NULL CHECK (length(repo) BETWEEN 1 AND 1024),
  path           TEXT    CHECK (path IS NULL OR length(path) BETWEEN 1 AND 1024),
  branch         TEXT    CHECK (branch IS NULL OR length(branch) BETWEEN 1 AND 255),
  base_branch    TEXT,
  base_commit    TEXT,
  env_plan       TEXT    CHECK (env_plan IS NULL OR json_valid(env_plan)),
  state          TEXT    NOT NULL CHECK (state IN ('active', 'missing', 'removed')),
  removed_reason TEXT    CHECK (removed_reason IS NULL OR removed_reason IN ('integrated', 'discarded', 'gone')),
  branch_kept    INTEGER NOT NULL DEFAULT 0 CHECK (branch_kept IN (0, 1)),
  missing_since  INTEGER,
  created_at     INTEGER,
  updated_at     INTEGER,
  origin         TEXT    NOT NULL CHECK (origin IN ('legacy', 'core')),
  CHECK ((state = 'removed') = (path IS NULL)),
  CHECK ((state = 'missing') = (missing_since IS NOT NULL)),
  CHECK (branch_kept = 0 OR (state = 'removed' AND branch IS NOT NULL)),
  CHECK (provenance <> 'external' OR removed_reason IS NULL OR removed_reason = 'gone'),
  CHECK (origin = 'legacy' OR (state = 'removed') = (removed_reason IS NOT NULL)),
  CHECK (origin = 'legacy' OR (machine IS NOT NULL AND created_at IS NOT NULL AND updated_at >= created_at))
) STRICT;

CREATE INDEX worktrees_by_task ON worktrees (task_id, state);
CREATE UNIQUE INDEX worktrees_one_active_path ON worktrees (coalesce(machine, ''), path) WHERE path IS NOT NULL;
CREATE INDEX attempts_by_worktree ON attempts (worktree_id, n) WHERE worktree_id IS NOT NULL;

CREATE TABLE artifacts (
  id         TEXT    PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 80),
  attempt_id TEXT    NOT NULL REFERENCES attempts (id),
  kind       TEXT    NOT NULL CHECK (kind IN ('report', 'pull_request', 'last_message', 'commit', 'file')),
  uri        TEXT    NOT NULL CHECK (length(uri) BETWEEN 1 AND 2048),
  sha256     TEXT    CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  bytes      INTEGER CHECK (bytes IS NULL OR bytes >= 0),
  created_at INTEGER,
  origin     TEXT    NOT NULL CHECK (origin IN ('legacy', 'core')),
  CHECK (created_at IS NOT NULL OR origin = 'legacy'),
  CHECK (kind <> 'pull_request' OR uri LIKE 'https://%'),
  CHECK (kind <> 'commit' OR (length(uri) BETWEEN 7 AND 64 AND uri NOT GLOB '*[^0-9a-f]*'))
) STRICT;

CREATE INDEX artifacts_by_attempt ON artifacts (attempt_id, kind, created_at);

-- ── Inerte hasta el corte ──

CREATE TRIGGER worktrees_inert_insert BEFORE INSERT ON worktrees
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'worktrees está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER worktrees_inert_update BEFORE UPDATE ON worktrees
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'worktrees está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER artifacts_inert_insert BEFORE INSERT ON artifacts
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'artifacts está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

-- ── Sin borrado; el Artifact no cambia ──

CREATE TRIGGER worktrees_no_delete BEFORE DELETE ON worktrees
BEGIN
  SELECT RAISE(ABORT, 'worktrees conserva la historia: no se borra');
END;

CREATE TRIGGER artifacts_no_delete BEFORE DELETE ON artifacts
BEGIN
  SELECT RAISE(ABORT, 'artifacts conserva la historia: no se borra');
END;

CREATE TRIGGER artifacts_immutable BEFORE UPDATE ON artifacts
BEGIN
  SELECT RAISE(ABORT, 'artifacts: un Artifact no se modifica');
END;

-- ── Worktree ──

-- Un Worktree del Core nace activo, lo registra un Attempt activo de su Task.
CREATE TRIGGER worktrees_core_create BEFORE INSERT ON worktrees
WHEN NEW.origin = 'core' AND (
  NEW.state IS NOT 'active'
  OR NOT EXISTS (
    SELECT 1 FROM attempts AS a
    WHERE a.id = NEW.attempt_id AND a.task_id = NEW.task_id AND a.status NOT IN ('done', 'failed', 'stopped', 'exited')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'worktrees: un Worktree del Core nace activo y lo registra un Attempt activo de su Task');
END;

-- La identidad, la procedencia y la ubicación no cambian; la ruta solo se pierde al quitarlo.
CREATE TRIGGER worktrees_identity_immutable BEFORE UPDATE ON worktrees
WHEN NEW.id IS NOT OLD.id OR NEW.task_id IS NOT OLD.task_id OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.provenance IS NOT OLD.provenance OR NEW.machine IS NOT OLD.machine OR NEW.repo IS NOT OLD.repo
  OR NEW.branch IS NOT OLD.branch OR NEW.base_branch IS NOT OLD.base_branch OR NEW.base_commit IS NOT OLD.base_commit
  OR NEW.env_plan IS NOT OLD.env_plan OR NEW.origin IS NOT OLD.origin OR NEW.created_at IS NOT OLD.created_at
  OR (NEW.path IS NOT OLD.path AND NEW.path IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'worktrees: la identidad, la procedencia y la ubicación no cambian (la ruta solo se pierde al quitarlo)');
END;

CREATE TRIGGER worktrees_removed_is_final BEFORE UPDATE ON worktrees
WHEN OLD.state = 'removed'
BEGIN
  SELECT RAISE(ABORT, 'worktrees: un Worktree quitado no se modifica');
END;

-- Ciclo de vida cerrado (los pares de `WorktreeStep` en store/worktrees.rs):
--   lost  active -> missing     found  missing -> active     remove  active | missing -> removed
CREATE TRIGGER worktrees_lifecycle BEFORE UPDATE OF state ON worktrees
WHEN NEW.state IS NOT OLD.state AND NOT EXISTS (
  SELECT 1 FROM (VALUES ('active', 'missing'), ('missing', 'active'), ('active', 'removed'), ('missing', 'removed'))
  WHERE column1 = OLD.state AND column2 = NEW.state
)
BEGIN
  SELECT RAISE(ABORT, 'worktrees: transición de ciclo de vida no permitida');
END;

-- El vínculo blando de la 008 (`attempts.worktree_id`, D21) apunta a un Worktree activo de su Task. Solo al fijarlo
-- (UPDATE): el corte inserta Attempts y Worktrees en la misma transacción.
CREATE TRIGGER attempts_worktree_exists BEFORE UPDATE OF worktree_id ON attempts
WHEN NEW.worktree_id IS NOT NULL AND NEW.worktree_id IS NOT OLD.worktree_id AND NOT EXISTS (
  SELECT 1 FROM worktrees AS w WHERE w.id = NEW.worktree_id AND w.task_id = NEW.task_id AND w.state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'attempts: el Worktree no existe, es de otra Task o no está activo');
END;

-- ── Artifact ──

-- Un Artifact del Core es de un Attempt que ya arrancó (activo o terminado).
CREATE TRIGGER artifacts_core_create BEFORE INSERT ON artifacts
WHEN NEW.origin = 'core' AND NOT EXISTS (
  SELECT 1 FROM attempts WHERE id = NEW.attempt_id AND status NOT IN ('pending_approval', 'starting')
)
BEGIN
  SELECT RAISE(ABORT, 'artifacts: un Artifact del Core es de un Attempt que ya arrancó');
END;
