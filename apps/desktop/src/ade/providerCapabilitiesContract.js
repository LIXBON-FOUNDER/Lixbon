/**
 * Contrato cliente de `provider_capabilities` (LXO-135, docs/core/QUERIES.md § provider_capabilities; forma de cada proveedor y
 * de su matriz en docs/core/ADAPTERS.md; respuesta de referencia en docs/core/fixtures/api/provider_capabilities.v1.json).
 *
 * Mismo patrón que `coreModelContract.js`: el DTO del Core llega tal cual y aquí solo se COMPRUEBA su forma y su vocabulario.
 * Nada se completa ni se deduce: una capability que falta en la matriz es una respuesta inválida, no «no soportada», y un
 * proveedor que el Core no nombra NO se rellena por su nombre ni por su versión. Sin dependencias de Tauri ni de React.
 */

/** Las seis capabilities de la matriz v1, en el orden en que se muestran. El Core las trae siempre todas. */
export const CAPABILITIES = Object.freeze(['start', 'events', 'answer', 'interrupt', 'steer', 'resume']);
/** Los cuatro estados de una capability (conjunto cerrado). */
export const CAPABILITY_STATES = Object.freeze(['available', 'unsupported', 'unavailable', 'environment_blocked']);
export const ENVIRONMENT_STATES = Object.freeze(['ready', 'blocked']);
export const PROVIDER_CAPABILITIES_VERSION = 1;
export const PROBE_STATUSES = Object.freeze(['probing', 'ready']);
/** Cada cuánto se vuelve a leer: rápido mientras el Core todavía sondea, tranquilo después. */
export const PROBING_POLL_MS = 3_000;
export const READY_POLL_MS = 30_000;

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const invalid = (detail) => new Error(`ade_query_invalid_response: provider_capabilities: ${detail}`);

function validateState(capability, state) {
  if (!isRecord(state) || !CAPABILITY_STATES.includes(state.state)) {
    throw invalid(`la capability ${capability} no tiene un estado del contrato`);
  }
  if (state.state === 'unavailable' && typeof state.reason !== 'string') {
    throw invalid(`la capability ${capability} no disponible no trae su motivo`);
  }
  if (state.state === 'environment_blocked' && !nonEmpty(state.block)) {
    throw invalid(`la capability ${capability} bloqueada por el entorno no trae su bloqueo`);
  }
}

function validateProvider(provider) {
  if (!isRecord(provider) || !nonEmpty(provider.id)) throw invalid('un proveedor sin id');
  const { id } = provider;
  if (!(provider.cli_version === null || typeof provider.cli_version === 'string')) throw invalid(`${id}: cli_version`);
  const env = provider.environment;
  if (!isRecord(env) || !ENVIRONMENT_STATES.includes(env.state)) throw invalid(`${id}: el entorno no es del contrato`);
  if (env.state === 'blocked' && !(Array.isArray(env.blocks) && env.blocks.every(nonEmpty))) throw invalid(`${id}: el entorno bloqueado no trae sus bloqueos`);
  const matrix = provider.matrix;
  if (!isRecord(matrix) || matrix.version !== PROVIDER_CAPABILITIES_VERSION || !isRecord(matrix.capabilities)) {
    throw invalid(`${id}: la matriz no es de una versión que este cliente entienda`);
  }
  for (const capability of CAPABILITIES) {
    if (!Object.hasOwn(matrix.capabilities, capability)) throw invalid(`${id}: a la matriz le falta ${capability}`);
    validateState(`${id}/${capability}`, matrix.capabilities[capability]);
  }
  if (provider.transport !== undefined && !nonEmpty(provider.transport)) throw invalid(`${id}: transport`);
}

/** El snapshot del registro (la fixture canónica): versión, generación y proveedores con su matriz. */
export function validateRegistrySnapshot(response) {
  if (!isRecord(response) || response.version !== PROVIDER_CAPABILITIES_VERSION) throw invalid('versión de respuesta no compatible');
  if (!Number.isSafeInteger(response.generation) || response.generation < 0) throw invalid('generation');
  if (!Array.isArray(response.providers)) throw invalid('providers');
  response.providers.forEach(validateProvider);
  const ids = response.providers.map((p) => p.id);
  if (new Set(ids).size !== ids.length) throw invalid('un proveedor repetido');
  return response;
}

/** La respuesta de la lectura viva: el snapshot más el estado del sondeo y cuándo se supo. Devuelve el DTO sin tocarlo. */
export function validateProviderCapabilities(response) {
  validateRegistrySnapshot(response);
  if (!PROBE_STATUSES.includes(response.status)) throw invalid('status');
  if (typeof response.refreshing !== 'boolean') throw invalid('refreshing');
  if (!(response.checked_at_ms === null || (Number.isSafeInteger(response.checked_at_ms) && response.checked_at_ms >= 0))) throw invalid('checked_at_ms');
  return response;
}

/** Peticiones y validación de la query. Se fusionan en la tabla de `coreQueries.js`. */
export const PROVIDER_CAPABILITIES_QUERY_SPECS = Object.freeze({
  provider_capabilities: {
    request: (args) => (args?.refresh === true ? { refresh: true } : {}),
    validate: (response) => validateProviderCapabilities(response),
  },
});
