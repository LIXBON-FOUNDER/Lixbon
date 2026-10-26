-- 016 · Continuidad de un Attempt: cómo y desde dónde continúa el trabajo de una Task (LXO-134). Contrato:
-- docs/core/CONTINUIDAD.md.
--
-- Un Attempt que continúa a otro lo hace de UNA de dos formas, y la tabla guarda cuál y por qué:
--
--   * `native_resume`: reanuda la ProviderSession del Attempt anterior (mismo proveedor). Lleva `provider_session_id`.
--   * `context_package`: arranca limpio con un ContextPackage v1 (LXO-133), también entre proveedores. Lleva `package_id`
--     (el `sha256:` del paquete), nunca el contenido ni ninguna referencia del proveedor.
--
-- `request_id` es la clave de idempotencia del comando: repetirlo en la misma Task no crea otro Attempt. La fila es del
-- Core, nace en la misma transacción que el Attempt y su evento y no se modifica ni se borra.
--
-- INERTE HASTA EL CORTE, como 007..013 (docs/core/CORTE_TASK_ATTEMPT.md §9, D15).

CREATE TABLE attempt_continuations (
  attempt_id          TEXT    PRIMARY KEY REFERENCES attempts (id),
  task_id             TEXT    NOT NULL REFERENCES tasks (id),
  request_id          TEXT    NOT NULL CHECK (length(request_id) BETWEEN 1 AND 64 AND request_id NOT GLOB '*[^A-Za-z0-9_.-]*'),
  strategy            TEXT    NOT NULL CHECK (strategy IN ('native_resume', 'context_package')),
  reason              TEXT    NOT NULL CHECK (reason IN ('preferred', 'requested', 'provider_changed', 'resume_unsupported', 'session_unavailable', 'session_expired')),
  from_attempt_id     TEXT    NOT NULL REFERENCES attempts (id),
  provider_session_id TEXT    REFERENCES provider_sessions (id),
  package_id          TEXT    CHECK (package_id IS NULL OR (length(package_id) = 71 AND package_id GLOB 'sha256:*' AND substr(package_id, 8) NOT GLOB '*[^0-9a-f]*')),
  created_at          INTEGER NOT NULL,
  UNIQUE (task_id, request_id),
  CHECK (attempt_id <> from_attempt_id),
  -- La estrategia decide qué lleva: una sesión nativa o un paquete, nunca las dos ni ninguna.
  CHECK (
    (strategy = 'native_resume'    AND provider_session_id IS NOT NULL AND package_id IS NULL AND reason = 'preferred') OR
    (strategy = 'context_package'  AND provider_session_id IS NULL     AND package_id IS NOT NULL AND reason <> 'preferred')
  )
) STRICT;

CREATE INDEX attempt_continuations_by_source ON attempt_continuations (from_attempt_id);
CREATE INDEX attempt_continuations_by_session ON attempt_continuations (provider_session_id) WHERE provider_session_id IS NOT NULL;

-- ── Inerte hasta el corte ──

CREATE TRIGGER attempt_continuations_inert_insert BEFORE INSERT ON attempt_continuations
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'attempt_continuations está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER attempt_continuations_inert_update BEFORE UPDATE ON attempt_continuations
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'attempt_continuations está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

-- ── Invariantes ──

-- La continuidad no se reescribe ni se borra: es la procedencia del Attempt.
CREATE TRIGGER attempt_continuations_immutable BEFORE UPDATE ON attempt_continuations
BEGIN
  SELECT RAISE(ABORT, 'attempt_continuations es inmutable: la procedencia de un Attempt no se reescribe');
END;

CREATE TRIGGER attempt_continuations_no_delete BEFORE DELETE ON attempt_continuations
BEGIN
  SELECT RAISE(ABORT, 'attempt_continuations no se borra');
END;

-- El Attempt, el anterior y la Task son de la misma Task; el nuevo es posterior; el anterior ya terminó; la sesión
-- nativa es de esa Task y de ese proveedor.
-- (Solo con el modelo agentic activo: antes del corte manda el trigger de inerte, que es el mensaje que debe verse.)
CREATE TRIGGER attempt_continuations_coherent BEFORE INSERT ON attempt_continuations
WHEN EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'el Attempt que continúa no es de la Task indicada')
  WHERE NOT EXISTS (SELECT 1 FROM attempts WHERE id = NEW.attempt_id AND task_id = NEW.task_id);
  SELECT RAISE(ABORT, 'el Attempt anterior no es de la misma Task o no es anterior')
  WHERE NOT EXISTS (
    SELECT 1 FROM attempts f, attempts a
    WHERE f.id = NEW.from_attempt_id AND a.id = NEW.attempt_id AND f.task_id = NEW.task_id AND f.n < a.n
  );
  SELECT RAISE(ABORT, 'el Attempt anterior no ha terminado: no se continúa a la vez que corre')
  WHERE EXISTS (SELECT 1 FROM attempts WHERE id = NEW.from_attempt_id AND status NOT IN ('done', 'failed', 'stopped', 'exited'));
  SELECT RAISE(ABORT, 'la sesión no es de la Task y el proveedor del Attempt que continúa')
  WHERE NEW.provider_session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM provider_sessions s, attempts a
    WHERE s.id = NEW.provider_session_id AND a.id = NEW.attempt_id AND s.task_id = NEW.task_id AND s.provider = a.provider
  );
END;
