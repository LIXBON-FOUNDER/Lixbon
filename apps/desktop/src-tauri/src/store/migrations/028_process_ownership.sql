-- 028 · F7 · Propiedad persistente de procesos (LXO-183).
--
-- Hasta la 027 quién poseía el proceso de un Attempt vivía SOLO en la memoria del Core (la custodia del supervisor, `static`). Si el Core
-- moría, nadie sabía qué procesos había lanzado: en Unix se quedaban huérfanos y en Windows los mataba el Job, sin que quedara constancia.
--
-- `process_ownership` guarda, por Attempt, la IDENTIDAD de la raíz del proceso que un runtime lanzó: pid + hora de creación (un pid solo se
-- reutiliza) + grupo (Unix), y quién lo sostiene (`runtime_instance`) con un lease que renueva el latido. Al arrancar, un runtime nuevo
-- reconoce lo que dejó el anterior y lo resuelve con la misma verificación de identidad que el kill del árbol (`proctable`).
--
--   * Un solo proceso vivo por Attempt (`held` o `unproven`); `released` es historia y nunca vuelve a vivir.
--   * `held`: este runtime lo sostiene y renueva su lease. `unproven`: su cierre no se pudo probar y sigue a la vista (custodia durable).
--   * `released` lleva su motivo: `closed` (este runtime lo cerró con prueba), `gone` (un runtime posterior comprobó que ya no existía) o
--     `reaped` (un runtime posterior lo encontró vivo, con su identidad, y lo cerró).
--   * La identidad no cambia: otro pid o otra hora de creación es OTRO proceso y otra fila.
--   * Nada se borra. Ningún secreto vive aquí (ni argv, ni entorno, ni rutas).

CREATE TABLE process_ownership (
  process_id       TEXT    PRIMARY KEY NOT NULL CHECK (length(process_id) BETWEEN 1 AND 80),
  attempt_id       TEXT    NOT NULL REFERENCES attempts (id),
  host_id          TEXT    NOT NULL CHECK (length(trim(host_id)) BETWEEN 1 AND 200),
  runtime_instance TEXT    NOT NULL CHECK (length(trim(runtime_instance)) BETWEEN 1 AND 80),
  root_pid         INTEGER NOT NULL CHECK (root_pid > 0),
  -- Hora de creación de la raíz: un token opaco de hasta 64 bits sin signo, en decimal. NULL = no se pudo probar (el proceso no se
  -- podrá reconocer después: queda `unproven` en cuanto su runtime desaparezca).
  root_start       TEXT    CHECK (root_start IS NULL OR (length(root_start) BETWEEN 1 AND 20 AND root_start NOT GLOB '*[^0-9]*')),
  pgid             INTEGER CHECK (pgid IS NULL OR pgid > 0),
  state            TEXT    NOT NULL CHECK (state IN ('held', 'unproven', 'released')),
  lease_until      INTEGER NOT NULL,
  heartbeat_at     INTEGER NOT NULL,
  registered_at    INTEGER NOT NULL,
  released_at      INTEGER,
  release_reason   TEXT    CHECK (release_reason IS NULL OR release_reason IN ('closed', 'gone', 'reaped')),
  CHECK ((state = 'released') = (released_at IS NOT NULL AND release_reason IS NOT NULL))
) STRICT;

-- Como mucho un proceso vivo por Attempt y un mismo proceso (host + pid + hora de creación) no está vivo en dos filas.
CREATE UNIQUE INDEX process_ownership_one_live_per_attempt ON process_ownership (attempt_id) WHERE state <> 'released';
CREATE UNIQUE INDEX process_ownership_one_live_per_process ON process_ownership (host_id, root_pid, root_start) WHERE state <> 'released' AND root_start IS NOT NULL;
CREATE INDEX process_ownership_live ON process_ownership (state, runtime_instance) WHERE state <> 'released';

-- La identidad de un proceso registrado no cambia.
CREATE TRIGGER process_ownership_identity_is_fixed BEFORE UPDATE OF attempt_id, host_id, root_pid, root_start, pgid, registered_at ON process_ownership
WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.host_id IS NOT OLD.host_id OR NEW.root_pid IS NOT OLD.root_pid
  OR NEW.root_start IS NOT OLD.root_start OR NEW.pgid IS NOT OLD.pgid OR NEW.registered_at IS NOT OLD.registered_at
BEGIN
  SELECT RAISE(ABORT, 'process_ownership: la identidad de un proceso registrado no cambia');
END;

-- Lo liberado es historia: no vuelve a vivir ni cambia de motivo.
CREATE TRIGGER process_ownership_released_is_final BEFORE UPDATE ON process_ownership
WHEN OLD.state = 'released'
BEGIN
  SELECT RAISE(ABORT, 'process_ownership: un proceso liberado no cambia');
END;

CREATE TRIGGER process_ownership_is_never_deleted BEFORE DELETE ON process_ownership
BEGIN
  SELECT RAISE(ABORT, 'process_ownership: la historia de propiedad no se borra');
END;
