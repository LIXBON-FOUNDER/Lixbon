/**
 * Contrato cliente de `pending_queue` (LXO-143/152, docs/core/COLA.md § RPC): la cola de instrucciones de UN Attempt. El Core manda lo
 * pendiente (`items`, en el orden en que se entregará) y lo ya terminado (`finished`, los últimos). La interfaz muestra exactamente lo
 * que el Core dice: ni asume una entrega que el Core no confirmó ni reordena. Una respuesta fuera del contrato se rechaza entera.
 */

/** Lo pendiente: `queued` espera su fin de turno; `delivering` ya se está entregando (no se cancela). */
export const PENDING_STATUSES = Object.freeze(['queued', 'delivering']);
/** Lo terminado. `cancelled` NUNCA se presenta como `delivered`. */
export const FINISHED_STATUSES = Object.freeze(['delivered', 'cancelled', 'failed']);
/** Por qué no se entregó un item (conjunto cerrado del Core). */
export const QUEUE_FAILURES = Object.freeze(['unsupported', 'environment_blocked', 'adapter_unavailable', 'adapter_error', 'attempt_ended', 'interrupted']);
/** Qué confirmó la entrega: siempre el adapter, nunca «se escribió». */
export const QUEUE_CONFIRMATIONS = Object.freeze(['adapter_event', 'adapter_result']);

const invalid = (detail) => new Error(`ade_query_invalid_response: pending_queue: ${detail}`);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isSafeInteger(v);
const isTime = (v) => v === null || (Number.isSafeInteger(v) && v >= 0);

function validateItem(item, statuses, where) {
  if (!isObject(item)) throw invalid(`${where}: el item no es un objeto`);
  if (typeof item.queue_id !== 'string' || !item.queue_id) throw invalid(`${where}: falta queue_id`);
  if (!isInt(item.seq) || item.seq < 1) throw invalid(`${where}: seq inválido`);
  if (typeof item.body !== 'string') throw invalid(`${where}: falta el cuerpo`);
  if (typeof item.author_kind !== 'string') throw invalid(`${where}: falta el autor`);
  if (!statuses.includes(item.status)) throw invalid(`${where}: estado «${String(item.status)}» fuera del contrato`);
  if (item.failure !== null && !QUEUE_FAILURES.includes(item.failure)) throw invalid(`${where}: motivo «${String(item.failure)}» fuera del contrato`);
  if (item.confirmed_by !== null && !QUEUE_CONFIRMATIONS.includes(item.confirmed_by)) throw invalid(`${where}: confirmación «${String(item.confirmed_by)}» fuera del contrato`);
  if (!isInt(item.created_at) || !isTime(item.delivered_at ?? null) || !isTime(item.ended_at ?? null)) throw invalid(`${where}: marcas de tiempo inválidas`);
  // Un item solo está entregado con la confirmación del adapter, y solo falla con su motivo.
  if ((item.status === 'delivered') !== (item.confirmed_by !== null)) throw invalid(`${where}: una entrega se confirma con el adapter, y solo ella`);
  if ((item.status === 'failed') !== (item.failure !== null)) throw invalid(`${where}: un fallo lleva su motivo, y solo él`);
}

export function validatePendingQueue(response, args) {
  if (!isObject(response)) throw invalid('la respuesta no es un objeto');
  if (response.v !== 1) throw invalid('versión de contrato desconocida');
  if (response.attempt_id !== args.attempt_id) throw invalid('la cola no corresponde al Attempt solicitado');
  if (typeof response.task_id !== 'string' || !Array.isArray(response.items) || !Array.isArray(response.finished)) throw invalid('faltan items o finished');
  response.items.forEach((item, i) => {
    validateItem(item, PENDING_STATUSES, `items[${i}]`);
    if (item.position !== i + 1) throw invalid(`items[${i}]: la posición no coincide con el orden del Core`);
  });
  response.finished.forEach((item, i) => validateItem(item, FINISHED_STATUSES, `finished[${i}]`));
  return response;
}

/** Petición y validación de la query. Se fusionan en la tabla de `coreQueries.js`. */
export const QUEUE_QUERY_SPECS = Object.freeze({
  pending_queue: {
    request: (args) => {
      if (typeof args?.attemptId !== 'string' || !args.attemptId.trim()) throw new Error('ade_query_invalid_request: pending_queue exige attempt_id');
      return { attempt_id: args.attemptId };
    },
    validate: validatePendingQueue,
  },
});
