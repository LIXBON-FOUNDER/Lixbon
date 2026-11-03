import { invoke } from '@tauri-apps/api/core';

/**
 * LXO-141 · Las ÚNICAS escrituras del ADE sobre el modelo Task/Attempt: crear una Task con su primer Attempt y decidir su
 * aprobación inicial. Van por `orch_call`, que en Desktop llega al Core con la identidad autenticada de la Person: ni un
 * agente ni el CLI pueden aprobar. Aquí no se decide nada: el Core valida, fija la política (el Attempt nace SIEMPRE
 * `pending_approval`) y dice el resultado.
 */

/** Perfiles de permisos que el Core acepta para lanzar (`Autonomía amplia` está aplazada y no se ofrece). */
export const ATTEMPT_PROFILES = Object.freeze([
  Object.freeze({ id: 'explorar', label: 'Explorar' }),
  Object.freeze({ id: 'proponer', label: 'Proponer' }),
  Object.freeze({ id: 'delegar_con_revision', label: 'Delegar con revisión' }),
]);

/** El Core acota la clave de idempotencia a `[A-Za-z0-9_.-]{1,64}`. */
export function newRequestId() {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `ade-${random}`.slice(0, 64);
}

/** Mensajes del Core que la persona puede resolver, en lenguaje llano; el resto se muestra tal cual. */
const KNOWN_ERRORS = [
  [/requiere el lifecycle de lanzamiento verificado/i, 'El Orquestador está desactivado: actívalo en Ajustes → Orquestador para crear un intento.'],
  [/venci/i, 'La aprobación venció: el intento se detuvo sin ejecutarse. Crea uno nuevo.'],
  [/ya fue aprobado/i, 'Este intento ya fue aprobado.'],
  [/ya fue rechazado/i, 'Este intento ya fue rechazado.'],
  [/no pendiente de aprobaci/i, 'Este intento ya no espera aprobación.'],
];

/** Texto para la persona de un error del Core (el original queda como detalle técnico). */
export function describeCommandError(error) {
  const detail = typeof error === 'string' ? error : error?.message ?? String(error);
  const known = KNOWN_ERRORS.find(([pattern]) => pattern.test(detail));
  return { message: known ? known[1] : detail, detail };
}

const call = (cmd, args) => invoke('orch_call', { cmd, args });

function selection(attempt) {
  const out = { provider: attempt.provider, profile: attempt.profile };
  for (const key of ['model', 'effort']) {
    const value = typeof attempt[key] === 'string' ? attempt[key].trim() : '';
    if (value) out[key] = value;
  }
  return out;
}

/**
 * Crea la Task con su primer Attempt. `requestId` es la clave de idempotencia: reintentar con la misma devuelve la misma
 * Task (`Replayed`) en vez de crear otra. Devuelve `{ status, run_id, task_id, attempt_id }`.
 */
export async function createTaskWithAttempt({ requestId, projectId, title, objective, spec = '', attempt }) {
  const response = await call('task_create', {
    request_id: requestId,
    project_id: projectId,
    objective,
    title,
    spec,
    attempt: selection(attempt),
  });
  if (!response || typeof response.task_id !== 'string' || typeof response.attempt_id !== 'string') {
    throw new Error('ade_command_invalid_response: task_create no devolvió la Task y el Attempt');
  }
  return response;
}

/** Aprueba el primer Attempt. `status`: `Approved` · `Replayed` · `Expired`. Aprobar no lanza nada por sí mismo. */
export const approveAttempt = (attemptId) => call('attempt_approve', { attempt_id: attemptId });

/** Rechaza el primer Attempt. `status`: `Rejected` · `Replayed` · `Expired`. */
export const rejectAttempt = (attemptId) => call('attempt_reject', { attempt_id: attemptId });
