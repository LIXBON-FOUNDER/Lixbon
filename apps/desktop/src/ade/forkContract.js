/**
 * Contrato cliente de `attempt_lineage` (LXO-145/153, docs/core/FORK.md § Query): de dónde salió un Attempt y qué Forks nacieron de él.
 * Sale del log del Core (`attempt.forked`): la interfaz muestra lo que se registró al bifurcar, sin deducir una procedencia ni ordenar
 * por su cuenta. Una respuesta fuera del contrato se rechaza entera.
 */

/** Con qué contexto arrancó un Fork (conjunto cerrado del Core). */
export const FORK_STRATEGIES = Object.freeze(['clean', 'context_package']);
/** Lo que se pidió distinto del origen. */
export const FORK_OVERRIDES = Object.freeze(['provider', 'model', 'effort']);

const invalid = (detail) => new Error(`ade_query_invalid_response: attempt_lineage: ${detail}`);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.length > 0;

function validateOrigin(origin) {
  if (!isObject(origin)) throw invalid('forked_from no es un objeto');
  if (!isText(origin.attempt_id) || !isText(origin.task_id) || !Number.isSafeInteger(origin.n) || origin.n < 1) throw invalid('forked_from: origen inválido');
  if (!FORK_STRATEGIES.includes(origin.strategy)) throw invalid(`forked_from: estrategia «${String(origin.strategy)}» fuera del contrato`);
  if (origin.package_id !== null && !isText(origin.package_id)) throw invalid('forked_from: package_id inválido');
  // Un paquete lo hay si y solo si la estrategia es context_package.
  if ((origin.strategy === 'context_package') !== (origin.package_id !== null)) throw invalid('forked_from: el paquete va con la estrategia context_package, y solo con ella');
  if (!Array.isArray(origin.overrides) || !origin.overrides.every((o) => FORK_OVERRIDES.includes(o))) throw invalid('forked_from: overrides fuera del contrato');
}

function validateFork(fork, i) {
  if (!isObject(fork)) throw invalid(`forks[${i}]: no es un objeto`);
  if (!isText(fork.attempt_id) || !isText(fork.task_id) || !isText(fork.provider) || !isText(fork.status)) throw invalid(`forks[${i}]: faltan campos`);
  if (!FORK_STRATEGIES.includes(fork.strategy)) throw invalid(`forks[${i}]: estrategia «${String(fork.strategy)}» fuera del contrato`);
  if (fork.model !== null && !isText(fork.model)) throw invalid(`forks[${i}]: modelo inválido`);
  if (!Number.isSafeInteger(fork.created_at) || fork.created_at < 0) throw invalid(`forks[${i}]: marca de tiempo inválida`);
}

export function validateAttemptLineage(response, args) {
  if (!isObject(response)) throw invalid('la respuesta no es un objeto');
  if (response.v !== 1) throw invalid('versión de contrato desconocida');
  if (response.attempt_id !== args.attempt_id) throw invalid('la procedencia no corresponde al Attempt solicitado');
  if (response.forked_from !== null) validateOrigin(response.forked_from);
  if (!Array.isArray(response.forks)) throw invalid('falta forks');
  response.forks.forEach(validateFork);
  return response;
}

/** Petición y validación de la query. Se fusionan en la tabla de `coreQueries.js`. */
export const FORK_QUERY_SPECS = Object.freeze({
  attempt_lineage: {
    request: (args) => {
      if (typeof args?.attemptId !== 'string' || !args.attemptId.trim()) throw new Error('ade_query_invalid_request: attempt_lineage exige attempt_id');
      return { attempt_id: args.attemptId };
    },
    validate: validateAttemptLineage,
  },
});
