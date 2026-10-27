/**
 * LXO-123 · Navegación tras el corte Task/Attempt (F3). Funciones PURAS: no consultan ni mutan el Core.
 *
 * - Migración de la selección guardada F2 (`{projectId, taskId}` sin `v`): el corte conserva el ID de cada Task
 *   (los Attempts son `<task>-a<n>`), así que la Task F2 se abre como la misma Task. Nunca se convierte en un
 *   Attempt ni se reutiliza para otra entidad.
 * - Valores reales de `core_model` (model_read.rs): `legacy` (LEGACY_MODEL) antes del corte o con el almacén
 *   rechazado, y `task_attempt_v1` (AGENTIC_MODEL, store/tasks.rs) tras el corte, el único con
 *   `compat: ["legacy_task_v1"]`.
 * - Compatibility shim: la migración automática solo vale mientras el Core declare `legacy_task_v1` en
 *   `core_model.compat`. Criterio de retirada: cuando el Core cierre la ventana (compat sin `legacy_task_v1`), lo
 *   guardado F2 se invalida con aviso; cuando ya no queden instalaciones F2, este módulo puede retirarse entero.
 * - Destinos de Activity/Attention: un único paso de resolución, sin redirecciones encadenadas (idempotente).
 */

export const LEGACY_COMPAT = 'legacy_task_v1';

const durable = (value) => (typeof value === 'string' && value.trim() && value.length <= 200 ? value : null);

/** El shim F2 está abierto solo con el modelo vNext y `legacy_task_v1` en `compat`. */
export function legacyShimOpen(coreModel) {
  return Boolean(coreModel?.vNext) && Array.isArray(coreModel.compat) && coreModel.compat.includes(LEGACY_COMPAT);
}

/** Task de un Attempt `<task>-a<n>` (n ≥ 1), o `null`. */
export function attemptTaskId(attemptId) {
  const id = durable(attemptId);
  const match = id && /^(.+)-a([1-9][0-9]*)$/.exec(id);
  return match ? match[1] : null;
}

/**
 * Selección guardada F2 → `{ selection, notice }`, o `null` si aún no se sabe el modelo (no se decide a ciegas).
 * - `selection` es la selección v2 a escribir (siempre se escribe: lo F2 no queda pendiente para otro arranque).
 * - `notice`: `migrated`, `expired`, `invalid`, o `null` si en legacy no hay nada que migrar.
 */
export function migratePersistedSelection(raw, coreModel) {
  if (!raw) return null;
  const mode = coreModel?.mode;
  if (mode !== 'legacy' && mode !== 'task_attempt_v1') return null;
  // Almacén rechazado (`storage.status === 'rejected'`): no se decide nada; lo guardado queda intacto.
  if (coreModel?.storage?.status === 'rejected') return null;
  const projectId = durable(raw.projectId);
  const taskId = projectId ? durable(raw.taskId) : null;
  // Solo se descarta algo con el modelo agéntico: en legacy nunca se tira lo guardado, ni siquiera si está roto.
  if (!projectId) return mode === 'legacy' ? null : { selection: { projectId: null, taskId: null }, notice: 'invalid' };
  // En legacy la forma F2 es la vigente: se reescribe como v2 sin Attempt y sin aviso.
  if (mode === 'legacy') return { selection: { projectId, taskId }, notice: null };
  // Se retira SOLO con core_model agéntico y `compat` sin `legacy_task_v1`.
  if (!legacyShimOpen(coreModel)) return { selection: { projectId: null, taskId: null }, notice: 'expired' };
  return { selection: { projectId, taskId }, notice: 'migrated' };
}

/**
 * Destino `{kind, id, projectId}` de Activity / Attention / Jump → acción, en UN paso:
 * `{action:'select', selection}`, `{action:'reject', reason}` o `{action:'other'}` (run, spawn_request…).
 */
export function resolveNavTarget(target, coreModel) {
  const kind = target?.kind;
  const id = durable(target?.id);
  const projectId = durable(target?.projectId);
  if (kind === 'project') return id ? { action: 'select', selection: { projectId: id, taskId: null } } : { action: 'reject', reason: 'invalid' };
  if (kind === 'task') {
    if (!id) return { action: 'reject', reason: 'invalid' };
    return projectId ? { action: 'select', selection: { projectId, taskId: id } } : { action: 'reject', reason: 'no_project' };
  }
  if (kind === 'attempt') {
    if (!coreModel?.vNext) return { action: 'reject', reason: 'model_inactive' };
    const taskId = attemptTaskId(id);
    if (!taskId) return { action: 'reject', reason: 'invalid_attempt' };
    if (!projectId) return { action: 'reject', reason: 'no_project' };
    return { action: 'select', selection: { projectId, taskId, attemptId: id } };
  }
  return { action: 'other' };
}

/** El destino que representa una selección (para comprobar que resolver no redirige otra vez). */
export function selectionTarget(selection) {
  if (selection?.attemptId) return { kind: 'attempt', id: selection.attemptId, projectId: selection.projectId };
  if (selection?.taskId) return { kind: 'task', id: selection.taskId, projectId: selection.projectId };
  return { kind: 'project', id: selection?.projectId ?? null, projectId: selection?.projectId ?? null };
}

/**
 * IDs de Tasks F2 que son descartadas tras el corte. `task_list_v2` (sin `include_discarded`) devuelve solo las
 * abiertas; con la lista COMPLETA (`next_cursor === null`) de ese Project, una fila F2 que no aparece es descartada.
 * Con lista parcial, de otro Project o sin modelo vNext no se oculta nada (no se adivina). Solo se ocultan Tasks F2
 * en estado final: una Task viva que aún no sale en `task_list_v2` (creada tras su última lectura) nunca se esconde.
 */
const FINAL_TASK_STATUSES = new Set(['done', 'failed', 'stopped', 'exited']);

export function discardedTaskIds(tasks, v2Data, projectId, coreModel) {
  const hidden = new Set();
  if (!coreModel?.vNext || !v2Data || v2Data.project_id !== projectId || v2Data.next_cursor !== null || !Array.isArray(v2Data.items)) return hidden;
  const open = new Set(v2Data.items.map((item) => item?.id).filter((id) => typeof id === 'string'));
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (typeof task?.id === 'string' && FINAL_TASK_STATUSES.has(task.status) && !open.has(task.id)) hidden.add(task.id);
  }
  return hidden;
}
