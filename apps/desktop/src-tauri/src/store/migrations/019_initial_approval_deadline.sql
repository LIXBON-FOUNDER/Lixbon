-- Durable deadline for the initial pending_approval decision. Distinct from
-- approval_deadline, which belongs to awaiting_terminal_approval.
ALTER TABLE attempts ADD COLUMN initial_approval_deadline INTEGER
  CHECK (initial_approval_deadline IS NULL OR initial_approval_deadline >= created_at);

-- Backfill every historical pending row before installing immutability. STRICT INTEGER
-- rejects REAL results on signed-64-bit overflow and rolls back this whole migration.
UPDATE attempts
SET initial_approval_deadline = created_at + 1800000
WHERE status = 'pending_approval' AND initial_approval_deadline IS NULL;

CREATE TRIGGER attempts_initial_approval_deadline_immutable
BEFORE UPDATE OF initial_approval_deadline ON attempts
WHEN NEW.initial_approval_deadline IS NOT OLD.initial_approval_deadline
BEGIN SELECT RAISE(ABORT, 'initial_approval_deadline es inmutable'); END;
