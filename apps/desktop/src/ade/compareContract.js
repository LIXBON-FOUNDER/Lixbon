/**
 * Contrato cliente de `attempt_compare` (LXO-146/154, docs/core/COMPARE.md): 2–4 Attempts comparables, cada dato con su procedencia. La
 * interfaz muestra lo que el Core dice: no recalcula git ni pruebas y no convierte un dato que falta en un cero. Una respuesta fuera del
 * contrato se rechaza entera.
 */

/** Cómo se sabe un dato. `verified` lo comprobó el Core; `agent_reported` lo declaró el agente; `unknown` no hay dato. */
export const PROVENANCE = Object.freeze(['verified', 'agent_reported', 'unknown']);
/** Qué une a los Attempts comparados. */
export const RELATIONS = Object.freeze(['same_task', 'fork_family']);
export const MIN_COMPARED = 2;
export const MAX_COMPARED = 4;

const invalid = (detail) => new Error(`ade_query_invalid_response: attempt_compare: ${detail}`);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.length > 0;

/** `{ value, provenance, reason? }`: lo que falta es `unknown` con `value: null` y su motivo; lo que hay, nunca lleva motivo. */
function validateEvidence(e, where) {
  if (!isObject(e)) throw invalid(`${where}: no es un objeto`);
  if (!PROVENANCE.includes(e.provenance)) throw invalid(`${where}: procedencia «${String(e.provenance)}» fuera del contrato`);
  if (e.provenance === 'unknown') {
    if (e.value !== null || !isText(e.reason)) throw invalid(`${where}: un dato sin procedencia es null y trae su motivo`);
  } else if (e.reason !== undefined || e.value === null || e.value === undefined) {
    throw invalid(`${where}: un dato con procedencia trae valor y no trae motivo`);
  }
}

function validateAttempt(a, i) {
  const where = `attempts[${i}]`;
  if (!isObject(a)) throw invalid(`${where}: no es un objeto`);
  if (!isText(a.attempt_id) || !isText(a.task_id) || !Number.isSafeInteger(a.n) || a.n < 1) throw invalid(`${where}: identidad inválida`);
  if (typeof a.is_current !== 'boolean') throw invalid(`${where}: falta is_current`);
  if (a.forked_from !== null && !isText(a.forked_from)) throw invalid(`${where}: forked_from inválido`);
  for (const field of ['selection', 'status', 'timing', 'host', 'worktree', 'summary', 'tests', 'review']) validateEvidence(a[field], `${where}.${field}`);
  if (!isObject(a.revision) || !(a.revision.source === null || isText(a.revision.source))) throw invalid(`${where}.revision: inválida`);
  validateEvidence(a.revision.base_commit, `${where}.revision.base_commit`);
  validateEvidence(a.revision.head_commit, `${where}.revision.head_commit`);
  const c = a.changes;
  if (!isObject(c) || !Array.isArray(c.list) || typeof c.truncated !== 'boolean') throw invalid(`${where}.changes: inválido`);
  for (const field of ['files', 'additions', 'deletions']) validateEvidence(c[field], `${where}.changes.${field}`);
  // Una lista de archivos solo existe si el número de archivos se conoce.
  if (c.files.provenance === 'unknown' && c.list.length > 0) throw invalid(`${where}.changes: hay archivos pero no se sabe cuántos`);
  for (const f of c.list) {
    if (!isObject(f) || !isText(f.path)) throw invalid(`${where}.changes.list: archivo inválido`);
  }
  const art = a.artifacts;
  if (!isObject(art) || !PROVENANCE.includes(art.provenance) || !Array.isArray(art.items)) throw invalid(`${where}.artifacts: inválidos`);
  if (art.provenance === 'unknown' && (art.items.length > 0 || !isText(art.reason))) throw invalid(`${where}.artifacts: sin procedencia no hay artefactos y hay motivo`);
}

export function validateAttemptCompare(response, args) {
  if (!isObject(response)) throw invalid('la respuesta no es un objeto');
  if (response.v !== 1) throw invalid('versión de contrato desconocida');
  if (!isObject(response.relation) || !RELATIONS.includes(response.relation.kind) || !isText(response.relation.root)) throw invalid('relation inválida');
  if (!Array.isArray(response.attempts) || response.attempts.length < MIN_COMPARED || response.attempts.length > MAX_COMPARED) throw invalid('attempts fuera de rango');
  response.attempts.forEach(validateAttempt);
  // El Core devuelve los Attempts en el orden pedido: lo contrario sería comparar otra cosa.
  if (response.attempts.map((a) => a.attempt_id).join('\n') !== args.attempt_ids.join('\n')) throw invalid('los Attempts no son los pedidos o no vienen en su orden');
  const o = response.overlaps;
  if (!isObject(o) || typeof o.complete !== 'boolean' || !Number.isSafeInteger(o.total) || !Array.isArray(o.items)) throw invalid('overlaps inválido');
  for (const item of o.items) {
    if (!isObject(item) || !isText(item.path) || !Array.isArray(item.attempt_ids) || item.attempt_ids.length < 2) throw invalid('overlaps: un solape lo tocan al menos dos Attempts');
  }
  return response;
}

/** Petición y validación de la query. Se fusionan en la tabla de `coreQueries.js`. */
export const COMPARE_QUERY_SPECS = Object.freeze({
  attempt_compare: {
    request: (args) => {
      const ids = args?.attemptIds;
      if (!Array.isArray(ids) || ids.length < MIN_COMPARED || ids.length > MAX_COMPARED || !ids.every((id) => isText(id)) || new Set(ids).size !== ids.length) {
        throw new Error(`ade_query_invalid_request: attempt_compare exige de ${MIN_COMPARED} a ${MAX_COMPARED} attempt_ids distintos`);
      }
      return { attempt_ids: [...ids] };
    },
    validate: validateAttemptCompare,
  },
});
