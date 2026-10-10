// canIntegrate.js — regla única para mostrar "Integrar" en el orquestador y destino a mostrar.

const outcomeOf = (d) => {
  if (d?.outcome) return d.outcome;
  try { return JSON.parse(d?.detail_json || '{}').outcome; } catch { return undefined; }
};

/** ¿Ya hay una decisión registrada que integró esta tarea? Usa snap.decisions (forma de la
    tabla `decisions`: kind, task, detail_json con outcome) si el snapshot la expone; hoy
    orch_snapshot NO la expone, así que el respaldo es el campo `task.merged` del snapshot. */
export function isMerged(task, snap) {
  if (Array.isArray(snap?.decisions)) {
    if (snap.decisions.some((d) => d.task === task.id && d.kind === 'merge' && outcomeOf(d) === 'merged')) return true;
  }
  return Boolean(task.merged);
}

/** Visible solo para una tarea hija (no el coordinador), terminada con status 'done',
    con rama y sin integración registrada.
    Aquí irá también la futura condición de "diff aceptado" por la persona. */
export function canIntegrate(task, snap) {
  if (!task || !task.parent) return false;
  if (task.status !== 'done') return false;
  if (!task.branch) return false;
  if (isMerged(task, snap)) return false;
  return true;
}

export const INTEGRATE_INTO_FALLBACK = 'la rama del coordinador';

/** Destino que manda el host en `integrate_into`; si falta, la rama del padre o el texto genérico. */
export function integrationTarget(task, snap) {
  if (task?.integrate_into) return task.integrate_into;
  const parent = task?.parent ? snap?.tasks?.[task.parent] : null;
  return parent?.branch || INTEGRATE_INTO_FALLBACK;
}
