-- 025 · ContextPackage guardado (LXO-138). Contrato: docs/core/CONTEXT_PACKAGE.md § Guardado, export e import.
--
-- Un ContextPackage v1 es INMUTABLE y se identifica por su `package_id` (sha256 del contenido canónico). Hasta aquí el Core solo sabía
-- construirlo en memoria y recibirlo por el comando de continuidad; esta migración le da dónde vivir para que una persona pueda
-- exportarlo a un archivo y volver a importarlo (preparado para un Attempt futuro) sin que ninguno lo inicie.
--
--   * `context_packages` guarda el documento TAL CUAL (`json`, la forma canónica que se exporta). La fila nace una vez y no se
--     edita: un trigger rechaza cualquier UPDATE. Repetir el mismo paquete no escribe nada (el id ya lo identifica).
--   * `origin` = `built` (lo construyó este Core desde un Attempt) | `imported` (llegó de fuera por `parse`, con su identidad y sus
--     secretos ya comprobados). La procedencia del paquete (`source`) sigue DENTRO del documento y no se reescribe: `origin` solo
--     dice cómo llegó a ESTE almacén.
--   * `task_id` y `attempt_id` son los de `source` y NO son claves foráneas: un paquete importado puede venir de otra máquina y
--     su Attempt no existir aquí. Sirven para buscar «el paquete de este Attempt».
--   * `context_package_blobs` guarda los bytes de los adjuntos que viajan (los omitidos no están), cada uno con el `sha256` que el
--     paquete declara. Inmutables igual que el paquete.
--   * Nada de secretos: el paquete llega ya redactado y `parse` rechazó cualquiera con forma de credencial; los adjuntos de texto
--     con secreto se omitieron al construir (`omitted`) y no tienen fila aquí.
--
-- Va DESPUÉS de la barrera del corte (014), como 017..024: no se aplica hasta que el corte Task/Attempt ocurre.

CREATE TABLE context_packages (
  package_id TEXT    PRIMARY KEY NOT NULL CHECK (length(package_id) = 71 AND substr(package_id, 1, 7) = 'sha256:'),
  origin     TEXT    NOT NULL CHECK (origin IN ('built', 'imported')),
  task_id    TEXT    NOT NULL CHECK (length(task_id) BETWEEN 1 AND 200),
  attempt_id TEXT    NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 200),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  stored_at  INTEGER NOT NULL CHECK (stored_at >= 0),
  json       TEXT    NOT NULL CHECK (length(json) BETWEEN 2 AND 65536)
) WITHOUT ROWID;

CREATE INDEX context_packages_por_attempt ON context_packages (attempt_id, stored_at);

CREATE TABLE context_package_blobs (
  package_id    TEXT    NOT NULL REFERENCES context_packages (package_id),
  attachment_id TEXT    NOT NULL CHECK (length(attachment_id) = 20 AND substr(attachment_id, 1, 4) = 'att:'),
  sha256        TEXT    NOT NULL CHECK (length(sha256) = 64),
  data          BLOB    NOT NULL CHECK (length(data) <= 1048576),
  PRIMARY KEY (package_id, attachment_id)
) WITHOUT ROWID;

CREATE TRIGGER context_packages_inmutable BEFORE UPDATE ON context_packages
BEGIN
  SELECT RAISE(ABORT, 'un ContextPackage es inmutable');
END;

CREATE TRIGGER context_package_blobs_inmutable BEFORE UPDATE ON context_package_blobs
BEGIN
  SELECT RAISE(ABORT, 'un adjunto de ContextPackage es inmutable');
END;
