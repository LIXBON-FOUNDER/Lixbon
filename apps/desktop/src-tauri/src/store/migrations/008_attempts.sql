-- 008_attempts: Attempt como ejecución concreta de una Task (LXO-114, épica F3). Contrato: docs/core/ATTEMPTS.md.
--
-- UNA responsabilidad: la identidad y el ciclo de vida de UNA ejecución de una Task (qué proveedor y modelo se
-- eligieron, en qué estado está, cuándo empezó y terminó y su resultado mínimo). Nada del runtime: ni PID, ni PTY,
-- ni argv, ni política, ni canal de entrega, ni rutas. Eso llega con las migraciones de los slices que lo usan
-- (columnas nuevas con `ALTER TABLE ... ADD COLUMN`; los triggers de aquí ya cubren cualquier UPDATE).
--
-- Se aplica DESPUÉS de la 007 y de la valla, igual que 003..007.
--
-- INERTE HASTA EL CORTE (docs/core/CORTE_TASK_ATTEMPT.md §9, D15): como `runs` y `tasks`, los triggers `*_inert_*`
-- abortan INSERT y UPDATE mientras no exista `meta.agentic_model`. El corte escribe la clave ANTES de copiar.
--
-- Decisiones:
--   * IDENTIDAD HISTÓRICA: `id = task_id || '-a' || n`, determinista (ADR D2). Nunca cambian id, task_id, n, la
--     selección (provider, model, effort, role, profile), external, origin ni created_at. Un reintento NO toca el
--     Attempt anterior: inserta `n + 1`.
--   * CICLO DE VIDA CERRADO: el trigger `attempts_lifecycle` solo admite los pares (de, a) de la tabla de abajo, que
--     es la misma de `AttemptStep` en Rust (una prueba compara las 81 combinaciones). Un Attempt FINAL (`done`,
--     `failed`, `stopped`, `exited`) no admite ningún UPDATE: no vuelve a `running`.
--   * LAS TRANSICIONES DE ESPERA (`waiting`, `awaiting_terminal_approval`) y `exited` EXISTEN como estados (el corte
--     importa filas del legado en esos estados) pero entrar en ellos es del runtime (F4): su slice ampliará el
--     trigger. Desde ellos sí se puede terminar (`done`, `failed`, `stopped`).
--   * A LO SUMO UN ATTEMPT ACTIVO POR TASK (índice único parcial). Reintentar es posible cuando el anterior es final.
--     Ejecuciones en paralelo (race/compare) serán una decisión de su propio slice, que retirará ese índice.
--   * SIN BORRADO: `attempts` conserva la historia; ni DELETE ni cascadas. La Task con Attempts no se borra
--     (FK sin `ON DELETE`) y, mientras tenga uno activo, tampoco se descarta (trigger al final).
--   * REFERENCIAS BLANDAS a Worktree y ProviderSession (`worktree_id`, `provider_session_id`): esas tablas llegan en
--     sus slices, que validarán la existencia con triggers y escribirán el vínculo junto a su propio hecho. Aquí se
--     fijan una sola vez: lo ya vinculado no cambia.
--   * LAS FILAS DEL CORE nacen `pending_approval` o `starting`, con `n` consecutivo y solo en una Task abierta de
--     un Run abierto. Las comprobaciones de forma de ciclo de vida (marcas de tiempo coherentes con el estado) solo se
--     imponen a las filas del Core: el legado se importa tal cual (no registra el fin de un intento).
--   * `summary` es el resultado mínimo (como mucho 2000 caracteres); el informe completo será un Artifact.
--   * Marcas de tiempo en ms epoch, FIJADAS por quien llama (la hora del evento que acompaña la escritura).

CREATE TABLE attempts (
  id                  TEXT    PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 80),
  task_id             TEXT    NOT NULL REFERENCES tasks (id),
  n                   INTEGER NOT NULL CHECK (n >= 1),
  status              TEXT    NOT NULL CHECK (status IN ('pending_approval', 'starting', 'running', 'waiting',
                                'awaiting_terminal_approval', 'done', 'failed', 'stopped', 'exited')),
  external            INTEGER NOT NULL DEFAULT 0 CHECK (external IN (0, 1)),
  provider            TEXT    NOT NULL CHECK (length(trim(provider)) > 0),
  model               TEXT    CHECK (model IS NULL OR length(trim(model)) > 0),
  effort              TEXT    CHECK (effort IS NULL OR length(trim(effort)) > 0),
  role                TEXT    CHECK (role IS NULL OR length(trim(role)) > 0),
  profile             TEXT    CHECK (profile IS NULL OR length(trim(profile)) > 0),
  worktree_id         TEXT    CHECK (worktree_id IS NULL OR length(worktree_id) > 0),
  provider_session_id TEXT    CHECK (provider_session_id IS NULL OR length(provider_session_id) > 0),
  summary             TEXT    NOT NULL DEFAULT '',
  failure_reason      TEXT    CHECK (failure_reason IS NULL OR (status = 'failed' AND length(failure_reason) BETWEEN 1 AND 64)),
  created_at          INTEGER NOT NULL,
  started_at          INTEGER,
  ended_at            INTEGER,
  updated_at          INTEGER NOT NULL,
  origin              TEXT    NOT NULL CHECK (origin IN ('legacy', 'core')),
  UNIQUE (task_id, n),
  CHECK (id = task_id || '-a' || n),
  CHECK (origin = 'legacy' OR (status IN ('done', 'failed', 'stopped', 'exited')) = (ended_at IS NOT NULL)),
  CHECK (origin = 'legacy' OR status NOT IN ('running', 'waiting', 'awaiting_terminal_approval', 'done') OR started_at IS NOT NULL),
  CHECK (origin = 'legacy' OR status NOT IN ('pending_approval', 'starting') OR started_at IS NULL),
  CHECK (origin = 'legacy' OR (
    updated_at >= created_at
    AND (started_at IS NULL OR started_at >= created_at)
    AND (ended_at IS NULL OR ended_at >= coalesce(started_at, created_at))
  )),
  CHECK (origin = 'legacy' OR length(summary) <= 2000)
) STRICT;

CREATE INDEX attempts_by_status ON attempts (status, task_id);

-- A lo sumo un Attempt activo (no final) por Task.
CREATE UNIQUE INDEX attempts_one_active ON attempts (task_id)
  WHERE status NOT IN ('done', 'failed', 'stopped', 'exited');

CREATE TRIGGER attempts_inert_insert BEFORE INSERT ON attempts
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'attempts está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER attempts_inert_update BEFORE UPDATE ON attempts
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'attempts está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER attempts_no_delete BEFORE DELETE ON attempts
BEGIN
  SELECT RAISE(ABORT, 'attempts conserva la historia: no se borra');
END;

-- Una fila del Core nace al principio del ciclo de vida, con el siguiente número de su Task, en una Task abierta
-- de un Run abierto.
CREATE TRIGGER attempts_core_create BEFORE INSERT ON attempts
WHEN NEW.origin = 'core' AND (
  NEW.status NOT IN ('pending_approval', 'starting')
  OR NEW.n IS NOT (SELECT coalesce(max(n), 0) + 1 FROM attempts WHERE task_id = NEW.task_id)
  OR NOT EXISTS (
    SELECT 1 FROM tasks AS t JOIN runs AS r ON r.id = t.run_id
    WHERE t.id = NEW.task_id AND t.intent = 'open' AND r.closed = 0
  )
)
BEGIN
  SELECT RAISE(ABORT, 'attempts: un Attempt del Core nace pendiente o arrancando, con el n siguiente, en una Task abierta de un Run abierto');
END;

-- Un Attempt final es historia: no admite ningún cambio.
CREATE TRIGGER attempts_final_is_final BEFORE UPDATE ON attempts
WHEN OLD.status IN ('done', 'failed', 'stopped', 'exited')
BEGIN
  SELECT RAISE(ABORT, 'attempts: un Attempt final no se modifica');
END;

-- La identidad no cambia; el vínculo con Worktree y ProviderSession se fija una sola vez.
CREATE TRIGGER attempts_identity_immutable BEFORE UPDATE ON attempts
WHEN NEW.id IS NOT OLD.id OR NEW.task_id IS NOT OLD.task_id OR NEW.n IS NOT OLD.n
  OR NEW.provider IS NOT OLD.provider OR NEW.model IS NOT OLD.model OR NEW.effort IS NOT OLD.effort
  OR NEW.role IS NOT OLD.role OR NEW.profile IS NOT OLD.profile OR NEW.external IS NOT OLD.external
  OR NEW.origin IS NOT OLD.origin OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.worktree_id IS NOT NULL AND NEW.worktree_id IS NOT OLD.worktree_id)
  OR (OLD.provider_session_id IS NOT NULL AND NEW.provider_session_id IS NOT OLD.provider_session_id)
BEGIN
  SELECT RAISE(ABORT, 'attempts: la identidad, la selección y el origen no cambian; el vínculo se fija una sola vez');
END;

-- Ciclo de vida cerrado. Los pares son los de `AttemptStep` (store/attempts.rs):
--   approve  pending_approval -> starting
--   start    starting -> running
--   finish   running | waiting | awaiting_terminal_approval -> done
--   fail     starting | running | waiting | awaiting_terminal_approval -> failed
--   cancel   pending_approval | starting | running | waiting | awaiting_terminal_approval -> stopped
CREATE TRIGGER attempts_lifecycle BEFORE UPDATE OF status ON attempts
WHEN NEW.status IS NOT OLD.status AND NOT EXISTS (
  SELECT 1 FROM (VALUES
    ('pending_approval', 'starting'),
    ('starting', 'running'),
    ('running', 'done'), ('waiting', 'done'), ('awaiting_terminal_approval', 'done'),
    ('starting', 'failed'), ('running', 'failed'), ('waiting', 'failed'), ('awaiting_terminal_approval', 'failed'),
    ('pending_approval', 'stopped'), ('starting', 'stopped'), ('running', 'stopped'), ('waiting', 'stopped'),
    ('awaiting_terminal_approval', 'stopped')
  ) WHERE column1 = OLD.status AND column2 = NEW.status
)
BEGIN
  SELECT RAISE(ABORT, 'attempts: transición de ciclo de vida no permitida');
END;

-- Una Task con un Attempt activo no se descarta: se cancela antes (sin cascada implícita).
CREATE TRIGGER tasks_discard_needs_no_active_attempt BEFORE UPDATE OF intent ON tasks
WHEN NEW.intent = 'discarded' AND OLD.intent IS NOT 'discarded' AND EXISTS (
  SELECT 1 FROM attempts WHERE task_id = NEW.id AND status NOT IN ('done', 'failed', 'stopped', 'exited')
)
BEGIN
  SELECT RAISE(ABORT, 'tasks: una Task con un Attempt activo no se descarta');
END;
