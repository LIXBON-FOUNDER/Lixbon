-- 004_events: Event Log autoritativo del Core (slice E, etapa E1a: infraestructura).
--
-- UNA responsabilidad: guardar HECHOS estructurados y durables (qué ocurrió, quién lo provocó, sobre
-- qué entidad y en qué proyecto), en orden total, como historia APPEND-ONLY. Nada más: ni Attention
-- (G), ni clientes (F1), ni vistas (Activity).
--
-- Se aplica DESPUÉS de la valla (002) y solo con la instalación ya autoritativa, igual que la 003: la
-- aplica `Store::migrate_authoritative` tras `decide_boot`.
--
-- Decisiones (docs/core/EVENTOS.md):
--   * ORDEN: `seq` (AUTOINCREMENT) es el orden autoritativo y el cursor de lectura. `at` es solo
--     informativo y NO participa en el orden. Hay un único escritor y cada escritura es
--     `BEGIN IMMEDIATE`, así que el orden de `seq` es el orden de COMMIT; AUTOINCREMENT evita que un
--     número se reutilice aunque algún día se compacte la tabla.
--   * ATOMICIDAD: los eventos de una mutación del estado se insertan en la MISMA transacción que
--     `UPDATE legacy_state`. `state_rev` es la `rev` de ese COMMIT: agrupa los hechos de una misma
--     mutación. Los hechos que no tocan `legacy_state` (registro de proyectos, solicitudes de
--     lanzamiento) llevan `state_rev` NULL y van en su propia transacción.
--   * REFERENCIAS BLANDAS: `project_id`, `run_id`, `client_id`, `entity_kind` y `entity_id` NO llevan
--     `REFERENCES`. Archivar un proyecto, borrar un run o revocar un cliente no puede borrar ni
--     bloquear su historia. "Blanda" no es "sin validar": el Core comprueba al emitir.
--   * CLASE: solo `state | effect | decision | system`. Dice qué CLASE de hecho es, no qué módulo
--     escribió la fila.
--   * IDEMPOTENCIA: `UNIQUE (kind, idem_key)` (parcial): la misma clave de dos tipos de evento
--     distintos no colisiona; el mismo hecho repetido se deduplica.
--   * PAYLOAD: JSON válido y como mucho 8 KiB MEDIDOS EN BYTES (`CAST(.. AS BLOB)`; `length()` de un
--     TEXT cuenta caracteres, no bytes). Lo que entra en columnas es lo que se filtra u ordena; el
--     resto, en el payload tipado. Nunca cuerpos de mensaje, informes, diffs, argv, env ni secretos.
--   * `entity_kind` y `channel` se validan en Rust, sin CHECK: la tabla es append-only y ampliar un
--     CHECK obligaría a reconstruirla con los triggers desactivados. `class` y `actor_kind` son
--     conjuntos cerrados y estables.
--   * `client_id` queda NULL hasta F1 (identidad de cliente por credencial); `channel` describe el
--     transporte (ui | lxo | core), no una identidad.
--   * APPEND-ONLY impuesto por la base: UPDATE y DELETE abortan. Si algún día hace falta retención o
--     compactación será una migración explícita que cambie esta propiedad a propósito.
--   * Sin relleno histórico: los eventos empiezan en el despliegue.

CREATE TABLE events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT    NOT NULL UNIQUE,    -- UUID v7: identidad global del evento
  at             INTEGER NOT NULL,           -- ms epoch; NO ordena
  v              INTEGER NOT NULL CHECK (v >= 1),   -- versión del contrato (kind + payload)
  kind           TEXT    NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
  class          TEXT    NOT NULL CHECK (class IN ('state', 'effect', 'decision', 'system')),
  actor_kind     TEXT    NOT NULL CHECK (actor_kind IN ('person', 'agent', 'system')),
  actor_id       TEXT,                       -- id de la tarea cuando el actor es un agente
  channel        TEXT,                       -- transporte: ui | lxo | core
  client_id      TEXT,                       -- reservado para F1; blando
  project_id     TEXT,                       -- blando
  run_id         TEXT,                       -- blando (modelo legacy Run)
  entity_kind    TEXT    NOT NULL CHECK (length(entity_kind) > 0),   -- blando
  entity_id      TEXT    NOT NULL CHECK (length(entity_id) > 0),     -- blando
  correlation_id TEXT,                       -- p. ej. el pending_id que une solicitud y resolución
  idem_key       TEXT    CHECK (idem_key IS NULL OR length(idem_key) > 0),
  state_rev      INTEGER CHECK (state_rev IS NULL OR state_rev >= 1),
  payload        TEXT    NOT NULL DEFAULT '{}'
                 CHECK (json_valid(payload) AND length(CAST(payload AS BLOB)) <= 8192),
  CHECK (actor_kind <> 'agent' OR actor_id IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX events_idem ON events (kind, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX events_by_project ON events (project_id, seq);
CREATE INDEX events_by_entity ON events (entity_kind, entity_id, seq);
CREATE INDEX events_by_run ON events (run_id, seq);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events es append-only: no se actualiza');
END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events es append-only: no se borra');
END;
