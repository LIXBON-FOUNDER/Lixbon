/**
 * Contrato cliente de `resource_inspect` (LXO-149/157, docs/core/RESOURCES.md § Acciones): el estado físico y de git del worktree de una Task y
 * qué acciones valen ahora, con su motivo. La interfaz ofrece solo lo que el Core dice que se puede y vuelve a leerlo tras actuar: no parchea
 * la autoridad localmente. Un estado desconocido nunca habilita lo destructivo. Una respuesta fuera del contrato se rechaza entera.
 */
export const WORKTREE_STATES = Object.freeze(['none', 'present', 'missing', 'unknown']);
export const MERGED_STATES = Object.freeze(['integrated', 'not_merged', 'unknown']);
export const ACTION_BLOCKS = Object.freeze(['degraded', 'running', 'unknown', 'dirty', 'not_merged', 'nothing_to_do', 'no_worktree']);

const invalid = (detail) => new Error(`ade_query_invalid_response: resource_inspect: ${detail}`);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const boolOrNull = (v) => v === null || typeof v === 'boolean';
const textOrNull = (v) => v === null || (typeof v === 'string' && v.length > 0);

function action(a, where, withDiscard = false) {
  if (!isObject(a) || typeof a.ok !== 'boolean') throw invalid(`${where}: inválida`);
  if (a.ok) {
    if (a.reason !== undefined) throw invalid(`${where}: lo posible no trae motivo`);
    if (withDiscard && typeof a.discards_uncommitted !== 'boolean') throw invalid(`${where}: falta si descarta cambios`);
  } else if (!ACTION_BLOCKS.includes(a.reason)) {
    throw invalid(`${where}: motivo «${String(a.reason)}» fuera del contrato`);
  }
}

export function validateResourceInspect(response, args) {
  if (!isObject(response)) throw invalid('la respuesta no es un objeto');
  if (response.v !== 1) throw invalid('versión de contrato desconocida');
  if (response.task_id !== args.task_id) throw invalid('el recurso no corresponde a la Task solicitada');
  const w = response.worktree;
  if (!isObject(w) || !WORKTREE_STATES.includes(w.state) || !textOrNull(w.path) || !boolOrNull(w.dirty)) throw invalid('worktree inválido');
  // «Sucio» solo se sabe de un worktree que está.
  if (w.state !== 'present' && w.dirty !== null) throw invalid('worktree: no se conoce la suciedad de lo que no está');
  const b = response.branch;
  if (!isObject(b) || !textOrNull(b.name) || !boolOrNull(b.exists) || !textOrNull(b.base)) throw invalid('branch inválida');
  if (b.merged !== null && !MERGED_STATES.includes(b.merged)) throw invalid('branch.merged fuera del contrato');
  if (!isObject(response.process) || typeof response.process.running !== 'boolean') throw invalid('process inválido');
  if (!isObject(response.health) || typeof response.health.writable !== 'boolean') throw invalid('health inválido');
  const a = response.actions;
  if (!isObject(a)) throw invalid('actions inválidas');
  action(a.clean, 'actions.clean');
  action(a.delete_worktree, 'actions.delete_worktree', true);
  // Lo destructivo no se ofrece si el Core no puede registrarlo, si el proceso vive o si no se sabe el estado.
  const destructive = [a.clean, a.delete_worktree].filter((x) => x.ok);
  if (destructive.length && (!response.health.writable || response.process.running || w.state === 'unknown')) throw invalid('se ofrece una acción destructiva que el estado no permite');
  // (Con la rama ya borrada no hay nada que integrar: limpiar solo anota.)
  if (a.clean.ok && b.merged !== 'integrated' && b.name !== null && b.exists !== false) throw invalid('se ofrece limpiar una rama que no consta integrada');
  return response;
}

/** Por qué un worktree externo no se puede adoptar (`resource_adopt_preview.adopt.code`, docs/core/RESOURCES.md § Adoptar). */
export const ADOPT_BLOCKS = Object.freeze([
  'adopt_unknown', 'adopt_not_a_worktree', 'adopt_main_checkout', 'adopt_missing', 'adopt_detached', 'adopt_already_owned', 'adopt_branch_taken',
  'adopt_dirty', 'adopt_no_base', 'adopt_is_base', 'adopt_degraded', 'adopt_no_task',
]);

const adoptInvalid = (detail) => new Error(`ade_query_invalid_response: resource_adopt_preview: ${detail}`);

/**
 * `resource_adopt_preview`: qué es un worktree externo y a qué Tasks se puede adoptar. Se ofrece adoptar SOLO si el Core dice `ok` y hay a qué Task;
 * lo demás llega con un código cerrado. Una respuesta incoherente (adoptable sin rama, sin Tasks o con el Core en solo lectura) se rechaza entera.
 */
export function validateResourceAdoptPreview(response, args) {
  if (!isObject(response)) throw adoptInvalid('la respuesta no es un objeto');
  if (response.v !== 1) throw adoptInvalid('versión de contrato desconocida');
  if (response.project_id !== args.project_id || response.path !== args.path) throw adoptInvalid('la respuesta no corresponde al worktree solicitado');
  if (!textOrNull(response.branch) || !textOrNull(response.base)) throw adoptInvalid('rama o base inválidas');
  if (!isObject(response.health) || typeof response.health.writable !== 'boolean') throw adoptInvalid('health inválido');
  if (!Array.isArray(response.tasks)) throw adoptInvalid('tasks inválidas');
  for (const t of response.tasks) {
    if (!isObject(t) || typeof t.task_id !== 'string' || !t.task_id || typeof t.title !== 'string') throw adoptInvalid('una Task candidata es inválida');
  }
  const a = response.adopt;
  if (!isObject(a) || typeof a.ok !== 'boolean') throw adoptInvalid('adopt inválido');
  if (a.ok) {
    if (a.code !== undefined) throw adoptInvalid('lo posible no trae código');
    if (response.branch === null || response.base === null) throw adoptInvalid('se ofrece adoptar sin rama ni base');
    if (!response.health.writable) throw adoptInvalid('se ofrece adoptar con el Core en solo lectura');
    if (response.tasks.length === 0) throw adoptInvalid('se ofrece adoptar sin una Task que lo reciba');
  } else if (!ADOPT_BLOCKS.includes(a.code) || typeof a.message !== 'string') {
    throw adoptInvalid(`código «${String(a.code)}» fuera del contrato`);
  }
  return response;
}

/** Petición y validación de la query. Se fusionan en la tabla de `coreQueries.js`. */
export const RESOURCE_QUERY_SPECS = Object.freeze({
  resource_adopt_preview: {
    request: (args) => {
      if (typeof args?.projectId !== 'string' || !args.projectId.trim()) throw new Error('ade_query_invalid_request: resource_adopt_preview exige project_id');
      if (typeof args?.path !== 'string' || !args.path.trim()) throw new Error('ade_query_invalid_request: resource_adopt_preview exige path');
      return { project_id: args.projectId, path: args.path };
    },
    validate: validateResourceAdoptPreview,
  },
  resource_inspect: {
    request: (args) => {
      if (typeof args?.taskId !== 'string' || !args.taskId.trim()) throw new Error('ade_query_invalid_request: resource_inspect exige task_id');
      return { task_id: args.taskId };
    },
    validate: validateResourceInspect,
  },
});
