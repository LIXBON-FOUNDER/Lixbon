import { invoke } from '@tauri-apps/api/core';
import { validateRace } from './raceContract';

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
  // Race (LXO-215/216).
  [/race_concurrency_limit/i, 'Hay demasiadas tareas sin terminar: termina o cancela alguna antes de lanzar otro candidato.'],
  [/race_candidate_not_found/i, 'Ese intento no es un candidato lanzado de este Race.'],
  [/race_not_found/i, 'Ese Race ya no existe.'],
  [/race_invalid_request/i, 'El Race no es válido: lleva de 2 a 4 candidatos con datos válidos.'],
  // Policy de autonomía (LXO-209/210): los códigos son del Core; el texto, de la interfaz.
  [/policy_stale/i, 'La policy cambió mientras editabas: se recargó. Revisa y vuelve a guardar.'],
  [/policy_below_floor/i, 'Esa acción nunca baja de «pedir confirmación»: ya la exige y una policy no la exime.'],
  [/policy_cannot_loosen/i, 'Un override de proyecto o intento solo puede endurecer: para dar más autonomía cámbialo en el ámbito global.'],
  [/policy_confirm_required/i, 'La policy pide una confirmación explícita para esto.'],
  [/policy_out_of_band_required/i, 'La policy exige una confirmación fuera de banda que todavía no existe: no se puede hacer desde aquí.'],
  [/policy_denied/i, 'La policy niega esta acción.'],
  [/policy_unavailable/i, 'Core no puede leer o escribir la policy ahora: no se hace nada hasta poder comprobarla.'],
  [/policy_forbidden/i, 'Solo una persona en Desktop puede cambiar la policy.'],
  [/policy_not_found/i, 'El proyecto o el intento ya no existe.'],
  [/requiere el lifecycle de lanzamiento verificado/i, 'El Orquestador está desactivado: actívalo en Ajustes → Orquestador para lanzar un intento.'],
  [/terminó mal/i, 'Solo se reintenta un intento que terminó mal (falló, se detuvo o se cerró).'],
  [/solo se reintenta el último/i, 'Hay un intento más reciente: reintenta ese.'],
  [/no tuvo una sesión/i, 'Este intento no guardó una sesión del proveedor: no se puede continuar.'],
  [/no es resumible|no está en espera/i, 'La sesión del proveedor ya no se puede reanudar.'],
  [/provider_resume_unsupported/i, 'Este proveedor no permite reanudar sesiones.'],
  [/solo se continúa un Attempt terminado/i, 'Solo se continúa un intento que ya terminó.'],
  [/solo se continúa el último/i, 'Hay un intento más reciente: continúa ese.'],
  // Worktree compartido (LXO-248). Los de la limpieza (`shared_in_use`) van aparte, junto a los demás `resource_blocked`.
  [/share_confirm_required/i, 'Compartir un worktree exige tu confirmación explícita.'],
  [/share_not_reviewable/i, 'Este intento comparte el worktree de otro: se revisa y se integra desde el intento dueño, que ya incluye lo que se hizo en esa carpeta.'],
  [/share_source_without_worktree/i, 'Ese intento no trabaja en ningún worktree: no hay nada que compartir.'],
  [/share_not_pending/i, 'Este intento ya no espera su aprobación: el worktree se elige antes de aprobar.'],
  [/share_already_has_worktree/i, 'Este intento ya trabaja en un worktree.'],
  [/share_not_active/i, 'Ese worktree ya no está activo.'],
  [/share_not_found/i, 'No existe ese intento o ese worktree.'],
  [/share_invalid/i, 'Indica el id de OTRO intento (por ejemplo t3-a1).'],
  [/share_conflict.*Project|ni del Project/i, 'Ese worktree es de otro Project: solo se comparte dentro del mismo.'],
  [/share_conflict.*sigue trabajando/i, 'Otro intento sigue trabajando en ese worktree: se comparte en serie, espera a que termine.'],
  [/share_conflict/i, 'No se pudo compartir ese worktree: otro intento lo usa o no es del mismo Project.'],
  [/resource_blocked: shared_in_use/i, 'Otro intento está trabajando en este worktree (compartido): espera a que termine.'],
  // Responder al proveedor (LXO-247). `request_conflict` de aquí se distingue del de la cola por su texto.
  [/ya se respondió de otra forma/i, 'Esa petición ya se respondió con otra decisión.'],
  [/request_unknown/i, 'Esa petición ya no está pendiente: el proveedor no la espera o ya se respondió.'],
  [/invalid_answer/i, 'La respuesta no es válida: un permiso se responde «permitir» o «denegar»; una pregunta, con un texto de hasta 4 000 caracteres.'],
  [/answer_unsupported/i, 'Este proveedor no ofrece responder a sus peticiones desde Lixbon: respóndele en su terminal.'],
  [/answer_failed/i, 'El proveedor no aceptó la respuesta. La petición sigue pendiente: puedes volver a intentarlo.'],
  [/not_waiting/i, 'El intento ya no espera una respuesta.'],
  [/queue_unsupported/i, 'Este proveedor no puede entregar instrucciones entre turnos: no se puede encolar.'],
  [/attempt_final/i, 'El intento ya terminó: no admite instrucciones ni respuestas.'],
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
  [/busy\/not_running/i, 'El intento no tiene una ejecución viva ahora (no ha arrancado o ya se cerró): no admite instrucciones ni respuestas.'],
  [/in_progress/i, 'Esa petición ya se está atendiendo.'],
  [/context_package_source_mismatch/i, 'El paquete de contexto no sale de este intento (o de este proyecto): revisa que sea el correcto.'],
  [/context_package_invalid/i, 'El paquete de contexto no pasa la verificación del Core: no se puede usar.'],
  [/review_not_current/i, 'Solo se revisa el intento actual de la tarea: la rama es la suya.'],
  [/review_not_final/i, 'El intento todavía no terminó: espera a que acabe para aceptar un HEAD que ya no cambie.'],
  [/confirmación explícita/i, 'Hay que confirmar la decisión.'],
  [/integration_not_current/i, 'Solo se integra el intento actual de la tarea: la rama es la suya.'],
  [/integration_not_final/i, 'El intento todavía no terminó: espera a que acabe para integrar un HEAD que ya no cambie.'],
  [/integration_no_branch/i, 'Este intento no tiene una rama que integrar.'],
  [/resource_blocked: degraded/i, 'El Core está en solo lectura: no puede registrar el cambio, así que no se borra nada.'],
  [/resource_blocked: running/i, 'La tarea sigue en marcha o tiene un proceso vivo: páralo antes de tocar su worktree.'],
  [/resource_blocked: unknown/i, 'No se pudo comprobar el estado del worktree o de la rama: por seguridad no se borra nada.'],
  [/resource_blocked: dirty/i, 'El worktree tiene cambios sin commit: confírmalo aparte si quieres descartarlos.'],
  [/resource_blocked: not_merged/i, 'El trabajo de la rama no consta integrado: no se limpia.'],
  [/adopt_dirty/i, 'El worktree tiene cambios sin commit: guárdalos o descártalos antes de adoptarlo.'],
  [/adopt_unknown/i, 'No se pudo comprobar el worktree: por seguridad no se adopta a ciegas.'],
  [/adopt_not_a_worktree/i, 'Esa carpeta ya no es un worktree de este proyecto.'],
  [/adopt_main_checkout/i, 'Es el checkout principal del proyecto, no un worktree adicional.'],
  [/adopt_missing/i, 'La carpeta del worktree ya no está en disco.'],
  [/adopt_detached/i, 'El worktree no está en una rama: no hay qué revisar ni integrar.'],
  [/adopt_already_owned/i, 'Una tarea ya posee este worktree.'],
  [/adopt_branch_taken/i, 'Otra tarea ya usa esta rama.'],
  [/adopt_no_base|adopt_is_base|adopt_no_changes/i, 'La rama no tiene trabajo propio respecto a la rama base: no hay nada que adoptar.'],
  [/adopt_locked/i, 'El worktree está bloqueado (git worktree lock): quien lo bloqueó lo quiere conservar.'],
  [/adopt_project_unavailable/i, 'No se encuentra el proyecto en esta máquina: indica dónde está antes de adoptar.'],
  [/adopt_degraded/i, 'El Core está en solo lectura: no puede registrar la adopción.'],
  [/adopt_task_not_eligible/i, 'Esa tarea ya tiene ejecuciones o un worktree, o es de otro repositorio: solo se adopta en una tarea sin ejecución del mismo repositorio.'],
  [/adopt_task_not_found/i, 'Esa tarea ya no existe.'],
  [/resource_git_failed/i, 'Git no pudo quitar el worktree: se conserva todo.'],
  [/resource_not_found/i, 'Esa tarea ya no existe.'],
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

/**
 * Crea SOLO la Task (sin Attempt, sin worktree, sin ejecutar nada): la intención de trabajo queda `not_started` en el Project. Después solo se le
 * puede adoptar un worktree externo (Adopt): todavía no hay un RPC para darle su primer intento. El Core fija el repositorio (la ubicación verificada del Project). Misma clave de
 * idempotencia que `createTaskWithAttempt`. Devuelve `{ status, run_id, task_id, attempt_id: null }`.
 */
export async function createTaskOnly({ requestId, projectId, title, objective, spec = '' }) {
  const response = await call('task_create', { request_id: requestId, project_id: projectId, objective, title, spec });
  if (!response || typeof response.task_id !== 'string') {
    throw new Error('ade_command_invalid_response: task_create no devolvió la Task');
  }
  return response;
}

/** Aprueba el primer Attempt. `status`: `Approved` · `Replayed` · `Expired`. Aprobar no lanza nada por sí mismo. */
export const approveAttempt = (attemptId) => call('attempt_approve', { attempt_id: attemptId });

/** Rechaza el primer Attempt. `status`: `Rejected` · `Replayed` · `Expired`. */
export const rejectAttempt = (attemptId) => call('attempt_reject', { attempt_id: attemptId });

/**
 * Comparte el worktree de otro intento con éste, ANTES de aprobarlo (`attempt_share_worktree`, LXO-248): el intento trabajará en la misma carpeta, en serie
 * (nunca dos vivos a la vez) y dentro del mismo Project. No es dueño de la carpeta: nada de lo que haga lo borra. Solo una persona en Desktop, con
 * confirmación. Devuelve `{ status: 'Shared' | 'AlreadyShared', attempt_id, worktree_id, owner_task_id }`.
 */
export const shareWorktree = (attemptId, fromAttemptId) => call('attempt_share_worktree', { attempt_id: attemptId, from_attempt_id: fromAttemptId, confirm: true });

/**
 * Los worktrees que ese intento podría compartir (`attempt_share_candidates`, LXO-248): activos y del mismo Project, cada uno con el intento que se pasa a
 * `shareWorktree` (`from_attempt_id`) y `busy_by` si otro intento vivo lo usa ahora (en serie: la interfaz lo muestra deshabilitado). Una lectura.
 * Devuelve `{ attempt_id, candidates: [{ from_attempt_id, worktree_id, owner_task_id, owner_task_title, branch, path, busy_by }] }`.
 */
export const listShareCandidates = (attemptId) => call('attempt_share_candidates', { attempt_id: attemptId });

/** Responde la pregunta abierta de un agente (`reply`). Lo manda la persona en nombre del destinatario de la pregunta. */
export const answerQuestion = (questionId, answer) => call('reply', { question: questionId, answer });

/**
 * Lo que el proveedor de un intento le pide a la persona y espera (`attempt_pending_requests`, LXO-247): permisos y preguntas. Una lectura.
 * Devuelve `{ attempt_id, live, requests: [{ request_id, kind: 'permission' | 'question', subject, summary, asked_at }] }`.
 */
export const pendingProviderRequests = (attemptId) => call('attempt_pending_requests', { attempt_id: attemptId });

/**
 * Responde a UNA petición del proveedor (`attempt_answer`, LXO-247). Un permiso se responde `allow` o `deny`; una pregunta, con texto libre
 * (hasta 4 000 caracteres). Solo una persona en Desktop. Repetir la misma respuesta devuelve `Replayed` sin volver a llamar al proveedor.
 * PERMITIR un permiso es la categoría `provider_permissions` de la policy (piso «pedir confirmación»): hay que mandar `confirm: true`, la decisión
 * explícita de la persona. Denegar o contestar una pregunta (`answer`) no la piden. Devuelve `{ status: 'Answered' | 'Replayed', attempt_id, request_id, kind }`.
 */
export const answerProviderRequest = (attemptId, requestId, answer, { confirm = false } = {}) => call('attempt_answer', {
  attempt_id: attemptId,
  request_id: requestId,
  answer,
  ...(confirm ? { confirm: true } : {}),
});

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

/**
 * Integra un Attempt revisado (`attempt_integrate`): `action` es `merge` o `publish_pr`, y `headCommit` el HEAD que la persona vio (el único que se
 * integra). Los resultados son los del efecto: `merged` · `conflict` · `error` · `target_moved` · `target_branch_mismatch` · `already_merged` (merge);
 * `created` · `already_exists` · `error` (PR); y, sin efecto, `head_moved` · `review_required`. Repetir no duplica. No limpia el worktree.
 * `acceptMovedTarget` es el commit del destino que la persona vio y acepta tras un `target_moved`.
 */
export const integrateAttempt = ({ attemptId, action, headCommit, squash = false, acceptMovedTarget }) => call('attempt_integrate', {
  attempt_id: attemptId,
  action,
  head_commit: headCommit,
  confirm: true,
  ...(action === 'merge' && squash ? { squash: true } : {}),
  ...(action === 'merge' && typeof acceptMovedTarget === 'string' && acceptMovedTarget ? { accept_moved_target: acceptMovedTarget } : {}),
});

/**
 * Limpia lo integrado (`resource_clean`): quita el worktree LIMPIO de trabajo INTEGRADO y borra su rama con `branch -d` (nunca `-D`). Devuelve
 * `{ outcome: 'cleaned' | 'forgotten' | 'nothing_to_do', worktree_removed, branch_deleted, branch_kept }`. Repetir no hace nada.
 */
export const cleanResource = (taskId) => call('resource_clean', { task_id: taskId, confirm: true });

/**
 * Quita la carpeta del worktree y CONSERVA la rama (`resource_delete_worktree`). Con cambios sin commit hace falta `discardUncommitted: true`,
 * una decisión aparte. Devuelve `{ outcome: 'deleted' | 'forgotten' | 'nothing_to_do', worktree_removed, branch_kept, discarded_uncommitted }`.
 */
export const deleteWorktree = (taskId, discardUncommitted = false) => call('resource_delete_worktree', {
  task_id: taskId,
  confirm: true,
  ...(discardUncommitted ? { discard_uncommitted: true } : {}),
});

/**
 * Adopta un worktree externo (`resource_adopt`): pasa a ser el primer Attempt, ya terminado, de una Task sin ejecución del mismo Project. El Core exige
 * el worktree LIMPIO y vuelve a comprobarlo todo; aquí solo viaja la decisión confirmada. Devuelve `{ status: 'Adopted' | 'AlreadyAdopted', task_id,
 * attempt_id, branch?, base? }`. Repetir no hace nada.
 */
export const adoptWorktree = ({ projectId, path, taskId }) => call('resource_adopt', { project_id: projectId, path, task_id: taskId, confirm: true });

/**
 * Fija el nivel de una acción en un ámbito (`policy_set`) o vuelve a heredar (`policy_reset`, `level: null`). `expectedRevision` es la revisión que la
 * interfaz leyó: si la policy cambió, el Core responde `policy_stale` y no pisa nada. Aflojar la restricción exige `confirm: true`.
 * Devuelve `{ status: 'Changed' | 'Unchanged', revision }`.
 */
export const changePolicy = ({ scope, category, level = null, expectedRevision, confirm = false }) => call(level === null ? 'policy_reset' : 'policy_set', {
  scope,
  category,
  ...(level === null ? {} : { level }),
  expected_revision: expectedRevision,
  ...(confirm ? { confirm: true } : {}),
});

/**
 * Lanza un Race (`task_race`): de 2 a 4 candidatos comparables que salen del mismo intento (y del mismo paquete, si lo hay). Cada candidato es un Fork
 * real, pendiente de tu aprobación. `requestId` es la clave de idempotencia: repetir la MISMA petición no duplica a los ya creados y reintenta los
 * fallidos. Los campos vacíos de cada candidato se omiten (se heredan). No acepta host, worktree ni perfil.
 * Devuelve el estado del Race (`task_race_status`) más `status: 'Requested' | 'Retried'` y `replayed`.
 */
export async function startRace({ requestId, sourceAttemptId, candidates, package: contextPackage, confirm = false }) {
  const list = candidates.map((c) => {
    const out = {};
    for (const key of ['provider', 'model', 'effort', 'role', 'title']) {
      const text = typeof c?.[key] === 'string' ? c[key].trim() : '';
      if (text) out[key] = text;
    }
    return out;
  });
  const args = { request_id: requestId, source_attempt_id: sourceAttemptId, candidates: list };
  if (typeof contextPackage === 'string' && contextPackage.trim()) args.package = contextPackage;
  if (confirm) args.confirm = true;
  const response = await call('task_race', args);
  validateRace(response, { allowExtra: true });
  return response;
}

/**
 * Cancela UN candidato o todos los que no han terminado (`task_race_cancel`). Siempre explícito: nada se cancela porque otro termine. Un candidato
 * pendiente de aprobación se rechaza y uno en marcha se detiene. Devuelve `{ status: 'Cancelled', race_id, results, race }`.
 */
export async function cancelRace(raceId, attemptId = null) {
  const response = await call('task_race_cancel', { race_id: raceId, ...(attemptId ? { attempt_id: attemptId } : {}) });
  if (!response || !Array.isArray(response.results)) throw new Error('ade_command_invalid_response: task_race_cancel no devolvió los resultados');
  validateRace(response.race);
  return response;
}
