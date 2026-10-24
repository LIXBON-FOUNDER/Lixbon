-- 013_runtime_tables: lo que el runtime necesita para persistir en las tablas Task/Attempt (LXO-232, épica F3).
-- Contrato: docs/core/RUNTIME_TABLAS.md.
--
-- Se aplica DESPUÉS de la 012 y de la valla. INERTE HASTA EL CORTE, como 007..012: solo cambia triggers y añade una
-- columna; ninguna fila se escribe hasta que exista `meta.agentic_model`.
--
-- Al pasar el runtime a las tablas aparecen hechos legítimos que el esquema de 008..012 no admitía:
--
--   * LANZAMIENTO (`launched_at`): cuándo arrancó el proceso del Attempt. No es `started_at` (cuándo pasó a `running`
--     en el ciclo de vida): una raíz externa corre sin proceso lanzado por Lixbon. En las filas `legacy` del corte el
--     lanzamiento ya está en `started_at` y esta columna queda NULL.
--   * OBSERVACIÓN TARDÍA en un Attempt final: Codex declara su sesión y su modelo en el rollout, que se lee al salir el
--     proceso, después del cierre. Se pueden fijar el modelo efectivo, su procedencia y la sesión (una vez); nada más.
--   * INTEGRAR un Attempt final que no es `done`: hoy se integra la rama de una tarea fallida, parada o sin informe.
--   * SESIÓN DECLARADA TARDE: nace `idle` (reanudable) si su Attempt ya terminó.
--   * RAMA BORRADA DESPUÉS: un Worktree quitado conservando la rama pasa a no conservarla cuando `git branch -d` la
--     borra más tarde (tras integrar).
--   * `last_message` es la ruta que `codex exec -o` escribirá: se declara al lanzar, con el Attempt aún `starting`.
--
-- Una migración publicada no se edita: se reemplazan los triggers de 010 y 012 con el mismo nombre.

ALTER TABLE attempts ADD COLUMN launched_at INTEGER CHECK (launched_at IS NULL OR launched_at >= 0);

-- ── Un final sigue siendo final, salvo la integración y la observación tardía ──

DROP TRIGGER attempts_final_is_final;

-- Admite el UPDATE solo si cambia algo admitido (integrar, el modelo efectivo y su procedencia, la sesión una vez) y nada
-- más: repetir el estado o tocar solo `updated_at` sigue sin admitirse.
CREATE TRIGGER attempts_final_is_final BEFORE UPDATE ON attempts
WHEN OLD.status IN ('done', 'failed', 'stopped', 'exited') AND NOT (
  NEW.status IS OLD.status AND NEW.integrated >= OLD.integrated
  AND (NEW.integrated > OLD.integrated OR NEW.model_effective IS NOT OLD.model_effective OR NEW.model_source IS NOT OLD.model_source
    OR NEW.model_mismatch IS NOT OLD.model_mismatch OR NEW.model_mismatch_reason IS NOT OLD.model_mismatch_reason
    OR NEW.provider_session_id IS NOT OLD.provider_session_id)
  AND NEW.summary IS OLD.summary AND NEW.failure_reason IS OLD.failure_reason AND NEW.started_at IS OLD.started_at
  AND NEW.ended_at IS OLD.ended_at AND NEW.worktree_id IS OLD.worktree_id
  AND NEW.instruction IS OLD.instruction AND NEW.cwd IS OLD.cwd AND NEW.checkout_branch IS OLD.checkout_branch
  AND NEW.policy IS OLD.policy AND NEW.ack_unverified IS OLD.ack_unverified AND NEW.requested_argv IS OLD.requested_argv
  AND NEW.plan_mode IS OLD.plan_mode AND NEW.stream_json IS OLD.stream_json AND NEW.report_nonce IS OLD.report_nonce
  AND NEW.delivered IS OLD.delivered AND NEW.delivery_channel IS OLD.delivery_channel
  AND NEW.model_requested IS OLD.model_requested AND NEW.approval_deadline IS OLD.approval_deadline
  AND NEW.files IS OLD.files AND NEW.launched_at IS OLD.launched_at
)
BEGIN
  SELECT RAISE(ABORT, 'attempts: un Attempt final no se modifica (solo se integra o se completa su modelo y su sesión)');
END;

-- ── Sesión declarada después del cierre ──

DROP TRIGGER provider_sessions_core_create;

-- Una sesión del Core la abre un Attempt de su Task y de su mismo proveedor: nace `open` si el Attempt sigue activo,
-- `idle` si ya terminó (la sesión se declaró al leer el rollout tras la salida).
CREATE TRIGGER provider_sessions_core_create BEFORE INSERT ON provider_sessions
WHEN NEW.origin = 'core' AND NOT EXISTS (
  SELECT 1 FROM attempts AS a
  WHERE a.id = NEW.opened_by_attempt_id AND a.task_id = NEW.task_id AND a.provider = NEW.provider
    AND ((NEW.status = 'open' AND a.status NOT IN ('done', 'failed', 'stopped', 'exited'))
      OR (NEW.status = 'idle' AND a.status IN ('done', 'failed', 'stopped', 'exited')))
)
BEGIN
  SELECT RAISE(ABORT, 'provider_sessions: una sesión del Core la abre un Attempt de su Task y de su proveedor: abierta si sigue activo, en espera si ya terminó');
END;

-- ── Rama borrada después de quitar el Worktree ──

DROP TRIGGER worktrees_removed_is_final;

CREATE TRIGGER worktrees_removed_is_final BEFORE UPDATE ON worktrees
WHEN OLD.state = 'removed' AND NOT (
  NEW.state = 'removed' AND OLD.branch_kept = 1 AND NEW.branch_kept = 0
  AND NEW.removed_reason IS OLD.removed_reason AND NEW.missing_since IS OLD.missing_since
)
BEGIN
  SELECT RAISE(ABORT, 'worktrees: un Worktree quitado no se modifica (solo deja de conservar su rama)');
END;

-- ── La ruta de `codex exec -o` se declara al lanzar ──

DROP TRIGGER artifacts_core_create;

CREATE TRIGGER artifacts_core_create BEFORE INSERT ON artifacts
WHEN NEW.origin = 'core' AND NOT EXISTS (
  SELECT 1 FROM attempts
  WHERE id = NEW.attempt_id
    AND (status NOT IN ('pending_approval', 'starting') OR (status = 'starting' AND NEW.kind = 'last_message'))
)
BEGIN
  SELECT RAISE(ABORT, 'artifacts: un Artifact del Core es de un Attempt que ya arrancó (la ruta de last_message, desde que se lanza)');
END;
