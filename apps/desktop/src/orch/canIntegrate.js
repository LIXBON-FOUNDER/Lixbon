// canIntegrate.js — regla única para mostrar "Integrar" en el orquestador y destino a mostrar.

/** ¿La tarea ya está integrada? orch_snapshot manda por tarea
    `last_integration: { outcome, result_commit, at } | null`, sacado de la última decisión `merge`.
    - Objeto: manda su `outcome` (solo 'merged' bloquea; conflict/error no).
    - null: el host dice que no hay ninguna decisión `merge` todavía.
    - undefined (host anterior sin el campo): respaldo en `task.merged`. */
export function isMerged(task) {
  const li = task?.last_integration;
  if (li === undefined) return Boolean(task?.merged);
  return li?.outcome === 'merged';
}

/** Hash corto del commit resultante de la integración, si la hay. */
export function mergedCommitShort(task) {
  const c = task?.last_integration?.outcome === 'merged' ? task.last_integration.result_commit : null;
  return typeof c === 'string' && c ? c.slice(0, 7) : null;
}

/** Visible solo para una tarea hija (no el coordinador), terminada con status 'done',
    con rama y sin integración registrada.
    Revisión de diff: orch_snapshot manda por tarea `last_review: { decision, head_commit, at } | null`.
    Solo cuenta la última revisión (aceptar y luego rechazar el mismo head no integra).
    - Objeto (host con revisión): Integrar exige decision 'accepted' y que last_review.head_commit
      sea task.head_commit. Si falta task.head_commit no se habilita (un diff aceptado sobre
      un head anterior, o sobre un head que no se conoce, no vale).
    - null: todavía no hay revisión, así que no se integra.
    - undefined (host anterior sin el campo): no se exige revisión, como antes. */
export function canIntegrate(task) {
  if (!task || !task.parent) return false;
  if (task.status !== 'done') return false;
  if (!task.branch) return false;
  if (isMerged(task)) return false;
  if (!isReviewAccepted(task)) return false;
  return true;
}

/** Regla de revisión de canIntegrate (ver arriba). */
export function isReviewAccepted(task) {
  const lr = task?.last_review;
  if (lr === undefined) return true;
  if (!lr || lr.decision !== 'accepted') return false;
  if (!task.head_commit || lr.head_commit !== task.head_commit) return false;
  return true;
}

export const INTEGRATE_INTO_FALLBACK = 'la rama del coordinador';

/** Destino de la integración. El host (b2aa870) lo manda en la snapshot como mapa de primer
    nivel `snap.integrate_into[task_id] = { dir, branch }` (no dentro de la tarea). Se acepta
    también `task.integrate_into` (texto u objeto). Si falta, la rama del padre o el texto genérico. */
export function integrationTarget(task, snap) {
  const label = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? v.branch || v.dir || null : null);
  const fromSnap = label(task?.id ? snap?.integrate_into?.[task.id] : null);
  if (fromSnap) return fromSnap;
  const fromTask = label(task?.integrate_into);
  if (fromTask) return fromTask;
  const parent = task?.parent ? snap?.tasks?.[task.parent] : null;
  return parent?.branch || INTEGRATE_INTO_FALLBACK;
}
