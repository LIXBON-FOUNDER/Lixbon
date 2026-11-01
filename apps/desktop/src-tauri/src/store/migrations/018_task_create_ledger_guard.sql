-- INSERT OR REPLACE resolves a key conflict by deleting the existing row first. SQLite only runs the
-- DELETE trigger of that implicit delete when recursive_triggers is ON, and this store does not change
-- that PRAGMA for the whole database. Without this guard, a REPLACE on the idempotency key (or on task_id)
-- would silently overwrite the original ledger row, including its payload hash.
--
-- The guard aborts BEFORE the implicit delete, so it protects the ledger on any connection and without
-- altering the semantics of the rest of the database. It covers the two logical keys of the ledger:
-- (identity_scope, method, request_id) and task_id. It deliberately does not inspect NEW.rowid: SQLite
-- leaves it undefined in a BEFORE INSERT trigger when the caller omits it, so comparing it could reject an
-- ordinary insert. Nothing in the store inserts an explicit rowid.
CREATE TRIGGER task_create_requests_no_replace
BEFORE INSERT ON task_create_requests
WHEN EXISTS (
  SELECT 1 FROM task_create_requests
  WHERE (identity_scope = NEW.identity_scope
    AND method = NEW.method
    AND request_id = NEW.request_id)
    OR task_id = NEW.task_id
)
BEGIN
  SELECT RAISE(ABORT, 'task_create_requests_no_replace');
END;
