-- 020 · Claim de despacho de un Attempt (LXO-141, fase 2b).
--
-- Reserva durable de un solo uso: un claim `reserved` se confirma ANTES de cualquier efecto externo, pasa a `started` tras
-- registrar `attempt.started` y, si el Core reinicia con el resultado desconocido, a `ambiguous`: nunca se vuelve a despachar
-- solo. Un Attempt terminal con evidencia canónica asienta el claim (`settled`), incluido el que terminó SIN `attempt.started`
-- (p. ej. `launch_failed`): como `attempt.started` se registra antes de llamar al proveedor, el proveedor nunca se llamó y
-- el claim no debe quedarse `ambiguous` para siempre.
ALTER TABLE attempts ADD COLUMN dispatch_claim TEXT NOT NULL DEFAULT 'none'
  CHECK (dispatch_claim IN ('none', 'reserved', 'started', 'ambiguous', 'settled'));
CREATE INDEX attempts_dispatch_claim ON attempts (dispatch_claim, status);

-- Historical rows remain 'none'; callers must only dispatch after acquiring a
-- fresh reserved claim. Startup reconciliation may move reserved -> ambiguous.
CREATE TRIGGER attempts_dispatch_claim_lifecycle
BEFORE UPDATE OF dispatch_claim ON attempts
WHEN NOT (
  (OLD.dispatch_claim = 'none' AND NEW.dispatch_claim = 'reserved'
    AND OLD.status = 'starting' AND NEW.status = 'starting')
  OR (OLD.dispatch_claim = 'reserved' AND NEW.dispatch_claim = 'started'
    AND OLD.status IN ('starting','running') AND NEW.status = OLD.status)
  OR (OLD.dispatch_claim IN ('reserved','started') AND NEW.dispatch_claim = 'ambiguous'
    AND NEW.status = OLD.status)
  OR (OLD.dispatch_claim IN ('reserved','started','ambiguous') AND NEW.dispatch_claim = 'settled'
    AND OLD.status IN ('done','failed','stopped','exited') AND NEW.status = OLD.status)
)
BEGIN
  SELECT RAISE(ABORT, 'attempt_dispatch_claim_lifecycle');
END;

-- A terminal Attempt normally cannot change, but its dispatch claim may still
-- need to settle after the lifecycle result has committed. Keep every existing
-- terminal-row exception intact and permit a claim-only update; the claim
-- trigger above remains responsible for validating the allowed claim transition.
DROP TRIGGER attempts_final_is_final;
CREATE TRIGGER attempts_final_is_final BEFORE UPDATE ON attempts
WHEN OLD.status IN ('done', 'failed', 'stopped', 'exited') AND NOT (
  (
    NEW.dispatch_claim IS NOT OLD.dispatch_claim
    AND NEW.id IS OLD.id AND NEW.task_id IS OLD.task_id AND NEW.n IS OLD.n
    AND NEW.status IS OLD.status AND NEW.external IS OLD.external
    AND NEW.provider IS OLD.provider AND NEW.model IS OLD.model AND NEW.effort IS OLD.effort
    AND NEW.role IS OLD.role AND NEW.profile IS OLD.profile
    AND NEW.worktree_id IS OLD.worktree_id AND NEW.provider_session_id IS OLD.provider_session_id
    AND NEW.summary IS OLD.summary AND NEW.failure_reason IS OLD.failure_reason
    AND NEW.created_at IS OLD.created_at AND NEW.started_at IS OLD.started_at
    AND NEW.ended_at IS OLD.ended_at AND NEW.updated_at IS OLD.updated_at AND NEW.origin IS OLD.origin
    AND NEW.instruction IS OLD.instruction AND NEW.cwd IS OLD.cwd
    AND NEW.checkout_branch IS OLD.checkout_branch AND NEW.policy IS OLD.policy
    AND NEW.ack_unverified IS OLD.ack_unverified AND NEW.requested_argv IS OLD.requested_argv
    AND NEW.plan_mode IS OLD.plan_mode AND NEW.stream_json IS OLD.stream_json
    AND NEW.report_nonce IS OLD.report_nonce AND NEW.delivered IS OLD.delivered
    AND NEW.delivery_channel IS OLD.delivery_channel AND NEW.model_requested IS OLD.model_requested
    AND NEW.model_effective IS OLD.model_effective AND NEW.model_source IS OLD.model_source
    AND NEW.model_mismatch IS OLD.model_mismatch
    AND NEW.model_mismatch_reason IS OLD.model_mismatch_reason
    AND NEW.approval_deadline IS OLD.approval_deadline AND NEW.files IS OLD.files
    AND NEW.integrated IS OLD.integrated AND NEW.launched_at IS OLD.launched_at
    AND NEW.initial_approval_deadline IS OLD.initial_approval_deadline
  )
  OR (
    NEW.dispatch_claim IS OLD.dispatch_claim
    AND NEW.status IS OLD.status AND NEW.integrated >= OLD.integrated
    AND (NEW.integrated > OLD.integrated OR NEW.model_effective IS NOT OLD.model_effective
      OR NEW.model_source IS NOT OLD.model_source OR NEW.model_mismatch IS NOT OLD.model_mismatch
      OR NEW.model_mismatch_reason IS NOT OLD.model_mismatch_reason
      OR NEW.provider_session_id IS NOT OLD.provider_session_id)
    AND NEW.summary IS OLD.summary AND NEW.failure_reason IS OLD.failure_reason
    AND NEW.started_at IS OLD.started_at AND NEW.ended_at IS OLD.ended_at
    AND NEW.worktree_id IS OLD.worktree_id AND NEW.instruction IS OLD.instruction
    AND NEW.cwd IS OLD.cwd AND NEW.checkout_branch IS OLD.checkout_branch AND NEW.policy IS OLD.policy
    AND NEW.ack_unverified IS OLD.ack_unverified AND NEW.requested_argv IS OLD.requested_argv
    AND NEW.plan_mode IS OLD.plan_mode AND NEW.stream_json IS OLD.stream_json
    AND NEW.report_nonce IS OLD.report_nonce AND NEW.delivered IS OLD.delivered
    AND NEW.delivery_channel IS OLD.delivery_channel AND NEW.model_requested IS OLD.model_requested
    AND NEW.approval_deadline IS OLD.approval_deadline AND NEW.files IS OLD.files
    AND NEW.launched_at IS OLD.launched_at AND NEW.initial_approval_deadline IS OLD.initial_approval_deadline
  )
)
BEGIN
  SELECT RAISE(ABORT, 'attempts: un Attempt final no se modifica salvo integración, observación tardía o claim de despacho');
END;
