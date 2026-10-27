// LXO-123 · Fixture de migración F2 → F3 (pruebas y dogfood). No se importa desde código de producción.
//
// Dogfood: con Desktop abierto en el Orquestador, en la consola de DevTools:
//   localStorage.setItem('lx_ade_selection', JSON.stringify({ projectId: '<project real>', taskId: '<task real>' }))
// y recarga. Con el Core cortado y `legacy_task_v1` en `core_model.compat` debe abrir esa Task con el aviso
// «migrada»; sin `legacy_task_v1`, debe descartarla con el aviso «ya no es compatible». Ninguna lectura escribe.
import { VARIANTS, brief, taskListPage, taskV2 } from './coreModelFixtures';

export const F2_SELECTION = Object.freeze({ projectId: 'p-1', taskId: 't3' });
export const F2_SELECTION_V1 = Object.freeze({ v: 1, projectId: 'p-1', taskId: 't3' });
export const F2_SELECTION_BROKEN = Object.freeze({ taskId: 't3' });

export const CORE_MODEL_COMPAT_OPEN = Object.freeze({ core_model: 'task_attempt_v1', compat: ['legacy_task_v1'], queries: ['task_list_v2', 'task_detail_v2', 'attempts_by_task', 'attempt_detail'], storage: { status: 'ready', code: null, message: null } });
export const CORE_MODEL_COMPAT_CLOSED = Object.freeze({ ...CORE_MODEL_COMPAT_OPEN, compat: [] });
export const CORE_MODEL_LEGACY = VARIANTS.coreModelLegacy;
/** Lo que responde `core_model` con el almacén rechazado (model_read.rs): legacy, compat vacío, storage rejected. */
export const CORE_MODEL_REJECTED = Object.freeze({ core_model: 'legacy', compat: [], queries: [], storage: { status: 'rejected', code: 'core_cut_legacy_numbering', message: 'core_cut_legacy_numbering: restaura pre-f3-cut' } });
/** Antes del corte (model_read.rs): legacy con compat vacío y almacén listo. */
export const CORE_MODEL_LEGACY_READY = Object.freeze({ core_model: 'legacy', compat: [], queries: [], storage: { status: 'ready', code: null, message: null } });

/** F2 ve t3, t5, t8 y t11; tras el corte t8 está descartada y `task_list_v2` (completa) solo trae t3 y t5. t11 está
 * viva y es posterior a la lectura de `task_list_v2`: no se oculta. */
export const F2_TASK_ROWS = Object.freeze([{ id: 't3', status: 'running' }, { id: 't5', status: 'done' }, { id: 't8', status: 'stopped' }, { id: 't11', status: 'running' }]);
export const V2_OPEN_PAGE = taskListPage([taskV2('t3', [brief('t3', 1, 'running')]), taskV2('t5', [])]);
export const V2_PARTIAL_PAGE = { ...V2_OPEN_PAGE, next_cursor: 't3:1:t5' };

export const ATTENTION_ATTEMPT_TARGET = Object.freeze({ kind: 'attempt', id: 't3-a2', projectId: 'p-1' });
export const ACTIVITY_ATTEMPT_TARGET = Object.freeze({ kind: 'attempt', id: 't3-a1', projectId: 'p-1' });
