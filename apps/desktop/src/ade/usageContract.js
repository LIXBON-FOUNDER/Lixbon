/**
 * Contrato cliente de `usage_report` (LXO-206, docs/core/QUERIES.md § usage_report; el informe y sus campos: docs/core/ADAPTERS.md
 * § Usage y docs/core/fixtures/api/usage_report.v1.json).
 *
 * Mismo patrón que `coreModelContract.js`: el DTO del Core llega tal cual y aquí solo se COMPRUEBA su forma, su vocabulario y que sea
 * coherente (un dato `fresh` trae snapshot, uno `unsupported` no). Nada se completa: un campo ausente es DESCONOCIDO, nunca cero.
 * Sin dependencias de Tauri ni de React.
 */

export const USAGE_VERSION = 1;
export const LIVE_STATUSES = Object.freeze(['loading', 'ready']);
export const USAGE_STATUSES = Object.freeze(['fresh', 'stale', 'unknown', 'unsupported', 'environment_blocked']);
export const USAGE_FIELDS = Object.freeze(['windows', 'tokens', 'credits', 'plan', 'cost']);
export const FIELD_STATES = Object.freeze(['available', 'unsupported', 'unavailable', 'environment_blocked']);
export const ERROR_KINDS = Object.freeze(['auth_required', 'rate_limited', 'provider_unavailable', 'unsupported', 'environment_blocked', 'internal']);
export const PROVENANCES = Object.freeze(['provider_query', 'run_observation']);
/** Cada cuánto se vuelve a leer: rápido mientras el Core consulta, tranquilo después. */
export const LOADING_POLL_MS = 2_000;
export const READY_POLL_MS = 15_000;

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const optCount = (v) => v === undefined || count(v);
const optStr = (v) => v === undefined || typeof v === 'string';
const optBool = (v) => v === undefined || typeof v === 'boolean';
const invalid = (detail) => new Error(`ade_query_invalid_response: usage_report: ${detail}`);

function validateSupport(provider, support) {
  if (!isRecord(support) || !isRecord(support.fields)) throw invalid(`${provider}: support`);
  for (const field of USAGE_FIELDS) {
    const state = support.fields[field];
    if (!isRecord(state) || !FIELD_STATES.includes(state.state)) throw invalid(`${provider}: support.${field} no tiene un estado del contrato`);
  }
}

function validateSnapshot(provider, s) {
  if (!isRecord(s) || s.provider !== provider || !count(s.observed_at_ms) || !PROVENANCES.includes(s.provenance)) throw invalid(`${provider}: snapshot`);
  if (!optStr(s.account) || !optStr(s.plan) || !optBool(s.limit_reached)) throw invalid(`${provider}: snapshot (cuenta, plan o límite)`);
  const windows = s.windows ?? [];
  if (!Array.isArray(windows) || !windows.every((w) => isRecord(w) && nonEmpty(w.id) && optCount(w.minutes) && optCount(w.resets_at)
    && (w.used_percent === undefined || (typeof w.used_percent === 'number' && w.used_percent >= 0 && w.used_percent <= 100)))) throw invalid(`${provider}: windows`);
  const models = s.models ?? [];
  if (!Array.isArray(models) || !models.every((m) => isRecord(m) && nonEmpty(m.model) && optCount(m.input_tokens) && optCount(m.output_tokens)
    && optCount(m.cache_read_tokens) && optCount(m.cache_creation_tokens) && (m.cost_usd === undefined || (typeof m.cost_usd === 'number' && m.cost_usd >= 0)))) throw invalid(`${provider}: models`);
  if (s.credits !== undefined && !(isRecord(s.credits) && optBool(s.credits.has_credits) && optBool(s.credits.unlimited) && optStr(s.credits.balance))) throw invalid(`${provider}: credits`);
}

function validateProvider(p) {
  if (!isRecord(p) || !nonEmpty(p.provider) || !USAGE_STATUSES.includes(p.status)) throw invalid('un proveedor sin id o con un estado fuera del contrato');
  const id = p.provider;
  validateSupport(id, p.support);
  if (p.age_ms !== undefined && !Number.isSafeInteger(p.age_ms)) throw invalid(`${id}: age_ms`);
  if (p.error !== undefined && !(isRecord(p.error) && ERROR_KINDS.includes(p.error.kind) && typeof p.error.message === 'string')) throw invalid(`${id}: error`);
  if (!optBool(p.throttled)) throw invalid(`${id}: throttled`);
  // Coherencia: lo que dice el estado y lo que trae.
  const hasSnapshot = p.snapshot !== undefined;
  if ((p.status === 'fresh' || p.status === 'stale') && !hasSnapshot) throw invalid(`${id}: ${p.status} sin snapshot`);
  if ((p.status === 'unknown' || p.status === 'unsupported' || p.status === 'environment_blocked') && hasSnapshot) throw invalid(`${id}: ${p.status} con snapshot`);
  if (hasSnapshot) validateSnapshot(id, p.snapshot);
}

/** Valida el informe del contrato (LXO-205). Devuelve el DTO sin tocarlo. */
export function validateUsageReport(report) {
  if (!isRecord(report) || report.version !== USAGE_VERSION || !count(report.generated_at_ms) || !Array.isArray(report.providers)) throw invalid('el informe no es de la versión 1');
  report.providers.forEach(validateProvider);
  const ids = report.providers.map((p) => p.provider);
  if (new Set(ids).size !== ids.length) throw invalid('un proveedor repetido (el informe trae una entrada por proveedor, sin totales)');
  return report;
}

/** Valida la respuesta de la lectura viva: el informe (o `null` mientras no hay ninguno) y el estado de la consulta. */
export function validateUsageResponse(response) {
  if (!isRecord(response) || response.v !== 1 || !LIVE_STATUSES.includes(response.status) || typeof response.refreshing !== 'boolean') throw invalid('versión o estado no compatibles');
  if (response.status === 'loading') {
    if (response.report !== null) throw invalid('«cargando» no trae informe');
    return response;
  }
  validateUsageReport(response.report);
  return response;
}

/** Peticiones y validación de la query. Se fusionan en la tabla de `coreQueries.js`. */
export const USAGE_QUERY_SPECS = Object.freeze({
  usage_report: {
    request: (args) => (args?.refresh === true ? { refresh: true } : {}),
    validate: (response) => validateUsageResponse(response),
  },
});
