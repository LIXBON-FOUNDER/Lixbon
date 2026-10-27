// SOLO PARA PRUEBAS. No se importa desde código de producción.
//
// Respuestas canónicas del Core (docs/core/fixtures/api/, LXO-119) tal cual, más VARIANTES LOCALES
// derivadas de ellas para casos que la fixture canónica no cubre (0 y N Attempts, cancelado, último
// fallido, Task descartada, modo legacy y cada código de error). Las variantes son sintéticas y se
// marcan `testOnly: true`; las canónicas no se modifican (lo comprueba coreModelContract.test.js).
import attemptDetailV1 from '../../../../../docs/core/fixtures/api/attempt_detail.v1.json';
import attemptsByTaskV1 from '../../../../../docs/core/fixtures/api/attempts_by_task.v1.json';
import coreModelV1 from '../../../../../docs/core/fixtures/api/core_model.v1.json';
import taskDetailV2 from '../../../../../docs/core/fixtures/api/task_detail_v2.json';
import taskListV2 from '../../../../../docs/core/fixtures/api/task_list_v2.json';

export const CANONICAL = Object.freeze({
  'attempt_detail.v1.json': attemptDetailV1,
  'attempts_by_task.v1.json': attemptsByTaskV1,
  'core_model.v1.json': coreModelV1,
  'task_detail_v2.json': taskDetailV2,
  'task_list_v2.json': taskListV2,
});

const clone = (value) => JSON.parse(JSON.stringify(value));

export const brief = (taskId, n, status, over = {}) => ({
  created_at: 1792000000000 + n * 1000, ended_at: null, external: false, id: `${taskId}-a${n}`, model: null, n,
  provider: 'claude', role: null, started_at: 1792000000500 + n * 1000, status, ...over,
});

export const taskV2 = (id, attempts, over = {}) => ({
  attempt_count: attempts.length,
  created_at: 1792000000000,
  current_attempt: attempts.length ? attempts[attempts.length - 1] : null,
  depth: 0, id, intent: 'open', origin: 'core', parent_task_id: null, project_id: 'p-1', run_id: 'r1',
  state: attempts.length ? 'open' : 'open', title: `Task ${id}`, updated_at: 1792000900000, ...over,
});

/** Variantes locales (sintéticas, solo pruebas). */
export const VARIANTS = Object.freeze({
  testOnly: true,
  coreModelLegacy: { compat: [], core_model: 'legacy', queries: [] },
  // Task sin Attempts, con uno solo y con tres (fallo → cancelación → en curso).
  zero: taskV2('t0', []),
  one: taskV2('t1', [brief('t1', 1, 'done')]),
  many: taskV2('t3', [brief('t3', 1, 'failed'), brief('t3', 2, 'stopped'), brief('t3', 3, 'running', { provider: 'codex', model: 'gpt-6.1-sol' })], { state: 'in_progress' }),
  cancelled: taskV2('t6', [brief('t6', 1, 'stopped', { ended_at: 1792000009000 })]),
  lastFailed: taskV2('t7', [brief('t7', 1, 'done', { ended_at: 1792000003000 }), brief('t7', 2, 'failed', { ended_at: 1792000008000 })]),
  discarded: taskV2('t8', [brief('t8', 1, 'stopped', { ended_at: 1792000004000 })], { intent: 'discarded', state: 'discarded' }),
  unknownStatus: taskV2('t9', [brief('t9', 1, 'paused_by_operator')], { state: 'blocked_somehow' }),
  waiting: taskV2('t10', [brief('t10', 1, 'awaiting_terminal_approval')], { state: 'in_progress' }),
});

export function taskListPage(items, projectId = 'p-1') {
  return { core_model: 'task_attempt_v1', items, next_cursor: null, project_id: projectId, v: 2 };
}

export function attemptsPage(taskId, items) {
  return { core_model: 'task_attempt_v1', items, task_id: taskId, v: 1 };
}

/** Detalle derivado del canónico para otro Attempt, con los cambios dados (solo pruebas). */
export function attemptDetail(over = {}) {
  const response = clone(attemptDetailV1);
  Object.assign(response.attempt, over);
  return response;
}

/** Mensajes de error tal como los emite el Core (model_read.rs) y un Core anterior a LXO-119. */
export const ERRORS = Object.freeze({
  inactive: 'core_model_inactive: el Core aún sirve el modelo legacy; usa tasks_by_project y task_detail',
  notFound: 'model_not_found: no existe la Task t404',
  unavailable: 'model_unavailable: el almacén no está abierto',
  authRequired: 'model_auth_required: solo una Person autenticada puede leer el modelo Task/Attempt',
  invalidRequest: 'model_invalid_request: parámetro desconocido: x',
  unknownCommand: 'Comando desconocido: task_list_v2',
  forbiddenAction: 'Acción no permitida para esta identidad: ForbiddenAction',
});
