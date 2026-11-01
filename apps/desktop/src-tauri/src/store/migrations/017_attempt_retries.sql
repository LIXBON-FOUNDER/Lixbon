-- 017 · Reintento de un Attempt: de dónde sale el Attempt nuevo (LXO-142). Contrato: docs/core/REINTENTO.md.
--
-- Un reintento NUNCA reabre el Attempt anterior (008, invariante 1 y 3): crea otro, limpio, con el `n` siguiente. Esta
-- tabla guarda su procedencia `from_attempt_id -> attempt_id` y qué parámetros se cambiaron a propósito (`overrides`, una
-- lista cerrada de nombres); el resto se heredó del Attempt anterior. Lo que corrió de verdad (proveedor, modelo, esfuerzo,
-- perfil) sigue estando en la fila del Attempt.
--
-- `request_id` es la clave de idempotencia del comando: repetirlo en la misma Task no crea otro Attempt. Comparte espacio
-- con `attempt_continuations.request_id` (016): una clave identifica UNA petición de la Task, sea reintento o reanudación.
--
-- Solo se reintenta lo que no llegó a buen término (`failed`, `stopped`, `exited`) y solo desde el último Attempt de la Task:
-- reintentar uno viejo mientras hay otro posterior sería rehacer lo ya rehecho.
--
-- INERTE HASTA EL CORTE, como 007..016 (docs/core/CORTE_TASK_ATTEMPT.md §9, D15). Va después de la barrera (014).

CREATE TABLE attempt_retries (
  attempt_id      TEXT    PRIMARY KEY REFERENCES attempts (id),
  task_id         TEXT    NOT NULL REFERENCES tasks (id),
  request_id      TEXT    NOT NULL CHECK (length(request_id) BETWEEN 1 AND 64 AND request_id NOT GLOB '*[^A-Za-z0-9_.-]*'),
  from_attempt_id TEXT    NOT NULL REFERENCES attempts (id),
  overrides       TEXT    NOT NULL CHECK (json_valid(overrides) AND json_type(overrides) = 'array'),
  created_at      INTEGER NOT NULL,
  UNIQUE (task_id, request_id),
  CHECK (attempt_id <> from_attempt_id)
) STRICT;

CREATE INDEX attempt_retries_by_source ON attempt_retries (from_attempt_id);

-- ── Inerte hasta el corte ──

CREATE TRIGGER attempt_retries_inert_insert BEFORE INSERT ON attempt_retries
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'attempt_retries está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER attempt_retries_inert_update BEFORE UPDATE ON attempt_retries
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'attempt_retries está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

-- ── Invariantes ──

-- La procedencia no se reescribe ni se borra.
CREATE TRIGGER attempt_retries_immutable BEFORE UPDATE ON attempt_retries
BEGIN
  SELECT RAISE(ABORT, 'attempt_retries es inmutable: la procedencia de un Attempt no se reescribe');
END;

CREATE TRIGGER attempt_retries_no_delete BEFORE DELETE ON attempt_retries
BEGIN
  SELECT RAISE(ABORT, 'attempt_retries no se borra');
END;

-- El Attempt y el anterior son de la Task; el anterior es el inmediatamente anterior (el último de la Task al nacer el
-- nuevo) y terminó mal. (Solo con el modelo agentic activo: antes del corte manda el trigger de inerte.)
CREATE TRIGGER attempt_retries_coherent BEFORE INSERT ON attempt_retries
WHEN EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'el Attempt que reintenta no es de la Task indicada')
  WHERE NOT EXISTS (SELECT 1 FROM attempts WHERE id = NEW.attempt_id AND task_id = NEW.task_id);
  SELECT RAISE(ABORT, 'el Attempt reintentado no es el inmediatamente anterior de la misma Task')
  WHERE NOT EXISTS (
    SELECT 1 FROM attempts f, attempts a
    WHERE f.id = NEW.from_attempt_id AND a.id = NEW.attempt_id AND f.task_id = NEW.task_id AND f.n = a.n - 1
  );
  SELECT RAISE(ABORT, 'solo se reintenta un Attempt que terminó mal (failed, stopped o exited)')
  WHERE EXISTS (SELECT 1 FROM attempts WHERE id = NEW.from_attempt_id AND status NOT IN ('failed', 'stopped', 'exited'));
END;

-- Una clave de idempotencia identifica UNA petición de la Task: no puede serlo de un reintento y de una reanudación a la vez.
CREATE TRIGGER attempt_retries_request_id_free BEFORE INSERT ON attempt_retries
WHEN EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'ese request_id ya identifica una continuidad de la Task')
  WHERE EXISTS (SELECT 1 FROM attempt_continuations WHERE task_id = NEW.task_id AND request_id = NEW.request_id);
END;

CREATE TRIGGER attempt_continuations_request_id_free BEFORE INSERT ON attempt_continuations
WHEN EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'ese request_id ya identifica un reintento de la Task')
  WHERE EXISTS (SELECT 1 FROM attempt_retries WHERE task_id = NEW.task_id AND request_id = NEW.request_id);
END;
