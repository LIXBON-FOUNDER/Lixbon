-- 015 · Causa nueva de bloqueo de entorno: el sandbox de Windows de Codex (LXO-131).
--
-- `env_blocks.cause` es un conjunto cerrado con CHECK (012) y SQLite no deja cambiar un CHECK en su sitio, así que la
-- tabla se reconstruye con la causa nueva `windows_sandbox_setup` (el sandbox de Windows de Codex está en uso por otra
-- aplicación, sin configurar o con una actualización pendiente). Las filas se copian tal cual y los dos triggers de
-- «inerte hasta el corte» (012), que caen con la tabla, se vuelven a crear idénticos. Nada más cambia.

CREATE TABLE env_blocks_nueva (
  scope TEXT NOT NULL,
  cause TEXT NOT NULL CHECK (cause IN ('cli_missing', 'cli_flags_unsupported', 'windows_sandbox_elevated', 'windows_sandbox_setup')),
  PRIMARY KEY (scope, cause)
) STRICT;

INSERT INTO env_blocks_nueva (scope, cause) SELECT scope, cause FROM env_blocks;

DROP TABLE env_blocks;

ALTER TABLE env_blocks_nueva RENAME TO env_blocks;

CREATE TRIGGER env_blocks_inert_insert BEFORE INSERT ON env_blocks
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'env_blocks está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER env_blocks_inert_delete BEFORE DELETE ON env_blocks
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'env_blocks está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;
