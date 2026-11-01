-- 018 · Pending Queue de un Attempt: instrucciones enviadas mientras está ocupado (LXO-143). Contrato:
-- docs/core/COLA.md.
--
-- Queue es una semántica del Core, no del proveedor: la instrucción se guarda en una cola DURABLE por Attempt y se entrega
-- como el SIGUIENTE turno cuando el adapter llega a un límite de turno soportado. Nunca se inyecta en el turno en curso
-- (eso sería Steer) ni se reordena.
--
--   * `queue_id` = `<attempt_id>-q<seq>`, determinista (como `attempts.id`). `seq` es consecutivo por Attempt (1, 2, 3…):
--     es el orden FIFO y la base lo impone.
--   * `request_id` es la clave de idempotencia del comando: repetirlo en el mismo Attempt no crea otro item
--     (`UNIQUE (attempt_id, request_id)`). `request_digest` (SHA-256 de cuerpo y adjuntos) distingue la repetición de una
--     clave reutilizada para otra cosa.
--   * Ciclo de vida CERRADO:  queued -> delivering -> delivered
--                             queued -> cancelled          (solo antes de la entrega)
--                             queued | delivering -> failed
--     `delivered`, `cancelled` y `failed` son finales: un item cancelado NUNCA se entrega (lo impide el trigger). Como mucho
--     UN item `delivering` por Attempt, y solo el primero de la cola puede pasar a `delivering` (FIFO en la base).
--   * `delivered` exige `confirmed_by`: el hecho que el ADAPTER informó (`adapter_event` o `adapter_result`). Escribir en
--     la entrada del proceso no es una confirmación y no tiene valor en el conjunto.
--   * El cuerpo es la instrucción de quien la escribió (no es un secreto del proveedor); no viaja en ningún Event. Los
--     adjuntos son ids de Artifacts de la misma Task, nunca rutas ni contenido.
--   * Sin borrado ni cascadas; identidad y contenido no cambian jamás.
--
-- INERTE HASTA EL CORTE, como 007..016 (docs/core/CORTE_TASK_ATTEMPT.md §9, D15).

CREATE TABLE attempt_queue (
  queue_id       TEXT    PRIMARY KEY NOT NULL CHECK (queue_id = attempt_id || '-q' || seq),
  attempt_id     TEXT    NOT NULL REFERENCES attempts (id),
  task_id        TEXT    NOT NULL REFERENCES tasks (id),
  seq            INTEGER NOT NULL CHECK (seq >= 1),
  request_id     TEXT    NOT NULL CHECK (length(request_id) BETWEEN 1 AND 64 AND request_id NOT GLOB '*[^A-Za-z0-9_.-]*'),
  request_digest TEXT    NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  author_kind    TEXT    NOT NULL CHECK (author_kind IN ('person', 'agent', 'system')),
  author_id      TEXT    CHECK (author_id IS NULL OR length(author_id) BETWEEN 1 AND 200),
  client_id      TEXT    CHECK (client_id IS NULL OR length(client_id) BETWEEN 1 AND 200),
  body           TEXT    NOT NULL CHECK (length(trim(body)) > 0 AND length(body) <= 20000),
  attachments    TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(attachments) AND json_type(attachments) = 'array' AND json_array_length(attachments) <= 8),
  status         TEXT    NOT NULL CHECK (status IN ('queued', 'delivering', 'delivered', 'cancelled', 'failed')),
  failure_reason TEXT    CHECK (failure_reason IS NULL OR failure_reason IN ('unsupported', 'environment_blocked', 'adapter_unavailable', 'adapter_error', 'attempt_ended', 'interrupted')),
  confirmed_by   TEXT    CHECK (confirmed_by IS NULL OR confirmed_by IN ('adapter_event', 'adapter_result')),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL CHECK (updated_at >= created_at),
  delivered_at   INTEGER,
  ended_at       INTEGER,
  UNIQUE (attempt_id, seq),
  UNIQUE (attempt_id, request_id),
  CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  CHECK ((status = 'delivered') = (confirmed_by IS NOT NULL)),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK ((status IN ('delivered', 'cancelled', 'failed')) = (ended_at IS NOT NULL))
) STRICT;

-- La cola pendiente de un Attempt, en orden.
CREATE INDEX attempt_queue_pending ON attempt_queue (attempt_id, seq) WHERE status IN ('queued', 'delivering');
-- Como mucho UNA entrega en vuelo por Attempt.
CREATE UNIQUE INDEX attempt_queue_one_delivering ON attempt_queue (attempt_id) WHERE status = 'delivering';

-- ── Inerte hasta el corte ──

CREATE TRIGGER attempt_queue_inert_insert BEFORE INSERT ON attempt_queue
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'attempt_queue está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER attempt_queue_inert_update BEFORE UPDATE ON attempt_queue
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'attempt_queue está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

-- ── Sin borrado; la identidad y el contenido no cambian ──

CREATE TRIGGER attempt_queue_no_delete BEFORE DELETE ON attempt_queue
BEGIN
  SELECT RAISE(ABORT, 'attempt_queue conserva la historia: no se borra');
END;

CREATE TRIGGER attempt_queue_identity_immutable BEFORE UPDATE ON attempt_queue
WHEN NEW.queue_id IS NOT OLD.queue_id OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.task_id IS NOT OLD.task_id
  OR NEW.seq IS NOT OLD.seq OR NEW.request_id IS NOT OLD.request_id OR NEW.request_digest IS NOT OLD.request_digest
  OR NEW.author_kind IS NOT OLD.author_kind OR NEW.author_id IS NOT OLD.author_id OR NEW.client_id IS NOT OLD.client_id
  OR NEW.body IS NOT OLD.body OR NEW.attachments IS NOT OLD.attachments OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'attempt_queue: la identidad y el contenido de un item no cambian');
END;

-- ── Ciclo de vida cerrado ──
-- (Solo con el modelo agentic activo: antes del corte manda el trigger de inerte, que es el mensaje que debe verse.)

-- Todo UPDATE es una transición de la tabla. Un final (`delivered`, `cancelled`, `failed`) no tiene salida: un item
-- cancelado nunca se entrega.
CREATE TRIGGER attempt_queue_lifecycle BEFORE UPDATE ON attempt_queue
WHEN EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'attempt_queue: transición fuera de la tabla (un item final no cambia y un cancelado nunca se entrega)')
  WHERE NOT (
    (OLD.status = 'queued'     AND NEW.status IN ('delivering', 'cancelled', 'failed')) OR
    (OLD.status = 'delivering' AND NEW.status IN ('delivered', 'failed'))
  );
END;

-- Solo el PRIMERO de la cola pasa a `delivering` (FIFO) y solo en un Attempt que no ha terminado.
CREATE TRIGGER attempt_queue_fifo BEFORE UPDATE ON attempt_queue
WHEN EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model') AND NEW.status = 'delivering' AND OLD.status = 'queued'
BEGIN
  SELECT RAISE(ABORT, 'attempt_queue: solo se entrega el primero de la cola (FIFO)')
  WHERE EXISTS (SELECT 1 FROM attempt_queue WHERE attempt_id = NEW.attempt_id AND status = 'queued' AND seq < NEW.seq);
  SELECT RAISE(ABORT, 'attempt_queue: no se entrega en un Attempt terminado')
  WHERE EXISTS (SELECT 1 FROM attempts WHERE id = NEW.attempt_id AND status IN ('done', 'failed', 'stopped', 'exited'));
END;

-- ── Coherencia al encolar ──

-- Nace en cola, en un Attempt de su Task que no ha terminado, con el siguiente `seq` (consecutivo, sin huecos).
CREATE TRIGGER attempt_queue_coherent BEFORE INSERT ON attempt_queue
WHEN EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'attempt_queue: un item nace en cola')
  WHERE NEW.status <> 'queued';
  SELECT RAISE(ABORT, 'attempt_queue: el Attempt no es de la Task indicada')
  WHERE NOT EXISTS (SELECT 1 FROM attempts WHERE id = NEW.attempt_id AND task_id = NEW.task_id);
  SELECT RAISE(ABORT, 'attempt_queue: no se encola en un Attempt terminado')
  WHERE EXISTS (SELECT 1 FROM attempts WHERE id = NEW.attempt_id AND status IN ('done', 'failed', 'stopped', 'exited'));
  SELECT RAISE(ABORT, 'attempt_queue: el orden de la cola es consecutivo por Attempt')
  WHERE NEW.seq <> 1 + (SELECT COALESCE(MAX(seq), 0) FROM attempt_queue WHERE attempt_id = NEW.attempt_id);
END;
