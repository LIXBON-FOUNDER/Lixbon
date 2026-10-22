-- 007_tasks: Task como intención durable (LXO-113, épica F3). Contrato: docs/core/TASKS.md.
--
-- UNA responsabilidad: la tabla de la INTENCIÓN (qué se quiere hacer, en qué Project y dentro de qué Run) y
-- la de su agrupación legacy (`runs`, ADR D16). Nada de ejecución: ni estado de proceso, ni PTY, ni worktree,
-- ni sesión del proveedor, ni informe. Eso es de Attempt y sus entidades (LXO-114 en adelante).
--
-- Se aplica DESPUÉS de la valla (002) y solo con la instalación ya autoritativa, igual que 003..006.
--
-- INERTE HASTA EL CORTE (docs/core/CORTE_TASK_ATTEMPT.md §9, D15): hasta que la migración del corte copie
-- `legacy_state` y escriba `meta.agentic_model`, la autoridad de las tareas sigue siendo el documento legacy.
-- Los triggers `*_inert_*` abortan cualquier INSERT, UPDATE o DELETE en `runs` y `tasks` mientras esa clave
-- no exista: no puede nacer una segunda autoridad por error. El corte escribe la clave ANTES de copiar.
--
-- Decisiones:
--   * PROJECT PERTENECE A TASK: `tasks.project_id` es FK real a `projects`. Solo una fila importada del
--     legado (`origin = 'legacy'`) puede no tenerlo (ADR D1); toda Task del Core lo exige.
--   * ESTADO: la Task guarda solo su INTENCIÓN (`open` | `discarded`), que es una decisión de la persona.
--     El estado de ejecución se deriva de sus Attempts y no se guarda aquí (ADR D17).
--   * SIN CASCADAS: ninguna FK lleva `ON DELETE`. Borrar una Task con hijas, o la raíz de un Run, falla en la
--     propia base; la política de borrado es explícita en el Core (`TaskRemoval`). Las FK circulares (Run ↔
--     raíz, padre ↔ hija) son `DEFERRABLE INITIALLY DEFERRED`: se comprueban al COMMIT.
--   * IDS: `tN` / `rN` del contador compartido `meta.id_seq` (ADR §8). Se conservan los del legado.
--   * Las comprobaciones de forma (título no vacío, marcas de tiempo ordenadas, árbol coherente) solo se
--     imponen a las filas del Core: el legado se importa tal cual y no puede abortar el corte por un título
--     vacío de hace meses.
--   * `repo` es la ruta local donde se creó (ADR D18); identificar sigue siendo cosa de `project_id`.
--   * Marcas de tiempo en ms epoch, FIJADAS por quien llama (la hora del evento que acompaña la escritura).

CREATE TABLE runs (
  id            TEXT    PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  objective     TEXT    NOT NULL,
  root_task_id  TEXT    NOT NULL REFERENCES tasks (id) DEFERRABLE INITIALLY DEFERRED,
  created_at    INTEGER NOT NULL,
  closed        INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
  last_activity INTEGER NOT NULL
) STRICT;

CREATE TABLE tasks (
  id             TEXT    PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  run_id         TEXT    NOT NULL REFERENCES runs (id) DEFERRABLE INITIALLY DEFERRED,
  parent_task_id TEXT    REFERENCES tasks (id) DEFERRABLE INITIALLY DEFERRED,
  depth          INTEGER NOT NULL CHECK (depth >= 0),
  project_id     TEXT    REFERENCES projects (id),
  title          TEXT    NOT NULL,
  spec           TEXT    NOT NULL DEFAULT '',
  repo           TEXT    NOT NULL,
  intent         TEXT    NOT NULL DEFAULT 'open' CHECK (intent IN ('open', 'discarded')),
  origin         TEXT    NOT NULL CHECK (origin IN ('legacy', 'core')),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  discarded_at   INTEGER,
  CHECK (parent_task_id IS NULL OR parent_task_id <> id),
  CHECK ((parent_task_id IS NULL) = (depth = 0)),
  CHECK ((intent = 'discarded') = (discarded_at IS NOT NULL)),
  CHECK (project_id IS NOT NULL OR origin = 'legacy'),
  CHECK (origin = 'legacy' OR length(trim(title)) > 0),
  CHECK (origin = 'legacy' OR updated_at >= created_at)
) STRICT;

CREATE INDEX tasks_by_run ON tasks (run_id, created_at, id);
CREATE INDEX tasks_by_parent ON tasks (parent_task_id);
CREATE INDEX tasks_by_project ON tasks (project_id, intent);

-- Árbol coherente para las filas del Core: una hija vive en el Run y el Project de su padre, un nivel por
-- debajo. (Las filas del legado se importan como estaban.)
CREATE TRIGGER tasks_core_tree BEFORE INSERT ON tasks
WHEN NEW.origin = 'core' AND NEW.parent_task_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM tasks AS p
  WHERE p.id = NEW.parent_task_id AND p.run_id = NEW.run_id AND p.depth + 1 = NEW.depth
    AND p.project_id IS NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'tasks: una hija va en el Run y el Project de su padre, un nivel por debajo');
END;

-- La relación de una Task con su Run, su padre y su Project no cambia después de nacer.
CREATE TRIGGER tasks_ownership_immutable BEFORE UPDATE ON tasks
WHEN NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.parent_task_id IS NOT OLD.parent_task_id
  OR NEW.depth IS NOT OLD.depth OR NEW.origin IS NOT OLD.origin OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.project_id IS NOT NULL AND NEW.project_id IS NOT OLD.project_id)
BEGIN
  SELECT RAISE(ABORT, 'tasks: id, run, padre, profundidad, origen, creación y project no cambian');
END;

CREATE TRIGGER runs_inert_insert BEFORE INSERT ON runs
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'runs está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER runs_inert_update BEFORE UPDATE ON runs
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'runs está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER runs_inert_delete BEFORE DELETE ON runs
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'runs está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER tasks_inert_insert BEFORE INSERT ON tasks
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'tasks está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER tasks_inert_update BEFORE UPDATE ON tasks
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'tasks está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER tasks_inert_delete BEFORE DELETE ON tasks
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'tasks está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;
