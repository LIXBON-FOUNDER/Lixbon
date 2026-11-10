/**
 * Contrato cliente de `attempt_proof_pack` (LXO-147/155, docs/core/PROOF_PACK.md): la evidencia de un Attempt antes del diff, con la
 * procedencia de cada dato y lo que la persona puede decidir ahora. La interfaz muestra lo que el Core dice y manda a aceptar EXACTAMENTE el
 * `decision.head_commit` que recibió. Una respuesta fuera del contrato se rechaza entera.
 */
import { PROVENANCE } from './compareContract';

export const ACCEPTANCE_STATES = Object.freeze(['none', 'accepted', 'stale', 'rejected']);
export const COMPLETENESS = Object.freeze(['complete', 'partial']);
/** Por qué no se puede decidir ahora (conjunto cerrado del Core). */
export const DECISION_BLOCKS = Object.freeze(['pending_approval', 'not_current_attempt', 'not_final', 'no_revision']);

const invalid = (detail) => new Error(`ade_query_invalid_response: attempt_proof_pack: ${detail}`);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.length > 0;

function evidence(e, where) {
  if (!isObject(e) || !PROVENANCE.includes(e.provenance)) throw invalid(`${where}: procedencia fuera del contrato`);
  if (e.provenance === 'unknown') {
    if (e.value !== null || !isText(e.reason)) throw invalid(`${where}: un dato sin procedencia es null y trae su motivo`);
  } else if (e.reason !== undefined || e.value === null || e.value === undefined) {
    throw invalid(`${where}: un dato con procedencia trae valor y no trae motivo`);
  }
}

export function validateProofPack(response, args) {
  if (!isObject(response)) throw invalid('la respuesta no es un objeto');
  if (response.v !== 1) throw invalid('versión de contrato desconocida');
  if (response.attempt_id !== args.attempt_id) throw invalid('el Proof Pack no corresponde al Attempt solicitado');
  if (!isText(response.task_id) || typeof response.is_current !== 'boolean') throw invalid('identidad inválida');
  for (const f of ['status', 'objective', 'summary', 'tests']) evidence(response[f], f);
  if (!isObject(response.revision)) throw invalid('revision inválida');
  evidence(response.revision.base_commit, 'revision.base_commit');
  evidence(response.revision.head_commit, 'revision.head_commit');
  const c = response.changes;
  if (!isObject(c) || !Array.isArray(c.list) || typeof c.truncated !== 'boolean') throw invalid('changes inválido');
  for (const f of ['files', 'additions', 'deletions']) evidence(c[f], `changes.${f}`);
  if (c.files.provenance === 'unknown' && c.list.length > 0) throw invalid('changes: hay archivos pero no se sabe cuántos');
  const a = response.artifacts;
  if (!isObject(a) || !PROVENANCE.includes(a.provenance) || !Array.isArray(a.items)) throw invalid('artifacts inválidos');
  if (a.provenance === 'unknown' && (a.items.length > 0 || !isText(a.reason))) throw invalid('artifacts: sin procedencia no hay artefactos y hay motivo');
  const acc = response.acceptance;
  if (!isObject(acc) || !ACCEPTANCE_STATES.includes(acc.state)) throw invalid('acceptance fuera del contrato');
  if (acc.state !== 'none' && (!isText(acc.decided_head) || typeof acc.head_matches !== 'boolean')) throw invalid('acceptance: falta la revisión decidida');
  // Una aceptación vigente es de este HEAD y una stale no lo es: lo contrario sería aceptar lo que no se vio.
  if (acc.state === 'accepted' && acc.head_matches !== true) throw invalid('acceptance: una aceptación vigente es de este HEAD');
  if (acc.state === 'stale' && acc.head_matches !== false) throw invalid('acceptance: una aceptación stale no es de este HEAD');
  const d = response.decision;
  if (!isObject(d) || typeof d.can_decide !== 'boolean') throw invalid('decision inválida');
  if (d.can_decide) {
    // Solo se decide sobre un HEAD concreto, y ese es el que viaja.
    if (!isText(d.head_commit) || d.head_commit !== response.revision.head_commit.value) throw invalid('decision: el HEAD que se decide es el de la revisión mostrada');
  } else if (!DECISION_BLOCKS.includes(d.reason) || d.head_commit !== null) {
    throw invalid('decision: sin decisión posible trae su motivo y ningún HEAD');
  }
  if (!isObject(response.completeness) || !COMPLETENESS.includes(response.completeness.state) || !Array.isArray(response.completeness.gaps)) throw invalid('completeness inválida');
  return response;
}

/** Petición y validación de la query. Se fusionan en la tabla de `coreQueries.js`. */
export const PROOF_PACK_QUERY_SPECS = Object.freeze({
  attempt_proof_pack: {
    request: (args) => {
      if (typeof args?.attemptId !== 'string' || !args.attemptId.trim()) throw new Error('ade_query_invalid_request: attempt_proof_pack exige attempt_id');
      return { attempt_id: args.attemptId };
    },
    validate: validateProofPack,
  },
});
