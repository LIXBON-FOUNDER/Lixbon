-- 011_reviews: Review targeting (LXO-118, épica F3). Contrato: docs/core/REVIEWS.md.
--
-- UNA responsabilidad: que toda revisión apunte a una ejecución y a una revisión concretas, (Attempt, head_commit), y
-- no a la Task. Las decisiones de la persona (`decisions`) llegan aquí con su forma del corte; la revisión es una de
-- ellas (`reviews.decision_id`).
--
-- Se aplica DESPUÉS de la 010 y de la valla. INERTE HASTA EL CORTE, como 007..010.
--
-- Decisiones:
--   * TARGET = (attempt_id, head_commit) y la base observada (`base_commit`). La revisión de un Attempt no dice nada de
--     otro de la misma Task (ADR D8).
--   * A LO SUMO UNA ACTIVA POR ATTEMPT: una revisión nueva deja `superseded` la anterior; si el HEAD observado cambia,
--     la activa pasa a `stale` (con el HEAD que se vio). Ninguna vuelve a `active`: reabrir es revisar otra vez.
--   * HISTORIA INMUTABLE: `decisions` no se modifica ni se borra; de `reviews` solo cambia su estado, una vez.

CREATE TABLE decisions (
  id          INTEGER PRIMARY KEY,            -- id legacy conservado (los eventos lo citan); los nuevos, max + 1
  task_id     TEXT    NOT NULL REFERENCES tasks (id),
  attempt_id  TEXT    REFERENCES attempts (id),
  kind        TEXT    NOT NULL,
  actor       TEXT    NOT NULL,
  detail_json TEXT    CHECK (detail_json IS NULL OR json_valid(detail_json)),
  at          INTEGER NOT NULL
) STRICT;

CREATE TABLE reviews (
  decision_id   INTEGER PRIMARY KEY REFERENCES decisions (id),
  attempt_id    TEXT    NOT NULL REFERENCES attempts (id),
  head_commit   TEXT    NOT NULL CHECK (length(head_commit) BETWEEN 4 AND 64),
  base_commit   TEXT    CHECK (base_commit IS NULL OR length(base_commit) BETWEEN 4 AND 64),
  verdict       TEXT    NOT NULL CHECK (verdict IN ('accepted', 'rejected')),
  at            INTEGER NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'superseded')),
  observed_head TEXT    CHECK (observed_head IS NULL OR length(observed_head) BETWEEN 4 AND 64),
  closed_at     INTEGER,
  CHECK ((status = 'stale') = (observed_head IS NOT NULL)),
  CHECK ((status = 'active') = (closed_at IS NULL))
) STRICT;

CREATE INDEX decisions_by_attempt ON decisions (attempt_id, kind, id);
CREATE INDEX reviews_by_attempt ON reviews (attempt_id, decision_id);
CREATE UNIQUE INDEX reviews_one_active ON reviews (attempt_id) WHERE status = 'active';

-- ── Inerte hasta el corte ──

CREATE TRIGGER decisions_inert_insert BEFORE INSERT ON decisions
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'decisions está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER reviews_inert_insert BEFORE INSERT ON reviews
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'reviews está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

CREATE TRIGGER reviews_inert_update BEFORE UPDATE ON reviews
WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agentic_model')
BEGIN
  SELECT RAISE(ABORT, 'reviews está inerte hasta el corte Task/Attempt (falta meta.agentic_model)');
END;

-- ── Historia inmutable ──

CREATE TRIGGER decisions_immutable BEFORE UPDATE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions: una decisión es historia: no se modifica');
END;

CREATE TRIGGER decisions_no_delete BEFORE DELETE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions: una decisión es historia: no se borra');
END;

CREATE TRIGGER reviews_no_delete BEFORE DELETE ON reviews
BEGIN
  SELECT RAISE(ABORT, 'reviews conserva la historia: no se borra');
END;

-- Una decisión sobre un Attempt es sobre un Attempt de su Task.
CREATE TRIGGER decisions_attempt_of_task BEFORE INSERT ON decisions
WHEN NEW.attempt_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM attempts WHERE id = NEW.attempt_id AND task_id = NEW.task_id)
BEGIN
  SELECT RAISE(ABORT, 'decisions: el Attempt no es de la Task de la decisión');
END;

-- Una revisión es una decisión `review` sobre ese mismo Attempt.
CREATE TRIGGER reviews_of_its_decision BEFORE INSERT ON reviews
WHEN NOT EXISTS (SELECT 1 FROM decisions WHERE id = NEW.decision_id AND kind = 'review' AND attempt_id = NEW.attempt_id)
BEGIN
  SELECT RAISE(ABORT, 'reviews: la revisión es una decisión review sobre el mismo Attempt');
END;

-- Solo cambia el estado, una vez, de `active` a `stale` o `superseded`; el target no cambia nunca.
CREATE TRIGGER reviews_target_immutable BEFORE UPDATE ON reviews
WHEN NEW.decision_id IS NOT OLD.decision_id OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.head_commit IS NOT OLD.head_commit
  OR NEW.base_commit IS NOT OLD.base_commit OR NEW.verdict IS NOT OLD.verdict OR NEW.at IS NOT OLD.at
  OR OLD.status IS NOT 'active' OR NEW.status NOT IN ('stale', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'reviews: el target y el veredicto no cambian; solo una revisión activa pasa a stale o superseded');
END;
