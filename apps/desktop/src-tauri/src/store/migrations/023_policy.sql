-- 023 · Policy efectiva: overrides durables de autonomía por ámbito (LXO-209). Contrato: docs/core/POLICY.md.
--
-- La policy decide qué Commands puede ejecutar cada actor y cuáles piden confirmación, elevación o están prohibidos. Lo que se
-- guarda aquí son SOLO los overrides que una persona fijó en Desktop; la base (matriz por actor) y los pisos de seguridad viven
-- en el código del Core y NO son editables desde una fila. La policy efectiva se calcula en cada Command, nunca se cachea.
--
--   * `scope_kind` = `global` (scope_id vacío) | `project` (id del Project) | `attempt` (id del Attempt). Una fila por
--     (ámbito, categoría): fijar de nuevo REEMPLAZA el nivel; volver a heredar BORRA la fila (reset).
--   * `level` = `allow | confirm | elevated | deny`. Los ámbitos project y attempt solo pueden ENDURECER respecto al de arriba:
--     eso lo exige el Core al escribir (ver `orch::policy`); la tabla solo acota los valores.
--   * `policy_state.revision` es el contador global de cambios: sube de uno en uno con cada cambio confirmado. Un cliente que
--     lee la policy y luego la edita manda la revisión que vio; si cambió, el Core responde `policy_stale` (nada se pisa).
--   * Cambiar la policy NO reescribe la historia: cada cambio deja su Event `policy.changed` (append-only) con el ámbito, la
--     categoría y el nivel anterior y nuevo. La tabla guarda el estado actual; la historia está en `events`.
--   * Nada de secretos: ni credenciales, ni tokens, ni rutas. Solo ámbito, categoría, nivel y quién lo fijó.
--
-- Va DESPUÉS de la barrera del corte (014), como 017..022: no se aplica hasta que el corte Task/Attempt ocurre.

CREATE TABLE policy_overrides (
  scope_kind TEXT    NOT NULL CHECK (scope_kind IN ('global', 'project', 'attempt')),
  scope_id   TEXT    NOT NULL CHECK ((scope_kind = 'global' AND scope_id = '') OR (scope_kind <> 'global' AND length(scope_id) BETWEEN 1 AND 200)),
  category   TEXT    NOT NULL CHECK (category IN ('start', 'answer', 'queue', 'steer', 'stop', 'fork', 'review', 'integrate', 'cleanup', 'provider_permissions')),
  level      TEXT    NOT NULL CHECK (level IN ('allow', 'confirm', 'elevated', 'deny')),
  set_by     TEXT    NOT NULL CHECK (length(set_by) BETWEEN 1 AND 200),
  set_at     INTEGER NOT NULL CHECK (set_at >= 0),
  revision   INTEGER NOT NULL CHECK (revision >= 1),
  PRIMARY KEY (scope_kind, scope_id, category)
) WITHOUT ROWID;

CREATE TABLE policy_state (
  id       INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0)
);

INSERT INTO policy_state (id, revision) VALUES (1, 0);

CREATE TRIGGER policy_state_revision_avanza_de_uno BEFORE UPDATE ON policy_state
WHEN NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'la revision de la policy solo avanza de uno en uno');
END;

CREATE TRIGGER policy_state_no_se_borra BEFORE DELETE ON policy_state
BEGIN
  SELECT RAISE(ABORT, 'policy_state no se borra');
END;
