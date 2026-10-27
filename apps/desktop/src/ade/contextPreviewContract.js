/**
 * Contrato cliente de `context_package_preview` (LXO-136, docs/core/QUERIES.md § context_package_preview; respuestas de referencia
 * en docs/core/fixtures/api/context_package_preview*.json).
 *
 * Mismo patrón que `coreModelContract.js`: el DTO del Core llega tal cual y aquí solo se COMPRUEBA su forma y su vocabulario. La
 * VERIFICACIÓN del paquete (identidad, versión, secretos) es del Core: este módulo no calcula ningún hash ni busca secretos; solo
 * exige que una respuesta `valid` traiga lo que la vista necesita y que `package_id` coincida con el del documento. Un paquete
 * `invalid` no trae contenido y esta validación lo exige. Sin dependencias de Tauri ni de React.
 */

export const PREVIEW_STATUSES = Object.freeze(['valid', 'invalid']);
/** Conjunto cerrado de motivos de rechazo de `parse` (`PackageErrorCode`). Uno nuevo se rechaza: no se reinterpreta. */
export const PREVIEW_ERROR_CODES = Object.freeze([
  'invalid_json', 'unsupported_version', 'missing_field', 'invalid_field', 'id_mismatch', 'too_large', 'secret_detected', 'attachment_mismatch',
]);
/** Lo que el Core avisa sobre el paquete, siempre en este orden. */
export const PREVIEW_NOTES = Object.freeze(['truncated', 'redacted', 'revision_absent', 'attachment_omitted', 'attachment_not_scanned']);
export const PREVIEW_COMPLETENESS = Object.freeze(['complete', 'partial']);
export const ATTACHMENT_KINDS = Object.freeze(['git_bundle', 'patch', 'file']);
/** Lo máximo que la petición admite (el tope del paquete, 64 KiB, más holgura del sobre). Lo mismo que el Core. */
export const MAX_PREVIEW_REQUEST_BYTES = 128 * 1024;

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => typeof v === 'string';
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const optStr = (v) => v === undefined || v === null || str(v);
const optCount = (v) => v === undefined || v === null || count(v);
const strList = (v) => Array.isArray(v) && v.every(str);
const invalid = (detail) => new Error(`ade_query_invalid_response: context_package_preview: ${detail}`);
const sha = (v) => typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v);

function validateRevision(r) {
  if (r === null) return;
  if (!isRecord(r) || !nonEmpty(r.base_commit) || !nonEmpty(r.head_commit) || !nonEmpty(r.head_tree)) throw invalid('revision incompleta');
  if (!optStr(r.branch) || !optStr(r.diff_sha256) || !optCount(r.diff_bytes)) throw invalid('revision con campos inválidos');
  const files = r.files ?? [];
  if (!Array.isArray(files) || !files.every((f) => isRecord(f) && nonEmpty(f.path) && optCount(f.added) && optCount(f.deleted))) throw invalid('revision.files');
}

function validateUncommitted(u) {
  if (u === undefined || u === null) return;
  if (!isRecord(u) || !optStr(u.staged_patch) || !optStr(u.unstaged_patch)) throw invalid('uncommitted');
  const untracked = u.untracked ?? [];
  if (!Array.isArray(untracked) || !untracked.every((f) => isRecord(f) && nonEmpty(f.path) && str(f.sha256) && count(f.bytes) && optStr(f.attachment))) throw invalid('uncommitted.untracked');
}

function validatePackage(p, id) {
  if (!isRecord(p) || p.schema_version !== 1 || p.package_id !== id) throw invalid('el paquete no es de la versión 1 o su identidad no coincide');
  if (!Number.isSafeInteger(p.created_at_ms)) throw invalid('created_at_ms');
  const s = p.source;
  if (!isRecord(s) || !['project_id', 'task_id', 'attempt_id', 'provider', 'host'].every((k) => nonEmpty(s[k])) || !optStr(s.provider_session)) throw invalid('source incompleto');
  if (!str(p.objective) || !strList(p.decisions) || !strList(p.constraints) || !optStr(p.thread_summary)) throw invalid('objetivo, decisiones o restricciones');
  if (!Object.hasOwn(p, 'revision')) throw invalid('falta revision');
  validateRevision(p.revision);
  if (!optStr(p.revision_absent_reason)) throw invalid('revision_absent_reason');
  validateUncommitted(p.uncommitted);
  const t = p.test_results;
  if (!(t === undefined || t === null || (isRecord(t) && nonEmpty(t.command) && optCount(t.passed) && optCount(t.failed) && optCount(t.ignored)))) throw invalid('test_results');
  const artifacts = p.artifacts ?? [];
  if (!Array.isArray(artifacts) || !artifacts.every((a) => isRecord(a) && nonEmpty(a.kind) && nonEmpty(a.uri) && optCount(a.bytes))) throw invalid('artifacts');
  const attachments = p.attachments ?? [];
  if (!Array.isArray(attachments) || !attachments.every((a) => isRecord(a) && nonEmpty(a.id) && ATTACHMENT_KINDS.includes(a.kind) && str(a.sha256) && count(a.bytes) && typeof a.scanned === 'boolean' && optStr(a.omitted))) throw invalid('attachments');
  const truncated = p.truncated ?? [];
  if (!Array.isArray(truncated) || !truncated.every((x) => isRecord(x) && nonEmpty(x.field) && count(x.original) && ['chars', 'items'].includes(x.unit))) throw invalid('truncated');
  if (!count(p.redactions)) throw invalid('redactions');
}

function validateSummary(s) {
  if (!isRecord(s) || !count(s.serialized_bytes) || !PREVIEW_COMPLETENESS.includes(s.completeness)) throw invalid('summary');
  if (!Array.isArray(s.notes) || !s.notes.every((n) => PREVIEW_NOTES.includes(n))) throw invalid('summary.notes');
  const counts = s.counts;
  const keys = ['decisions', 'constraints', 'files', 'untracked', 'artifacts', 'attachments', 'attachments_omitted', 'attachments_not_scanned', 'attachments_bytes', 'redactions', 'truncated_fields'];
  if (!isRecord(counts) || !keys.every((k) => count(counts[k]))) throw invalid('summary.counts');
}

/** Valida la respuesta de la vista previa. Devuelve el DTO sin tocarlo. */
export function validateContextPreview(response) {
  if (!isRecord(response) || response.v !== 1 || !PREVIEW_STATUSES.includes(response.status)) throw invalid('versión o estado no compatibles');
  if (response.status === 'invalid') {
    const e = response.error;
    if (!isRecord(e) || !PREVIEW_ERROR_CODES.includes(e.code) || !str(e.message)) throw invalid('el rechazo no trae un código del contrato');
    if (!count(response.serialized_bytes)) throw invalid('serialized_bytes');
    if (['package', 'summary', 'package_id'].some((k) => Object.hasOwn(response, k))) throw invalid('un paquete rechazado no trae contenido');
    for (const k of ['declared_id', 'recomputed_id']) if (Object.hasOwn(response, k) && !(response[k] === null || sha(response[k]))) throw invalid(k);
    return response;
  }
  if (!sha(response.package_id)) throw invalid('package_id');
  const v = response.verification;
  if (!isRecord(v) || v.identity !== 'verified' || v.secrets !== 'none_found' || v.attachments !== 'not_checked') throw invalid('verificación no compatible');
  validatePackage(response.package, response.package_id);
  validateSummary(response.summary);
  return response;
}

/** Peticiones y validación de la query. Se fusionan en la tabla de `coreQueries.js`. */
export const CONTEXT_PREVIEW_QUERY_SPECS = Object.freeze({
  context_package_preview: {
    request: (args) => {
      if (typeof args?.package !== 'string' || !args.package.trim()) throw new Error('ade_query_invalid_request: context_package_preview exige el texto del paquete');
      // Se mide en bytes (UTF-8), como el Core.
      if (new TextEncoder().encode(args.package).length > MAX_PREVIEW_REQUEST_BYTES) {
        throw new Error('ade_query_invalid_request: el paquete pesa más de lo que admite un ContextPackage v1');
      }
      return { package: args.package };
    },
    validate: (response) => validateContextPreview(response),
  },
});
