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

/** Petición y validación de la query. Se fusionan en la tabla de `coreQueries.js`. */
export const RESOURCE_QUERY_SPECS = Object.freeze({
  resource_inspect: {
    request: (args) => {
      if (typeof args?.taskId !== 'string' || !args.taskId.trim()) throw new Error('ade_query_invalid_request: resource_inspect exige task_id');
      return { task_id: args.taskId };
    },
    validate: validateResourceInspect,
  },
});
