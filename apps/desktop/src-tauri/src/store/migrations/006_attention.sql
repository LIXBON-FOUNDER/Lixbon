-- 006_attention: modelo autoritativo de Attention del Core (LXO-87, slice G). Solo el MODELO y su
-- ciclo de vida: las reglas que derivan Attention de Events/State (LXO-88) y la API de lectura
-- (LXO-89) vienen después y no viven aquí.
--
-- Attention responde «qué necesita de mí ahora». NO es el Event Log (qué ocurrió), NO es unread y NO
-- es una vista: es una fila durable por cada ocurrencia de un hecho que espera una acción de una
-- persona. Contrato completo y diagramas: docs/core/ATTENTION.md.
--
-- Se aplica DESPUÉS de la valla (002) y solo con la instalación ya autoritativa, igual que 003..005.
--
-- Decisiones:
--   * IDENTIDAD: `fingerprint` = SHA-256 del hecho (categoría + destino + subject); `id` se deriva de
--     `(fingerprint, occurrence)`. Mismo historial ⇒ mismos ids en una instalación reconstruida.
--     Una recurrencia tras resolver es otra ocurrencia (`occurrence + 1`) con otro `id`.
--   * DEDUPLICACIÓN: como mucho UNA ocurrencia activa por `fingerprint` (índice único parcial). El
--     código lo respeta (`attention_raise` devuelve la activa) y la base lo impone igualmente.
--   * DESTINO LÓGICO: `target_kind` + `target_id` son identidades del Core, nunca rutas. Se rechazan
--     aquí (y en Rust) las rutas absolutas, UNC, `~` y `..`: cambiar la ruta local de un proyecto no
--     invalida ninguna fila. `target_kind` se valida en Rust, sin CHECK (ampliarlo no debe exigir
--     reconstruir la tabla), igual que `events.entity_kind`.
--   * REFERENCIAS BLANDAS: `project_id`, `run_id`, `source_event_id` y `correlation_id` no llevan
--     `REFERENCES`: el origen puede ser de otra instalación y archivar un proyecto no bloquea la
--     historia. `source_event_id` es el `events.id` (UUID v7), no el `seq` local.
--   * CATEGORÍA / SEVERIDAD: conjuntos cerrados fijados por el Core, inmutables en la fila.
--   * ESTADO: solo `active | resolved`. NO hay `snoozed`: posponer es política por persona/dispositivo
--     (cliente), no un hecho del dominio. Tampoco hay columnas de lectura, cliente, usuario ni
--     textos de interfaz (título, mensaje, ayuda): el dominio guarda CÓDIGOS y la interfaz los traduce.
--   * HISTORIA: resolver marca la fila (`resolved`, `resolved_at`, `resolution`); nunca la borra ni toca
--     `events`. `resolved` es terminal. Los triggers impiden DELETE y cualquier UPDATE que no sea la
--     transición `active → resolved`.
--   * `facts`: objeto JSON acotado (2 KiB medidos en BYTES) con datos estructurados del hecho; nunca
--     cuerpos de mensaje, diffs, argv, env ni secretos.
--   * Marcas de tiempo en milisegundos epoch, FIJADAS por quien llama (no `now()` implícito).
--   * Sin relleno histórico: Attention empieza vacía en el despliegue.

CREATE TABLE attention_items (
  id              TEXT    PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  fingerprint     TEXT    NOT NULL CHECK (length(fingerprint) = 64),
  occurrence      INTEGER NOT NULL CHECK (occurrence >= 1),
  category        TEXT    NOT NULL CHECK (category IN ('question', 'approval', 'review_ready', 'conflict', 'failed', 'environment_blocked', 'risk')),
  severity        TEXT    NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  status          TEXT    NOT NULL CHECK (status IN ('active', 'resolved')),
  target_kind     TEXT    NOT NULL CHECK (length(target_kind) BETWEEN 1 AND 32),
  target_id       TEXT    NOT NULL CHECK (
                    length(target_id) BETWEEN 1 AND 200
                    AND length(trim(target_id)) > 0
                    AND substr(target_id, 1, 1) NOT IN ('/', '~', char(92))
                    AND target_id NOT GLOB '[A-Za-z]:*'
                    AND instr(target_id, char(92)) = 0
                    AND instr(target_id, '..') = 0
                  ),
  project_id      TEXT,
  run_id          TEXT,
  subject         TEXT    CHECK (subject IS NULL OR length(subject) BETWEEN 1 AND 200),
  source_event_id TEXT    CHECK (source_event_id IS NULL OR length(source_event_id) > 0),
  correlation_id  TEXT    CHECK (correlation_id IS NULL OR length(correlation_id) > 0),
  facts           TEXT    NOT NULL DEFAULT '{}'
                  CHECK (json_valid(facts) AND json_type(facts) = 'object' AND length(CAST(facts AS BLOB)) <= 2048),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL CHECK (updated_at >= created_at),
  resolved_at     INTEGER,
  resolution      TEXT    CHECK (resolution IS NULL OR resolution IN ('acted', 'condition_cleared', 'superseded')),
  UNIQUE (fingerprint, occurrence),
  CHECK (
    (status = 'active'   AND resolved_at IS NULL AND resolution IS NULL)
    OR
    (status = 'resolved' AND resolved_at IS NOT NULL AND resolution IS NOT NULL AND resolved_at >= created_at)
  )
) STRICT;

-- Un hecho = como mucho una Attention activa.
CREATE UNIQUE INDEX attention_one_active ON attention_items (fingerprint) WHERE status = 'active';
-- Destino lógico → sus Attention (lo usarán las reglas y la API de lectura).
CREATE INDEX attention_by_target ON attention_items (target_kind, target_id, status);

CREATE TRIGGER attention_no_delete BEFORE DELETE ON attention_items
BEGIN
  SELECT RAISE(ABORT, 'attention_items conserva la historia: no se borra');
END;

CREATE TRIGGER attention_only_resolve BEFORE UPDATE ON attention_items
WHEN OLD.status = 'resolved'
  OR NEW.id IS NOT OLD.id
  OR NEW.fingerprint IS NOT OLD.fingerprint
  OR NEW.occurrence IS NOT OLD.occurrence
  OR NEW.category IS NOT OLD.category
  OR NEW.severity IS NOT OLD.severity
  OR NEW.target_kind IS NOT OLD.target_kind
  OR NEW.target_id IS NOT OLD.target_id
  OR NEW.project_id IS NOT OLD.project_id
  OR NEW.run_id IS NOT OLD.run_id
  OR NEW.subject IS NOT OLD.subject
  OR NEW.source_event_id IS NOT OLD.source_event_id
  OR NEW.correlation_id IS NOT OLD.correlation_id
  OR NEW.facts IS NOT OLD.facts
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'attention_items solo admite la transición active -> resolved');
END;
