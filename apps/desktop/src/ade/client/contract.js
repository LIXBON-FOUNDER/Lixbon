// contract.js — la interfaz AdeClient: qué métodos existen, errores y un comprobador.
//
// Las pantallas solo conocen esto. MockAdeClient la implementa hoy; CoreAdeClient la implementará cuando
// existan los slices del Core. Las formas de las entidades están en types.d.ts.

/** Consultas: devuelven entidades ya con los ids del vocabulario canónico. */
export const ADE_QUERY_METHODS = Object.freeze([
  'getConnection', 'getCapabilities',
  'listProjects', 'getProject',
  'listTasks', 'getTask',
  'listAttempts', 'getAttempt',
  'listThreads', 'getThread',
  'listWorktrees', 'listArtifacts',
  'getReview', 'getIntegration',
  'listAttention', 'listActivity', 'listAgents',
  'resolveLocation',
]);

/** Todo el contrato: consultas + decisiones (dispatch) + cambios (subscribe). */
export const ADE_METHODS = Object.freeze([...ADE_QUERY_METHODS, 'dispatch', 'subscribe']);

/** Códigos de error compartidos entre mock y Core. `core_not_implemented` solo lo lanza CoreAdeClient hoy. */
export const ADE_ERROR_CODES = Object.freeze({
  not_found: 'not_found',
  forbidden: 'forbidden',
  unavailable: 'unavailable',
  stale: 'stale',
  invalid: 'invalid',
  failed: 'failed',
  core_not_implemented: 'core_not_implemented',
});

export class AdeError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'AdeError';
    this.code = code;
    this.slice = extra.slice ?? null;
    this.method = extra.method ?? null;
    this.simulated = Boolean(extra.simulated);
  }
}

export const adeError = (code, message, extra) => new AdeError(code, message, extra);

/** Devuelve la lista de métodos que faltan (vacía = cumple la interfaz). */
export function missingAdeMethods(client) {
  return ADE_METHODS.filter((m) => typeof client?.[m] !== 'function');
}

export function assertAdeClient(client) {
  const faltan = missingAdeMethods(client);
  if (faltan.length) throw new Error(`AdeClient incompleto: faltan ${faltan.join(', ')}`);
  return client;
}
