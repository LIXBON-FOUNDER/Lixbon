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
  [/requiere el lifecycle de lanzamiento verificado/i, 'El Orquestador está desactivado: actívalo en Ajustes → Orquestador para lanzar un intento.'],
  [/terminó mal/i, 'Solo se reintenta un intento que terminó mal (falló, se detuvo o se cerró).'],
  [/solo se reintenta el último/i, 'Hay un intento más reciente: reintenta ese.'],
  [/no tuvo una sesión/i, 'Este intento no guardó una sesión del proveedor: no se puede continuar.'],
  [/no es resumible|no está en espera/i, 'La sesión del proveedor ya no se puede reanudar.'],
  [/provider_resume_unsupported/i, 'Este proveedor no permite reanudar sesiones.'],
  [/solo se continúa un Attempt terminado/i, 'Solo se continúa un intento que ya terminó.'],
  [/solo se continúa el último/i, 'Hay un intento más reciente: continúa ese.'],
  [/queue_unsupported/i, 'Este proveedor no puede entregar instrucciones entre turnos: no se puede encolar.'],
  [/attempt_final/i, 'El intento ya terminó: no admite instrucciones.'],
  [/queue_full/i, 'La cola está llena (50 instrucciones pendientes): espera a que se entregue alguna.'],
  [/not_cancellable/i, 'Esa instrucción ya no se puede cancelar: se está entregando, se entregó o falló.'],
  [/request_conflict/i, 'Esa clave ya se usó con otra instrucción: vuelve a enviarla.'],
  [/steer_unsupported/i, 'Este proveedor no permite inyectar una instrucción en el turno en curso (Steer).'],
  [/stop_send_unsupported/i, 'Este proveedor no permite detener el turno y enviar una instrucción: necesita interrumpir y reanudar.'],
  [/steer_failed/i, 'El proveedor no aceptó la instrucción para el turno en curso. Puedes volver a enviarla.'],
  [/stop_timeout/i, 'El proveedor no confirmó a tiempo que se detuviera el turno: no se envió la instrucción y el intento sigue.'],
  [/stop_in_progress/i, 'Ya hay un «detener y enviar» esperando a que se confirme la parada.'],
  [/stop_failed/i, 'No se pudo detener el turno: no se envió la instrucción.'],
  [/send_failed/i, 'Se detuvo el turno pero la instrucción no llegó al proveedor. Continúa la sesión con ella si hace falta.'],
  [/session_missing/i, 'El proveedor aún no ha declarado su sesión: no se puede detener y enviar todavía.'],
  [/busy\/not_running/i, 'El intento no está en marcha ahora (espera una respuesta o no ha arrancado): no admite esta instrucción.'],
  [/in_progress/i, 'Esa petición ya se está atendiendo.'],
  [/context_package_source_mismatch/i, 'El paquete de contexto no sale de este intento (o de este proyecto): revisa que sea el correcto.'],
  [/context_package_invalid/i, 'El paquete de contexto no pasa la verificación del Core: no se puede usar.'],
  [/review_not_current/i, 'Solo se revisa el intento actual de la tarea: la rama es la suya.'],
  [/review_not_final/i, 'El intento todavía no terminó: espera a que acabe para aceptar un HEAD que ya no cambie.'],
  [/confirmación explícita/i, 'Hay que confirmar la decisión.'],
  [/provider_unknown/i, 'Ese proveedor no está registrado en este Core.'],
  [/provider_start_(unsupported|unavailable)/i, 'Ese proveedor no puede arrancar un intento ahora mismo.'],
  [/provider_environment_blocked/i, 'El entorno impide lanzar con ese proveedor.'],
  [/no tiene Project/i, 'La tarea de este intento no tiene proyecto: no hay desde dónde lanzar.'],
  [/venci/i, 'La aprobación venció: el intento se detuvo sin ejecutarse. Crea uno nuevo.'],
  [/ya fue aprobado/i, 'Este intento ya fue aprobado.'],
  [/ya fue rechazado/i, 'Este intento ya fue rechazado.'],
  [/no pendiente de aprobaci/i, 'Este intento ya no espera aprobación.'],
  [/ya tiene respuesta/i, 'Esta pregunta ya tiene respuesta.'],
  [/No existe la pregunta/i, 'Esta pregunta ya no existe.'],
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

/** Responde la pregunta abierta de un agente (`reply`). Lo manda la persona en nombre del destinatario de la pregunta. */
export const answerQuestion = (questionId, answer) => call('reply', { question: questionId, answer });

/**
 * Detiene la Task en marcha (`stop`): el Core corta el proceso del proveedor y cierra el Attempt como `stopped`. Si el
 * proceso no se pudo matar NO la declara detenida y devuelve el error. Devuelve `{ task, status: 'stopped' }`.
 */
export const stopTask = (taskId) => call('stop', { task: taskId });

/**
 * Pide un intento limpio para la Task (`attempt_retry`): el Core crea el siguiente Attempt y lo lanza por el mismo camino que al
 * primero. Hay que nombrar el Attempt que se reintenta (el último): repetir la petición devuelve ese mismo reintento
 * (`Replayed`) en vez de abrir otro. No acepta perfil: se hereda del anterior. Devuelve `{ status, task_id, attempt_id }`.
 */
export const retryAttempt = (taskId, fromAttemptId) => call('attempt_retry', { task_id: taskId, from_attempt_id: fromAttemptId });

/**
 * Continúa la sesión del proveedor de un intento terminado con un mensaje nuevo (`attempt_resume`): el Core crea el siguiente
 * Attempt, enlazado a la MISMA sesión, y lo lanza reanudándola. Como `retryAttempt`, nombra el Attempt que se continúa (el último) y
 * repetir la petición devuelve esa continuación (`Replayed`). No acepta proveedor ni perfil. Devuelve `{ status, task_id, attempt_id }`.
 */
export const resumeAttempt = (taskId, fromAttemptId, prompt) => call('attempt_resume', { task_id: taskId, from_attempt_id: fromAttemptId, prompt });

/**
 * Encola una instrucción para un intento ocupado (`attempt_queue`): el Core la entrega como el SIGUIENTE turno (reanudando la sesión),
 * nunca en mitad del turno en curso, y encolar no entrega nada. `requestId` es la clave de idempotencia: repetir la petición con la
 * misma clave devuelve el mismo item (`Replayed`) en vez de duplicarlo. Devuelve `{ status, attempt_id, queue_id, position }`.
 */
export const queueInstruction = (attemptId, requestId, body) => call('attempt_queue', { attempt_id: attemptId, request_id: requestId, body });

/** Cancela una instrucción aún no entregada (`attempt_queue_cancel`). `status`: `Cancelled` · `AlreadyCancelled`. */
export const cancelQueued = (queueId) => call('attempt_queue_cancel', { queue_id: queueId });

/**
 * Inyecta una instrucción en el turno EN CURSO (`attempt_steer`). Solo si el proveedor ofrece `steer`: nunca se convierte en cola ni en
 * parada. `requestId` es la clave de idempotencia (repetirla devuelve el mismo resultado, `Replayed`, sin volver a llamar al proveedor).
 * Devuelve `{ status, mode: 'steer', attempt_id, request_id }`.
 */
export const steerAttempt = (attemptId, requestId, body) => call('attempt_steer', { attempt_id: attemptId, request_id: requestId, body });

/**
 * Detiene el turno en curso y envía la instrucción como turno nuevo (`attempt_stop_and_send`). Necesita `interrupt` y `resume`. El Core
 * no envía nada hasta que el proveedor confirma la parada (puede tardar hasta 15 s); si no se confirma, no se envía y el intento
 * sigue. Devuelve `{ status, mode: 'stop_and_send', attempt_id, request_id }`.
 */
export const stopAndSend = (attemptId, requestId, body) => call('attempt_stop_and_send', { attempt_id: attemptId, request_id: requestId, body });

/**
 * Bifurca un intento (`attempt_fork`): el Core crea una Task NUEVA con su primer Attempt, con la procedencia del origen, que nace
 * pendiente de la aprobación de la persona. El origen no se toca. `requestId` es la clave de idempotencia: repetir la petición devuelve el
 * mismo Fork (`Replayed`) en vez de abrir otro. No acepta perfil, worktree ni host: el perfil se hereda y el worktree es siempre nuevo.
 * Los campos vacíos se omiten (se heredan). `package` es el texto exacto del ContextPackage que la persona revisó.
 * Devuelve `{ status, source_attempt_id, run_id, task_id, attempt_id, strategy, package_id }`.
 */
export async function forkAttempt({ requestId, sourceAttemptId, provider, model, effort, title, package: contextPackage }) {
  const args = { request_id: requestId, source_attempt_id: sourceAttemptId };
  const optional = { provider, model, effort, title };
  for (const [key, value] of Object.entries(optional)) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) args[key] = text;
  }
  if (typeof contextPackage === 'string' && contextPackage.trim()) args.package = contextPackage;
  const response = await call('attempt_fork', args);
  if (!response || typeof response.task_id !== 'string' || typeof response.attempt_id !== 'string') {
    throw new Error('ade_command_invalid_response: attempt_fork no devolvió la Task y el Attempt');
  }
  return response;
}

/**
 * La decisión de la persona sobre la revisión EXACTA que vio (`attempt_review`): `headCommit` es el HEAD que mostró el Proof Pack. Si la
 * rama se movió, el Core no registra nada y responde `outcome: 'head_moved'`. Aceptar no integra ni abre un PR; rechazar no borra nada.
 * `decision`: `accepted` · `rejected`. Devuelve `{ outcome: 'recorded' | 'head_moved', attempt_id, … }`.
 */
export const reviewAttempt = ({ attemptId, decision, headCommit, comment }) => call('attempt_review', {
  attempt_id: attemptId,
  decision,
  head_commit: headCommit,
  confirm: true,
  ...(typeof comment === 'string' && comment.trim() ? { comment: comment.trim() } : {}),
});
