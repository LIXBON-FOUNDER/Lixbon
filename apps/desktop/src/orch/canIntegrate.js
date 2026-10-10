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
    Aquí irá también la futura condición de "diff aceptado" por la persona. */
export function canIntegrate(task) {
  if (!task || !task.parent) return false;
  if (task.status !== 'done') return false;
  if (!task.branch) return false;
  if (isMerged(task)) return false;
  return true;
}

export const INTEGRATE_INTO_FALLBACK = 'la rama del coordinador';

/** Destino que manda el host en `integrate_into`; si falta, la rama del padre o el texto genérico. */
export function integrationTarget(task, snap) {
  if (task?.integrate_into) return task.integrate_into;
  const parent = task?.parent ? snap?.tasks?.[task.parent] : null;
  return parent?.branch || INTEGRATE_INTO_FALLBACK;
}
