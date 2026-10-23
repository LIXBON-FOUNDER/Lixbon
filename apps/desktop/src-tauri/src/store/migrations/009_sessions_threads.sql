-- 009_sessions_threads: ProviderSession y Thread explícitos (LXO-115, épica F3). Contrato: docs/core/SESIONES_THREADS.md.
--
-- UNA responsabilidad: la sesión durable del proveedor y la conversación de coordinación de una Task, separadas del
-- Attempt. Nada del adapter (F4): ni transcript, ni rutas a archivos internos del proveedor, ni credenciales.
--
-- Se aplica DESPUÉS de la 008 y de la valla, igual que 003..008.
--
-- INERTE HASTA EL CORTE (docs/core/CORTE_TASK_ATTEMPT.md §9, D15): los triggers `*_inert_*` abortan INSERT y UPDATE
-- mientras no exista `meta.agentic_model`.
--
-- Decisiones:
--   * UNA SESIÓN SOLO EXISTE POR UN VÍNCULO DECLARADO (ADR invariante 4): `binding` es `stream_json` o `session_id`;
--     no hay valor para «misma carpeta y hora» (`cwd_time`). Una sesión puede nacer sin referencia (el adapter aún no
--     la entregó): `external_ref` y `binding` van juntos y se fijan UNA vez.
--   * `external_ref` ES OPACO: el Core no lo interpreta; único por proveedor.
--   * DUEÑA = la Task (ADR §5); la abre un Attempt (`opened_by_attempt_id`, id `ps-<attempt>`). Un seguimiento la
--     reanuda (D7) enlazando su propio Attempt (`attempts.provider_session_id`), del mismo proveedor y la misma Task.
--   * CICLO DE VIDA: `open` (un Attempt la usa) · `idle` (ninguno; se puede reanudar) · `closed` (final). `idle` solo
--     con `resumable = 1`: un Attempt puede carecer de sesión resumible.
--   * THREAD = conversación de coordinación de UNA Task (`th-<task>`), sobrevive a sus Attempts. Su estado no dice
--     nada del Attempt. `summary` es metadato corto para un resumen futuro; el almacén rechaza secretos.
--   * `thread_messages` llega aquí con su forma (la llena el corte); escribir mensajes nuevos es del runtime.
--   * SIN BORRADO: ni DELETE ni cascadas.

CREATE TABLE provider_sessions (
  id                   TEXT    PRIMARY KEY NOT NULL CHECK (id = 'ps-' || opened_by_attempt_id),
  task_id              TEXT    NOT NULL REFERENCES tasks (id),
  opened_by_attempt_id TEXT    NOT NULL UNIQUE REFERENCES attempts (id) DEFERRABLE INITIALLY DEFERRED,
  provider             TEXT    NOT NULL CHECK (length(trim(provider)) > 0),
  external_ref         TEXT    CHECK (external_ref IS NULL OR length(external_ref) BETWEEN 1 AND 1024),
  binding              TEXT    CHECK (binding IS NULL OR binding IN ('stream_json', 'session_id')),
  resumable            INTEGER NOT NULL CHECK (resumable IN (0, 1)),
  status               TEXT    NOT NULL CHECK (status IN ('open', 'idle', 'closed')),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  closed_at            INTEGER,
  origin               TEXT    NOT NULL CHECK (origin IN ('legacy', 'core')),
  CHECK ((external_ref IS NULL) = (binding IS NULL)),
  CHECK (status <> 'idle' OR resumable = 1),
  CHECK (origin = 'legacy' OR (status = 'closed') = (closed_at IS NOT NULL)),
  CHECK (origin = 'legacy' OR (updated_at >= created_at AND (closed_at IS NULL OR closed_at >= created_at)))
) STRICT;

CREATE UNIQUE INDEX provider_sessions_external_ref ON provider_sessions (provider, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX provider_sessions_by_task ON provider_sessions (task_id, status);
CREATE INDEX attempts_by_provider_session ON attempts (provider_session_id, n) WHERE provider_session_id IS NOT NULL;

CREATE TABLE threads (
  id         TEXT    PRIMARY KEY NOT NULL CHECK (id = 'th-' || task_id),
  task_id    TEXT    NOT NULL UNIQUE REFERENCES tasks (id),
  run_id     TEXT    NOT NULL REFERENCES runs (id),
  summary    TEXT    CHECK (summary IS NULL OR length(summary) BETWEEN 1 AND 2000),
  created_at INTEGER,
  updated_at INTEGER,
  origin     TEXT    NOT NULL CHECK (origin IN ('legacy', 'core')),
  CHECK (origin = 'legacy' OR (created_at IS NOT NULL AND updated_at >= created_at))
) STRICT;

CREATE TABLE thread_messages (
  id              INTEGER PRIMARY KEY,        -- id legacy conservado (comparte contador con tN / rN)
  thread_id       TEXT    NOT NULL REFERENCES threads (id),
  from_task_id    TEXT    NOT NULL REFERENCES tasks (id),
  to_task_id      TEXT    NOT NULL REFERENCES tasks (id),
  from_attempt_id TEXT    REFERENCES attempts (id),   -- NULL en legacy: no se atribuye (ADR D6)
  kind            TEXT    NOT NULL CHECK (kind IN ('phase', 'done', 'question', 'reply', 'note', 'exited')),
  body            TEXT    NOT NULL,
  reply_to        INTEGER REFERENCES thread_messages (id) DEFERRABLE INITIALLY DEFERRED,
  read            INTEGER NOT NULL CHECK (read IN (0, 1)),
  at              INTEGER NOT NULL
) STRICT;

CREATE INDEX thread_messages_by_thread ON thread_messages (thread_id, id);
CREATE INDEX thread_messages_by_attempt ON thread_messages (from_attempt_id, id) WHERE from_attempt_id IS NOT NULL;

-- ── Inerte hasta el corte ──

CREATE TRIGGER provider_sessions_inert_insert BEFORE INSERT ON provider_sessions
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'provider_sessions está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER provider_sessions_inert_update BEFORE UPDATE ON provider_sessions
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'provider_sessions está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER threads_inert_insert BEFORE INSERT ON threads
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'threads está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER threads_inert_update BEFORE UPDATE ON threads
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'threads está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER thread_messages_inert_insert BEFORE INSERT ON thread_messages
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'thread_messages está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER thread_messages_inert_update BEFORE UPDATE ON thread_messages
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'thread_messages está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

-- ── Sin borrado ──

CREATE TRIGGER provider_sessions_no_delete BEFORE DELETE ON provider_sessions
BEGIN
  SELECT RAISE(ABORT, 'provider_sessions conserva la historia: no se borra');
END;

CREATE TRIGGER threads_no_delete BEFORE DELETE ON threads
BEGIN
  SELECT RAISE(ABORT, 'threads conserva la historia: no se borra');
END;

CREATE TRIGGER thread_messages_no_delete BEFORE DELETE ON thread_messages
BEGIN
  SELECT RAISE(ABORT, 'thread_messages conserva la historia: no se borra');
END;

-- ── ProviderSession ──

-- Una sesión del Core nace `open`, la abre un Attempt activo de su Task y es del proveedor de ese Attempt.
CREATE TRIGGER provider_sessions_core_create BEFORE INSERT ON provider_sessions
WHEN NEW.origin = 'core' AND (
  NEW.status IS NOT 'open'
  OR NOT EXISTS (
    SELECT 1 FROM attempts AS a
    WHERE a.id = NEW.opened_by_attempt_id AND a.task_id = NEW.task_id AND a.provider = NEW.provider
      AND a.status NOT IN ('done', 'failed', 'stopped', 'exited')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'provider_sessions: una sesión del Core nace abierta, por un Attempt activo de su Task y de su mismo proveedor');
END;

-- La identidad no cambia; la referencia del proveedor y su vínculo se fijan una sola vez.
CREATE TRIGGER provider_sessions_identity_immutable BEFORE UPDATE ON provider_sessions
WHEN NEW.id IS NOT OLD.id OR NEW.task_id IS NOT OLD.task_id OR NEW.opened_by_attempt_id IS NOT OLD.opened_by_attempt_id
  OR NEW.provider IS NOT OLD.provider OR NEW.resumable IS NOT OLD.resumable OR NEW.origin IS NOT OLD.origin
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.external_ref IS NOT NULL AND NEW.external_ref IS NOT OLD.external_ref)
  OR (OLD.binding IS NOT NULL AND NEW.binding IS NOT OLD.binding)
BEGIN
  SELECT RAISE(ABORT, 'provider_sessions: la identidad no cambia; la referencia del proveedor se fija una sola vez');
END;

CREATE TRIGGER provider_sessions_closed_is_final BEFORE UPDATE ON provider_sessions
WHEN OLD.status = 'closed'
BEGIN
  SELECT RAISE(ABORT, 'provider_sessions: una sesión cerrada no se modifica');
END;

-- Ciclo de vida cerrado (los pares de `SessionStep` en store/sessions.rs):
--   detach  open -> idle      resume  idle -> open      close  open | idle -> closed
CREATE TRIGGER provider_sessions_lifecycle BEFORE UPDATE OF status ON provider_sessions
WHEN NEW.status IS NOT OLD.status AND NOT EXISTS (
  SELECT 1 FROM (VALUES ('open', 'idle'), ('idle', 'open'), ('open', 'closed'), ('idle', 'closed'))
  WHERE column1 = OLD.status AND column2 = NEW.status
)
BEGIN
  SELECT RAISE(ABORT, 'provider_sessions: transición de ciclo de vida no permitida');
END;

-- El vínculo blando de la 008 (`attempts.provider_session_id`, D21) apunta a una sesión de su Task y de su proveedor
-- que no está cerrada. Solo al fijarlo (UPDATE): el corte inserta Attempts y sesiones en la misma transacción.
CREATE TRIGGER attempts_provider_session_exists BEFORE UPDATE OF provider_session_id ON attempts
WHEN NEW.provider_session_id IS NOT NULL AND NEW.provider_session_id IS NOT OLD.provider_session_id AND NOT EXISTS (
  SELECT 1 FROM provider_sessions AS s
  WHERE s.id = NEW.provider_session_id AND s.task_id = NEW.task_id AND s.provider = NEW.provider AND s.status <> 'closed'
)
BEGIN
  SELECT RAISE(ABORT, 'attempts: la sesión del proveedor no existe, es de otra Task u otro proveedor, o está cerrada');
END;

-- ── Thread ──

-- Un Thread del Core es el de una Task abierta, en el Run de esa Task.
CREATE TRIGGER threads_core_create BEFORE INSERT ON threads
WHEN NEW.origin = 'core' AND NOT EXISTS (
  SELECT 1 FROM tasks AS t WHERE t.id = NEW.task_id AND t.run_id = NEW.run_id AND t.intent = 'open'
)
BEGIN
  SELECT RAISE(ABORT, 'threads: un Thread del Core es el de una Task abierta, en su mismo Run');
END;

CREATE TRIGGER threads_identity_immutable BEFORE UPDATE ON threads
WHEN NEW.id IS NOT OLD.id OR NEW.task_id IS NOT OLD.task_id OR NEW.run_id IS NOT OLD.run_id
  OR NEW.origin IS NOT OLD.origin OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'threads: la identidad no cambia');
END;

-- Un mensaje es historia: solo cambia su marca de leído.
CREATE TRIGGER thread_messages_immutable BEFORE UPDATE ON thread_messages
WHEN NEW.id IS NOT OLD.id OR NEW.thread_id IS NOT OLD.thread_id OR NEW.from_task_id IS NOT OLD.from_task_id
  OR NEW.to_task_id IS NOT OLD.to_task_id OR NEW.from_attempt_id IS NOT OLD.from_attempt_id OR NEW.kind IS NOT OLD.kind
  OR NEW.body IS NOT OLD.body OR NEW.reply_to IS NOT OLD.reply_to OR NEW.at IS NOT OLD.at
BEGIN
  SELECT RAISE(ABORT, 'thread_messages: un mensaje no se reescribe (solo se marca como leído)');
END;

-- Un mensaje atribuido a un Attempt es de un Attempt de la Task emisora.
CREATE TRIGGER thread_messages_attempt_of_sender BEFORE INSERT ON thread_messages
WHEN NEW.from_attempt_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM attempts WHERE id = NEW.from_attempt_id AND task_id = NEW.from_task_id
)
BEGIN
  SELECT RAISE(ABORT, 'thread_messages: el Attempt que lo envía no es de la Task emisora');
END;
