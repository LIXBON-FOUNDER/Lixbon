/**
 * Contrato cliente de `attempt_integration_preview` (LXO-148/156, docs/core/INTEGRACION.md): lo que hay que ver ANTES de integrar un Attempt. La
 * interfaz habilita por `can_merge` / `can_publish_pr` (con su motivo) y manda a integrar EXACTAMENTE el `revision.head_commit` que recibió.
 * Una respuesta fuera del contrato se rechaza entera.
 */
export const REVIEW_STATES = Object.freeze(['none', 'accepted', 'stale', 'rejected']);
export const TARGET_KINDS = Object.freeze(['project_checkout', 'parent_checkout']);
/** Por qué no se puede integrar ahora (conjunto cerrado del Core). */
export const BLOCK_REASONS = Object.freeze([
  'not_current_attempt', 'not_final', 'no_branch', 'review_required', 'already_merged', 'already_exists',
  'target_branch_mismatch', 'target_unavailable', 'checkout_dirty', 'no_remote',
]);

const invalid = (detail) => new Error(`ade_query_invalid_response: attempt_integration_preview: ${detail}`);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const textOrNull = (v) => v === null || (typeof v === 'string' && v.length > 0);
const boolOrNull = (v) => v === null || typeof v === 'boolean';

function availability(a, where) {
  if (!isObject(a) || typeof a.ok !== 'boolean') throw invalid(`${where}: inválido`);
  if (a.ok && a.reason !== undefined) throw invalid(`${where}: lo posible no trae motivo`);
  if (!a.ok && !BLOCK_REASONS.includes(a.reason)) throw invalid(`${where}: motivo «${String(a.reason)}» fuera del contrato`);
}

export function validateIntegrationPreview(response, args) {
  if (!isObject(response)) throw invalid('la respuesta no es un objeto');
  if (response.v !== 1) throw invalid('versión de contrato desconocida');
  if (response.attempt_id !== args.attempt_id) throw invalid('la vista previa no corresponde al Attempt solicitado');
  if (typeof response.task_id !== 'string' || typeof response.is_current !== 'boolean') throw invalid('identidad inválida');
  if (!isObject(response.revision) || !textOrNull(response.revision.head_commit)) throw invalid('revision inválida');
  if (!isObject(response.review) || !REVIEW_STATES.includes(response.review.state)) throw invalid('review fuera del contrato');
  if (!isObject(response.merge) || typeof response.merge.merged !== 'boolean' || !textOrNull(response.merge.result_commit)) throw invalid('merge inválido');
  if (!isObject(response.pr) || !textOrNull(response.pr.url) || typeof response.pr.has_remote !== 'boolean') throw invalid('pr inválido');
  const t = response.target;
  if (!isObject(t) || !TARGET_KINDS.includes(t.kind)) throw invalid('target inválido');
  for (const f of ['branch', 'expected_branch', 'head', 'expected_head']) if (!textOrNull(t[f] ?? null)) throw invalid(`target.${f} inválido`);
  for (const f of ['branch_matches', 'moved', 'clean']) if (!boolOrNull(t[f] ?? null)) throw invalid(`target.${f} inválido`);
  availability(response.can_merge, 'can_merge');
  availability(response.can_publish_pr, 'can_publish_pr');
  // Lo que ya se integró no se vuelve a ofrecer, y nada se ofrece sin una revisión aceptada sobre el HEAD que se ve.
  if (response.merge.merged && response.can_merge.ok) throw invalid('lo ya integrado no se ofrece otra vez');
  if ((response.can_merge.ok || response.can_publish_pr.ok) && (response.review.state !== 'accepted' || response.revision.head_commit === null)) {
    throw invalid('solo se ofrece integrar una revisión aceptada sobre un HEAD concreto');
  }
  return response;
}

/** Petición y validación de la query. Se fusionan en la tabla de `coreQueries.js`. */
export const INTEGRATION_QUERY_SPECS = Object.freeze({
  attempt_integration_preview: {
    request: (args) => {
      if (typeof args?.attemptId !== 'string' || !args.attemptId.trim()) throw new Error('ade_query_invalid_request: attempt_integration_preview exige attempt_id');
      return { attempt_id: args.attemptId };
    },
    validate: validateIntegrationPreview,
  },
});
