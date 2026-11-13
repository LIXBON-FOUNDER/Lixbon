-- 026 · F5 · Worktree compartido entre Attempts de Tasks distintas del mismo Project (LXO-248).
--
-- Hasta la 025 un Attempt solo podía trabajar en un Worktree ACTIVO DE SU TASK (`attempts_worktree_exists`, 010). Un reintento de la
-- misma Task lo hacía; otra Task no. La estrategia `shared` (docs/core/WORKTREE_SHARED.md) permite que un Attempt de OTRA Task del
-- MISMO Project reutilice el Worktree de otro, con estas reglas, impuestas aquí aunque alguien escriba SQL a mano:
--
--   * Mismo Project: ambas Tasks tienen Project y es el mismo. Una Task sin Project (legacy) nunca comparte.
--   * En serie: un Attempt de OTRA Task solo se enlaza si ningún otro Attempt vivo (no final) usa ya ese Worktree. Dentro de la misma
--     Task la regla de siempre no cambia (la impone el almacén en Rust, `in_use`).
--   * El Worktree sigue siendo de UNA Task (`worktrees.task_id`, el dueño, el que lo creó): quien comparte no lo posee y no lo quita.
--
-- SQLite no tiene ALTER TRIGGER: se sustituye el de la 010. Nada más cambia; lo que ya estaba enlazado sigue cumpliendo una regla más
-- estricta que esta.

DROP TRIGGER attempts_worktree_exists;

CREATE TRIGGER attempts_worktree_exists BEFORE UPDATE OF worktree_id ON attempts
WHEN NEW.worktree_id IS NOT NULL AND NEW.worktree_id IS NOT OLD.worktree_id AND NOT EXISTS (
  SELECT 1
  FROM worktrees AS w
  JOIN tasks AS owner ON owner.id = w.task_id
  JOIN tasks AS mine ON mine.id = NEW.task_id
  WHERE w.id = NEW.worktree_id
    AND w.state = 'active'
    AND (
      w.task_id = NEW.task_id
      OR (
        owner.project_id IS NOT NULL AND owner.project_id = mine.project_id
        AND NOT EXISTS (
          SELECT 1 FROM attempts AS other
          WHERE other.worktree_id = w.id AND other.id <> NEW.id AND other.status NOT IN ('done', 'failed', 'stopped', 'exited')
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'attempts: el Worktree no existe, es de otro Project, no está activo o lo usa otro Attempt vivo');
END;
