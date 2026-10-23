-- 012_attempt_runtime: lo que el runtime legacy hace y el esquema F3 aún no admitía (LXO-231, épica F3). Contrato:
-- docs/core/ATTEMPTS.md § Runtime (LXO-231).
--
-- Se aplica DESPUÉS de la 011 y de la valla. INERTE HASTA EL CORTE, como 007..011.
--
--   * COLUMNAS DE RUNTIME del Attempt (las que el SQL del corte añadía): encargo, cwd, política, entrega, modelo efectivo,
--     plazo de aprobación, archivos e integración. Las actualiza el runtime mientras el Attempt corre, dentro de la
--     transacción de su hecho.
--   * FASES (`attempt_phases`) y BLOQUEOS DE ENTORNO (`env_blocks`), que también salen del SQL del corte.
--   * CICLO DE VIDA AMPLIADO (ADR D20): esperas (`waiting`, `awaiting_terminal_approval`), volver a `running`, terminar
--     desde `starting` (un `done` antes del primer comando) y `exited` desde cualquier estado activo. La tabla es la de
--     `AttemptStep` (store/attempts.rs); una prueba compara las 81 combinaciones.
--   * UN FINAL SIGUE SIENDO FINAL, con una sola excepción: marcar integrado (`integrated` 0 -> 1) un Attempt `done`.
--     La integración llega después de terminar y es un hecho propio (`attempt.integrated`).
--   * Se sustituyen dos triggers de la 008 (`attempts_lifecycle`, `attempts_final_is_final`): una migración publicada no
--     se edita, se reemplaza su efecto en otra hacia adelante.

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

CREATE TABLE env_blocks (
  scope TEXT NOT NULL,
  cause TEXT NOT NULL CHECK (cause IN ('cli_missing', 'cli_flags_unsupported', 'windows_sandbox_elevated')),
  PRIMARY KEY (scope, cause)
) STRICT;

-- ── Inerte hasta el corte ──

CREATE TRIGGER attempt_phases_inert_insert BEFORE INSERT ON attempt_phases
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'attempt_phases está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER env_blocks_inert_insert BEFORE INSERT ON env_blocks
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'env_blocks está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER env_blocks_inert_delete BEFORE DELETE ON env_blocks
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'env_blocks está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

-- Una fase es historia: se añade, no se cambia ni se borra.
CREATE TRIGGER attempt_phases_immutable BEFORE UPDATE ON attempt_phases
BEGIN
  SELECT RAISE(ABORT, 'attempt_phases: una fase es historia: no se modifica');
END;

CREATE TRIGGER attempt_phases_no_delete BEFORE DELETE ON attempt_phases
BEGIN
  SELECT RAISE(ABORT, 'attempt_phases: una fase es historia: no se borra');
END;

-- ── Ciclo de vida ampliado ──

DROP TRIGGER attempts_lifecycle;

-- Los pares son los de `AttemptStep` (store/attempts.rs):
--   approve        pending_approval -> starting
--   start          starting -> running
--   wait           starting | running -> waiting
--   await_terminal starting | running | waiting -> awaiting_terminal_approval
--   resume         waiting | awaiting_terminal_approval -> running
--   finish         starting | running | waiting | awaiting_terminal_approval -> done
--   fail           starting | running | waiting | awaiting_terminal_approval -> failed
--   cancel         pending_approval | starting | running | waiting | awaiting_terminal_approval -> stopped
--   exit           starting | running | waiting | awaiting_terminal_approval -> exited
CREATE TRIGGER attempts_lifecycle BEFORE UPDATE OF status ON attempts
WHEN NEW.status IS NOT OLD.status AND NOT EXISTS (
  SELECT 1 FROM (VALUES
    ('pending_approval', 'starting'),
    ('starting', 'running'), ('waiting', 'running'), ('awaiting_terminal_approval', 'running'),
    ('starting', 'waiting'), ('running', 'waiting'),
    ('starting', 'awaiting_terminal_approval'), ('running', 'awaiting_terminal_approval'), ('waiting', 'awaiting_terminal_approval'),
    ('starting', 'done'), ('running', 'done'), ('waiting', 'done'), ('awaiting_terminal_approval', 'done'),
    ('starting', 'failed'), ('running', 'failed'), ('waiting', 'failed'), ('awaiting_terminal_approval', 'failed'),
    ('pending_approval', 'stopped'), ('starting', 'stopped'), ('running', 'stopped'), ('waiting', 'stopped'),
    ('awaiting_terminal_approval', 'stopped'),
    ('starting', 'exited'), ('running', 'exited'), ('waiting', 'exited'), ('awaiting_terminal_approval', 'exited')
  ) WHERE column1 = OLD.status AND column2 = NEW.status
)
BEGIN
  SELECT RAISE(ABORT, 'attempts: transición de ciclo de vida no permitida');
END;

DROP TRIGGER attempts_final_is_final;

-- Un Attempt final es historia. Única excepción: marcar integrado uno `done` (y su `updated_at`); nada más cambia.
CREATE TRIGGER attempts_final_is_final BEFORE UPDATE ON attempts
WHEN OLD.status IN ('done', 'failed', 'stopped', 'exited') AND NOT (
  OLD.status = 'done' AND OLD.integrated = 0 AND NEW.integrated = 1 AND NEW.status = 'done'
  AND NEW.summary IS OLD.summary AND NEW.failure_reason IS OLD.failure_reason AND NEW.started_at IS OLD.started_at
  AND NEW.ended_at IS OLD.ended_at AND NEW.worktree_id IS OLD.worktree_id AND NEW.provider_session_id IS OLD.provider_session_id
  AND NEW.instruction IS OLD.instruction AND NEW.cwd IS OLD.cwd AND NEW.checkout_branch IS OLD.checkout_branch
  AND NEW.policy IS OLD.policy AND NEW.ack_unverified IS OLD.ack_unverified AND NEW.requested_argv IS OLD.requested_argv
  AND NEW.plan_mode IS OLD.plan_mode AND NEW.stream_json IS OLD.stream_json AND NEW.report_nonce IS OLD.report_nonce
  AND NEW.delivered IS OLD.delivered AND NEW.delivery_channel IS OLD.delivery_channel
  AND NEW.model_requested IS OLD.model_requested AND NEW.model_effective IS OLD.model_effective
  AND NEW.model_source IS OLD.model_source AND NEW.model_mismatch IS OLD.model_mismatch
  AND NEW.model_mismatch_reason IS OLD.model_mismatch_reason AND NEW.approval_deadline IS OLD.approval_deadline
  AND NEW.files IS OLD.files
)
BEGIN
  SELECT RAISE(ABORT, 'attempts: un Attempt final no se modifica (solo se marca integrado uno done)');
END;

-- Una fase nueva es de un Attempt que no ha terminado. Solo el corte copia fases de Attempts legacy ya terminados (antes
-- de escribir `meta.f3_cut_legacy_rev`, que es su último paso).
CREATE TRIGGER attempt_phases_of_active BEFORE INSERT ON attempt_phases
WHEN EXISTS (SELECT 1 FROM attempts WHERE id = NEW.attempt_id AND status IN ('done', 'failed', 'stopped', 'exited'))
  AND (EXISTS (SELECT 1 FROM attempts WHERE id = NEW.attempt_id AND origin = 'core') OR EXISTS (SELECT 1 FROM meta WHERE key = 'f3_cut_legacy_rev'))
BEGIN
  SELECT RAISE(ABORT, 'attempt_phases: un Attempt final no admite fases nuevas');
END;
