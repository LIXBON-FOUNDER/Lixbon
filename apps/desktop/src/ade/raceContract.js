/**
 * Contrato cliente de `task_race_status` (LXO-215/216, docs/core/RACE.md): un Race con TODOS sus candidatos (también los fallidos) o la lista de los
 * Races de un Attempt. Cada candidato es un Attempt real del Core. El contrato no tiene ganador, puntuación ni «mejor»: una respuesta que los traiga
 * (o cualquier campo fuera del contrato) se rechaza entera, y las cuentas tienen que cuadrar con los candidatos.
 */
export const MIN_CANDIDATES = 2;
export const MAX_CANDIDATES = 4;
export const OUTCOMES = Object.freeze(['launched', 'failed', 'not_attempted']);
export const STRATEGIES = Object.freeze(['clean', 'context_package']);
const ATTEMPT_STATUSES = Object.freeze(['pending_approval', 'starting', 'running', 'waiting', 'awaiting_terminal_approval', 'done', 'failed', 'stopped', 'exited']);
const FINAL = new Set(['done', 'failed', 'stopped', 'exited']);
export const isFinalStatus = (status) => FINAL.has(status);

const invalid = (detail) => new Error(`ade_query_invalid_response: task_race_status: ${detail}`);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const idLike = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;
const textOrNull = (v) => v === null || idLike(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0;
export const RACE_ID = /^rc-[0-9a-f]{20}$/;

const RACE_KEYS = ['v', 'race_id', 'source_attempt_id', 'requested', 'strategy', 'package_id', 'created_at', 'candidates', 'summary', 'compare', 'cancellable', 'limits'];
// Lo que acompaña a un Race cuando es la respuesta de un comando, no de la query.
const EXTRA_KEYS = ['status', 'replayed', 'results', 'race'];
const CANDIDATE_KEYS = ['index', 'outcome', 'provider', 'model', 'task_id', 'attempt_id', 'status', 'code'];

function exactKeys(obj, allowed, where) {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length) throw invalid(`${where}: campos fuera del contrato (${extra.join(', ')})`);
}

export function validateRace(r, { allowExtra = false } = {}) {
  if (!isObject(r)) throw invalid('la respuesta no es un objeto');
  exactKeys(r, allowExtra ? [...RACE_KEYS, ...EXTRA_KEYS] : RACE_KEYS, 'race');
  if (r.v !== 1) throw invalid('versión de contrato desconocida');
  if (typeof r.race_id !== 'string' || !RACE_ID.test(r.race_id)) throw invalid('race_id inválido');
  if (!idLike(r.source_attempt_id)) throw invalid('falta el Attempt origen');
  if (!Number.isInteger(r.requested) || r.requested < MIN_CANDIDATES || r.requested > MAX_CANDIDATES) throw invalid('un Race lleva de 2 a 4 candidatos');
  if (!STRATEGIES.includes(r.strategy)) throw invalid('estrategia de contexto fuera del contrato');
  if (!textOrNull(r.package_id) || (r.strategy === 'clean') !== (r.package_id === null)) throw invalid('el paquete no corresponde a la estrategia');
  if (!count(r.created_at)) throw invalid('created_at inválido');
  if (!Array.isArray(r.candidates) || r.candidates.length !== r.requested) throw invalid('los candidatos no son los pedidos');
  const tally = { launched: 0, failed: 0, not_attempted: 0 };
  const launched = [];
  r.candidates.forEach((c, i) => {
    if (!isObject(c)) throw invalid(`candidato ${i}: inválido`);
    exactKeys(c, CANDIDATE_KEYS, `candidato ${i}`);
    if (c.index !== i) throw invalid(`candidato ${i}: el índice no coincide con su posición`);
    if (!OUTCOMES.includes(c.outcome)) throw invalid(`candidato ${i}: desenlace fuera del contrato`);
    if (!textOrNull(c.provider) || !textOrNull(c.model) || !textOrNull(c.task_id) || !textOrNull(c.attempt_id) || !textOrNull(c.code)) throw invalid(`candidato ${i}: campos inválidos`);
    if (c.status !== null && !ATTEMPT_STATUSES.includes(c.status)) throw invalid(`candidato ${i}: estado fuera del contrato`);
    tally[c.outcome] += 1;
    if (c.outcome === 'launched') {
      // Cada columna es un Attempt real: sin Attempt y Task no hay candidato lanzado.
      if (c.attempt_id === null || c.task_id === null || c.code !== null) throw invalid(`candidato ${i}: un candidato lanzado lleva su Attempt y no un código de fallo`);
      launched.push(c);
    } else if (c.attempt_id !== null || c.task_id !== null || c.status !== null) {
      throw invalid(`candidato ${i}: un candidato que no se lanzó no tiene Attempt`);
    }
    if (c.outcome === 'failed' && c.code === null) throw invalid(`candidato ${i}: un fallo sin código`);
  });
  const s = r.summary;
  if (!isObject(s)) throw invalid('summary inválido');
  exactKeys(s, ['launched', 'failed', 'not_attempted', 'active', 'finished'], 'summary');
  if (![s.launched, s.failed, s.not_attempted, s.active, s.finished].every(count)) throw invalid('summary: cuentas inválidas');
  if (s.launched !== tally.launched || s.failed !== tally.failed || s.not_attempted !== tally.not_attempted) throw invalid('summary no cuadra con los candidatos');
  if (s.active + s.finished > s.launched) throw invalid('summary: más activos y terminados que lanzados');
  const ids = launched.map((c) => c.attempt_id);
  if (!isObject(r.compare)) throw invalid('compare inválido');
  exactKeys(r.compare, ['attempt_ids'], 'compare');
  if (r.compare.attempt_ids !== null) {
    const list = r.compare.attempt_ids;
    if (!Array.isArray(list) || list.length < 2 || list.join() !== ids.join()) throw invalid('compare no son los Attempts lanzados');
  } else if (ids.length >= 2) {
    throw invalid('hay dos o más Attempts lanzados y compare no los ofrece');
  }
  if (!Array.isArray(r.cancellable) || !r.cancellable.every((id) => ids.includes(id))) throw invalid('cancellable no son candidatos lanzados');
  const stillRunning = launched.filter((c) => c.status !== null && !isFinalStatus(c.status)).map((c) => c.attempt_id);
  if (r.cancellable.join() !== stillRunning.join()) throw invalid('cancellable no son los que no han terminado');
  if (!isObject(r.limits) || !count(r.limits.min_candidates) || !count(r.limits.max_candidates) || !count(r.limits.max_active_tasks)) throw invalid('límites inválidos');
  return r;
}

export function validateRaceList(r, args) {
  if (!isObject(r)) throw invalid('la respuesta no es un objeto');
  exactKeys(r, ['v', 'source_attempt_id', 'races'], 'lista');
  if (r.v !== 1) throw invalid('versión de contrato desconocida');
  if (r.source_attempt_id !== args.source_attempt_id) throw invalid('los Races no son del Attempt solicitado');
  if (!Array.isArray(r.races)) throw invalid('lista inválida');
  for (const x of r.races) {
    if (!isObject(x) || typeof x.race_id !== 'string' || !RACE_ID.test(x.race_id) || !Number.isInteger(x.requested) || !count(x.created_at)) throw invalid('un Race de la lista está fuera del contrato');
    exactKeys(x, ['race_id', 'requested', 'created_at'], 'lista');
  }
  return r;
}

/** Petición y validación de la query. Se fusionan en la tabla de `coreQueries.js`. */
export const RACE_QUERY_SPECS = Object.freeze({
  task_race_status: {
    request: (input = {}) => {
      const raceId = input.raceId ?? null;
      const source = input.sourceAttemptId ?? null;
      if ((raceId === null) === (source === null)) throw new Error('ade_query_invalid_request: task_race_status exige un race_id o un source_attempt_id');
      if (raceId !== null) {
        if (typeof raceId !== 'string' || !RACE_ID.test(raceId)) throw new Error('ade_query_invalid_request: task_race_status race_id inválido');
        return { race_id: raceId };
      }
      if (typeof source !== 'string' || !source.trim()) throw new Error('ade_query_invalid_request: task_race_status source_attempt_id inválido');
      return { source_attempt_id: source.trim() };
    },
    validate: (response, args) => {
      if (args.race_id !== undefined) {
        validateRace(response);
        if (response.race_id !== args.race_id) throw invalid('el Race no es el solicitado');
        return response;
      }
      return validateRaceList(response, args);
    },
  },
});
