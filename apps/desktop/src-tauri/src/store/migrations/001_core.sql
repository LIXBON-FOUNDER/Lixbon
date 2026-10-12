-- 001_core: núcleo del almacén SQLite del Core (slice B de la Fase 1).
--
-- Contiene SOLO lo imprescindible para arrancar el almacén:
--   * schema_migrations : trazabilidad de las migraciones aplicadas.
--   * meta              : pares clave/valor del propio almacén (machine_id,
--                         fecha de importación del legado, versión del Core…).
--   * legacy_state      : el `State` actual del orquestador como UN documento
--                         JSON, con `rev` para concurrencia optimista.
--
-- NO crea projects / project_locations / events / clients / attention_*:
-- cada una llega en su propia migración, de otro slice, con número reservado:
--   002 proyectos (D) · 003 eventos (E) · 004 clientes (F) · 005 attention (G)
-- Basta con soltar el archivo `NNN_nombre.sql` en esta carpeta: `build.rs` lo
-- descubre y lo embebe, sin tocar el framework ni una lista común.
--
-- Reglas para escribir migraciones (todas se ejecutan en UNA transacción):
--   * Solo hacia adelante; nunca se edita una ya publicada (el checksum
--     SHA-256 del texto, sin `\r`, quedaría distinto y el almacén se
--     negaría a abrir las bases que ya la aplicaron).
--   * Sin BEGIN/COMMIT/ROLLBACK ni `PRAGMA foreign_keys` (el framework detecta
--     y rechaza el cierre prematuro de la transacción).
--   * `STRICT` en todas las tablas; marcas de tiempo en milisegundos epoch
--     (INTEGER); identificadores en TEXT.
--
-- REFERENCIAS BLANDAS DE `events` (decisión del usuario, 2026-10-11):
--   Cuando el slice E cree la tabla `events` (migración 003), las columnas
--   `project_id`, `client_id`, `entity_kind` y `entity_id` serán referencias
--   BLANDAS: SIN `REFERENCES` / sin clave foránea de SQLite. Motivo de
--   auditoría: los eventos históricos deben conservarse aunque después se
--   archive un Project o se revoque un Client o dispositivo; una FK lo
--   impediría (RESTRICT) o arrastraría las filas (CASCADE). "Blanda" NO
--   significa "sin validar": el Core comprueba, al emitir el evento, que el
--   Project o el Client existen cuando el evento los lleva. El resto de las
--   relaciones del esquema inicial SÍ son FK reales (p. ej.
--   project_locations.project_id → projects, y las de attention_items /
--   attention_state). El framework ya admite ambas formas (ver la prueba
--   `migracion_con_referencia_blanda_sin_fk` en `tests.rs`).

CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  checksum    TEXT    NOT NULL,   -- SHA-256 hex del texto de la migración
  app_version TEXT    NOT NULL,   -- versión del binario que la aplicó
  applied_at  INTEGER NOT NULL    -- ms epoch
) STRICT;

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- Una sola fila (id = 1). `doc` es el `State` serializado con serde_json;
-- `rev` implementa concurrencia optimista (UPDATE ... WHERE rev = ?);
-- `doc_schema = 0` marca el layout actual (sin versión). La fila la crea la
-- importación del legado (slice C); aquí la tabla nace vacía.
CREATE TABLE legacy_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  rev        INTEGER NOT NULL,
  doc_schema INTEGER NOT NULL DEFAULT 0,
  doc        TEXT    NOT NULL CHECK (json_valid(doc)),
  updated_at INTEGER NOT NULL
) STRICT;
