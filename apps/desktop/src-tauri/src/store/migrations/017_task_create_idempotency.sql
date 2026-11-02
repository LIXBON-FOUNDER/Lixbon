-- Durable idempotency ledger for task.create. Deliberately after the F3 cut barrier:
-- this must not establish a second authority while legacy_state is authoritative.
CREATE TABLE task_create_requests (
  identity_scope TEXT NOT NULL CHECK (length(identity_scope) BETWEEN 1 AND 256),
  method TEXT NOT NULL CHECK (method = 'task.create'),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 64 AND request_id NOT GLOB '*[^A-Za-z0-9_.-]*'),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  run_id TEXT NOT NULL REFERENCES runs(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_id TEXT REFERENCES attempts(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (identity_scope, method, request_id),
  UNIQUE (task_id)
) STRICT;

CREATE TRIGGER task_create_requests_inert_insert BEFORE INSERT ON task_create_requests
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN SELECT RAISE(ABORT, 'task_create_requests está inerte hasta el corte Task/Attempt'); END;
CREATE TRIGGER task_create_requests_immutable_update BEFORE UPDATE ON task_create_requests
BEGIN SELECT RAISE(ABORT, 'task_create_requests es inmutable'); END;
CREATE TRIGGER task_create_requests_no_delete BEFORE DELETE ON task_create_requests
BEGIN SELECT RAISE(ABORT, 'task_create_requests no se borra'); END;
