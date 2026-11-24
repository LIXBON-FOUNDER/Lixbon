-- 027 · F7 · Identidad de host (LXO-182).
--
-- Hasta la 026 una «máquina» era un texto suelto: `meta.machine_id`, copiado en `project_locations.machine` y `worktrees.machine`. Nada decía quién
-- era esa máquina ni permitía distinguir un host real de un texto declarado por un cliente. Esta migración añade la tabla `hosts`:
--
--   * `host_id` es la MISMA cadena que ya usan `project_locations.machine` y `worktrees.machine`: ninguna fila existente cambia.
--   * Exactamente un host es `is_self` (este Core). El resto son pares, y un par solo entra con una prueba de posesión de su clave (Rust,
--     `orch/host_identity.rs`): el almacén solo guarda y protege lo ya verificado.
--   * `public_key` es una clave Ed25519 en hexadecimal (32 bytes). Una vez fijada NO cambia: otra clave para el mismo `host_id` es un
--     intento de suplantación, y una clave no se comparte entre dos hosts.
--   * Un host nunca se borra: estar parado o sin conexión es `last_seen` viejo, no una fila que desaparece (invariante 4 de LXO-182).
--   * Ningún secreto vive aquí: la clave PRIVADA está en el almacén seguro del sistema operativo.
--
-- `project_locations.machine` NO se convierte en clave foránea: las ubicaciones de un par las describe el propio par, y las pruebas y el
-- relleno del registro usan identificadores de máquina sintéticos. La regla «una ubicación solo se escribe para un host conocido» la impone
-- el Core al registrar, no un trigger que rompería el registro de proyectos ya existente.

CREATE TABLE hosts (
  host_id      TEXT    PRIMARY KEY CHECK (length(trim(host_id)) BETWEEN 1 AND 200),
  label        TEXT    NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
  is_self      INTEGER NOT NULL DEFAULT 0 CHECK (is_self IN (0, 1)),
  public_key   TEXT    CHECK (public_key IS NULL OR (length(public_key) = 64 AND public_key NOT GLOB '*[^0-9a-f]*')),
  os           TEXT    CHECK (os IS NULL OR length(os) BETWEEN 1 AND 64),
  arch         TEXT    CHECK (arch IS NULL OR length(arch) BETWEEN 1 AND 64),
  app_version  TEXT    CHECK (app_version IS NULL OR length(app_version) BETWEEN 1 AND 64),
  capabilities TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(capabilities) AND json_type(capabilities) = 'array'),
  first_seen   INTEGER NOT NULL,   -- ms epoch del primer alta
  last_seen    INTEGER NOT NULL,   -- ms epoch de la última señal verificada de ese host
  verified_at  INTEGER             -- ms epoch de la última prueba de posesión aceptada (NULL: nunca verificado)
) STRICT;

-- Un solo host propio, y una clave pública pertenece a un solo host.
CREATE UNIQUE INDEX hosts_one_self ON hosts (is_self) WHERE is_self = 1;
CREATE UNIQUE INDEX hosts_unique_public_key ON hosts (public_key) WHERE public_key IS NOT NULL;

-- La clave fijada no se sustituye. (Fijarla por primera vez, de NULL a un valor, sí se permite.)
CREATE TRIGGER hosts_key_is_pinned BEFORE UPDATE OF public_key ON hosts
WHEN OLD.public_key IS NOT NULL AND NEW.public_key IS NOT OLD.public_key
BEGIN
  SELECT RAISE(ABORT, 'hosts: la clave de un host ya fijado no cambia');
END;

-- Un host no se convierte en el propio ni deja de serlo.
CREATE TRIGGER hosts_self_is_fixed BEFORE UPDATE OF is_self ON hosts
WHEN NEW.is_self IS NOT OLD.is_self
BEGIN
  SELECT RAISE(ABORT, 'hosts: is_self no cambia');
END;

-- Parado o sin conexión no es borrado.
CREATE TRIGGER hosts_are_never_deleted BEFORE DELETE ON hosts
BEGIN
  SELECT RAISE(ABORT, 'hosts: un host no se borra');
END;

-- Relleno de lo que ya existía: este equipo (su `machine_id`) y las máquinas que ya aparecen en las ubicaciones, sin verificar.
INSERT INTO hosts (host_id, label, is_self, first_seen, last_seen)
SELECT value, 'Este equipo', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM meta
WHERE key = 'machine_id' AND length(trim(value)) BETWEEN 1 AND 200;

INSERT OR IGNORE INTO hosts (host_id, label, is_self, first_seen, last_seen)
SELECT machine, 'Host sin verificar', 0, MIN(last_seen), MAX(last_seen)
FROM project_locations
WHERE length(trim(machine)) BETWEEN 1 AND 200
GROUP BY machine;
