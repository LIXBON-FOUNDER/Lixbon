-- 024 · Attempt ADOPTADO: trabajo que ya existía fuera de Lixbon y una persona decide hacer suyo (LXO-149/157). Contrato: docs/core/RESOURCES.md § Adoptar.
--
-- Un worktree externo (creado a mano o por otra herramienta) no tiene Attempt: Lixbon no lo lanzó ni lo vio correr. Adoptarlo le da un Attempt
-- para que se pueda REVISAR, comparar e integrar como cualquier otro, sin inventar un historial que no ocurrió. Hasta ahora la base solo dejaba
-- nacer un Attempt pendiente o arrancando (`attempts_core_create`); uno que nace TERMINADO, sin pasar por el ciclo de vida, solo existe aquí.
--
--   * `adopted_at` (NULL = un Attempt normal) es el instante en que la persona lo adoptó. El esquema exige `started_at` y `ended_at` para un
--     Attempt `done`, así que valen ese mismo instante: NO son una duración ni un arranque reales. Quien lee un Attempt adoptado debe ignorarlos y
--     decir «adoptado» (los lectores del Core lo hacen: `started_at`/`ended_at` salen `null`).
--   * Nace SOLO así: `done`, `n = 1`, `origin = 'core'`, proveedor `external`, no `external` (no es un coordinador externo), sin aprobación y CON
--     su Worktree (`provenance = 'adopted'`). Es la primera ejecución de una Task abierta que no tenía ninguna (`not_started`).
--   * Un Attempt final es historia (`attempts_final_is_final`): lo adoptado no cambia después, salvo lo que ya admite un final (integrarlo).
--   * Va DESPUÉS de la barrera del corte, como 017..023: no se aplica hasta que el corte Task/Attempt ocurre.

ALTER TABLE attempts ADD COLUMN adopted_at INTEGER CHECK (adopted_at IS NULL OR adopted_at > 0);

-- La misma regla de nacimiento de la 008, más una excepción: un Attempt adoptado nace `done`.
DROP TRIGGER attempts_core_create;
CREATE TRIGGER attempts_core_create BEFORE INSERT ON attempts
WHEN NEW.origin = 'core' AND (
  (NEW.status NOT IN ('pending_approval', 'starting') AND NOT (NEW.adopted_at IS NOT NULL AND NEW.status = 'done'))
  OR NEW.n IS NOT (SELECT coalesce(max(n), 0) + 1 FROM attempts WHERE task_id = NEW.task_id)
  OR NOT EXISTS (
    SELECT 1 FROM tasks AS t JOIN runs AS r ON r.id = t.run_id
    WHERE t.id = NEW.task_id AND t.intent = 'open' AND r.closed = 0
  )
)
BEGIN
  SELECT RAISE(ABORT, 'attempts: un Attempt del Core nace pendiente o arrancando (o adoptado y terminado), con el n siguiente, en una Task abierta de un Run abierto');
END;

-- La forma exacta de un Attempt adoptado: nada más puede llevar `adopted_at`.
CREATE TRIGGER attempts_adopted_shape BEFORE INSERT ON attempts
WHEN NEW.adopted_at IS NOT NULL AND (
  NEW.origin <> 'core' OR NEW.status <> 'done' OR NEW.n <> 1 OR NEW.external <> 0 OR NEW.provider <> 'external'
  OR NEW.worktree_id IS NULL OR NEW.initial_approval_deadline IS NOT NULL
  OR NEW.started_at IS NOT NEW.adopted_at OR NEW.ended_at IS NOT NEW.adopted_at OR NEW.created_at > NEW.adopted_at
)
BEGIN
  SELECT RAISE(ABORT, 'attempts: un Attempt adoptado nace terminado, primero de su Task, con proveedor external y su Worktree');
END;

-- `adopted_at` se fija al nacer y no cambia: ni se pone a un Attempt que ya existe, ni se borra o cambia (tampoco aprovechando una integración, que
-- `attempts_final_is_final` sí admite).
CREATE TRIGGER attempts_adopted_at_immutable BEFORE UPDATE OF adopted_at ON attempts
WHEN NEW.adopted_at IS NOT OLD.adopted_at
BEGIN
  SELECT RAISE(ABORT, 'attempts: adopted_at se fija al adoptar y no cambia');
END;

-- Un Worktree adoptado es de un Attempt adoptado, y al revés: la procedencia y el Attempt cuentan lo mismo.
CREATE TRIGGER attempts_adopted_has_adopted_worktree BEFORE INSERT ON attempts
WHEN NEW.adopted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM worktrees w WHERE w.id = NEW.worktree_id AND w.provenance = 'adopted' AND w.attempt_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'attempts: un Attempt adoptado lleva un Worktree con procedencia adopted y de ese Attempt');
END;

-- Un Worktree ADOPTADO nace ANTES que su Attempt (el Attempt nace ya terminado y lleva su worktree_id): la 010 exigía un Attempt activo que lo
-- registre. Para la procedencia `adopted` basta con que el Attempt aún no exista (la clave foránea diferida lo comprueba al confirmar) y que la
-- Task esté abierta; para las demás procedencias la regla es la de siempre.
DROP TRIGGER worktrees_core_create;
CREATE TRIGGER worktrees_core_create BEFORE INSERT ON worktrees
WHEN NEW.origin = 'core' AND (
  NEW.state IS NOT 'active'
  OR NOT (
    EXISTS (
      SELECT 1 FROM attempts AS a
      WHERE a.id = NEW.attempt_id AND a.task_id = NEW.task_id AND a.status NOT IN ('done', 'failed', 'stopped', 'exited')
    )
    OR (
      NEW.provenance = 'adopted'
      AND NOT EXISTS (SELECT 1 FROM attempts AS a WHERE a.id = NEW.attempt_id)
      AND EXISTS (SELECT 1 FROM tasks AS t WHERE t.id = NEW.task_id AND t.intent = 'open')
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'worktrees: un Worktree del Core nace activo y lo registra un Attempt activo de su Task (o es adoptado, antes de su Attempt)');
END;
