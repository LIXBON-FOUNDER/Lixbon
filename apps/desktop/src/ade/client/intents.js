// intents.js — catálogo de intents del ADE y de qué slice los hace reales.
//
// IMPORTANTE: son intents de INTERFAZ, no la API definitiva del Core. Sirven para decidir qué botón se
// ofrece y para rotular lo que aún no existe. El Core real dirá qué está permitido con getCapabilities().

/** Slices que habilitan capacidades (nombres de la Fase 1). */
export const SLICES = Object.freeze({
  D: 'D',
  E: 'E',
  F: 'F',
  G: 'G',
  TASK_ATTEMPT: 'Task/Attempt',
  CONTEXT_PACKAGE: 'ContextPackage',
  DAEMON: 'daemon',
  // No es un slice del Core: lo pone el shell del Desktop (cliente), no el Core.
  PUENTE_IDE: 'puente IDE↔ADE (shell del Desktop)',
});

/** Disponibilidad de una capacidad. `simulated` solo lo emite el mock; el Core real emite available/unavailable. */
export const AVAILABILITY = Object.freeze({ available: 'available', simulated: 'simulated', unavailable: 'unavailable' });

/**
 * owner: 'core' = decisión que cambia el estado del Core (pasa por AdeClient.dispatch);
 *        'host' = capacidad del cliente (abrir diff/IDE/terminal; pasa por AdeHost.perform).
 * hoy: situación en el producto vigente.   slice: quién la hace real para todas las superficies (o la habilita).
 * reserved: true = no se puede ofrecer antes del corte indicado; nunca se finge.
 */
export const INTENTS = Object.freeze({
  approve_spawn: {
    owner: 'core', label: 'Aprobar lanzamiento', requires: ['attemptId', 'confirmedCommand'], requiresConfirmation: true,
    hoy: 'vigente en Desktop (orch_spawn_*)', slice: SLICES.F, nota: 'Móvil: solo lanzamientos no elevados (alcances, F).',
  },
  reject_spawn: {
    owner: 'core', label: 'Rechazar lanzamiento', requires: ['attemptId'], requiresConfirmation: false,
    hoy: 'vigente en Desktop (orch_spawn_*)', slice: SLICES.F,
  },
  answer_question: {
    owner: 'core', label: 'Responder', requires: ['attemptId', 'text'], requiresConfirmation: false,
    hoy: 'vigente en Desktop', slice: SLICES.F, nota: 'Móvil y CLI dependen de alcances; el Thread es del corte Task/Attempt.',
  },
  review_attempt: {
    owner: 'core', label: 'Revisar', requires: ['attemptId', 'decision', 'headCommit'], requiresConfirmation: true,
    hoy: 'vigente en Desktop (review.rs)', slice: SLICES.F, nota: 'Solo se acepta sobre el commit mostrado; rechazar es directo.',
  },
  integrate_attempt: {
    owner: 'core', label: 'Integrar', requires: ['attemptId', 'headCommit', 'confirm'], requiresConfirmation: true,
    hoy: 'vigente en Desktop (IntegrationDialog)', slice: SLICES.F, nota: 'CLI humano exige confirmación fuera de banda.',
  },
  launch_task: {
    owner: 'core', label: 'Lanzar trabajo nuevo', requires: ['projectId', 'title', 'agent'], requiresConfirmation: false,
    hoy: 'vigente, pero el host deduce el repo del cwd', slice: SLICES.D, nota: 'Proyecto explícito requiere D.',
  },
  stop_attempt: {
    owner: 'core', label: 'Detener', requires: ['attemptId'], requiresConfirmation: true,
    hoy: 'vigente en Desktop y gateway móvil (stop)', slice: null,
  },
  mark_attention_seen: {
    owner: 'core', label: 'Marcar como visto', requires: ['attentionId'], requiresConfirmation: false,
    hoy: 'no existe', slice: SLICES.G, nota: 'Estado por persona y dispositivo (G + F).',
  },
  snooze_attention: {
    owner: 'core', label: 'Posponer', requires: ['attentionId'], requiresConfirmation: false,
    hoy: 'no existe', slice: SLICES.G,
  },

  // Reservados: el Core aún no los ofrece. Se muestran deshabilitados, jamás simulados.
  retry_attempt: {
    owner: 'core', label: 'Reintentar', requires: ['attemptId'], reserved: true,
    hoy: 'no existe', slice: SLICES.TASK_ATTEMPT,
  },
  resume_attempt: {
    owner: 'core', label: 'Reanudar', requires: ['attemptId'], reserved: true,
    hoy: 'no existe', slice: SLICES.TASK_ATTEMPT, nota: 'Necesita ProviderSession.',
  },
  continue_with_other_agent: {
    owner: 'core', label: 'Continuar con otro agente', requires: ['attemptId'], reserved: true,
    hoy: 'no existe', slice: SLICES.CONTEXT_PACKAGE, nota: 'Llega después del corte Task/Attempt.',
  },
  race_attempts: {
    owner: 'core', label: 'Competir N agentes', requires: ['taskId'], reserved: true,
    hoy: 'no existe', slice: SLICES.TASK_ATTEMPT, nota: 'Un worktree por intento.',
  },
  compare_attempts: {
    owner: 'core', label: 'Comparar intentos', requires: ['taskId'], reserved: true,
    hoy: 'no existe', slice: SLICES.TASK_ATTEMPT,
  },

  register_project: {
    owner: 'core', label: 'Registrar proyecto', requires: ['path'], reserved: true,
    hoy: 'no existe (el frontend usa la ruta del repo)', slice: SLICES.D, nota: 'Registro de Project y ProjectLocation.',
  },

  // Capacidades del cliente (AdeHost): el Core no es dueño de ellas.
  open_diff: { owner: 'host', label: 'Abrir diff', requires: ['attemptId'], hoy: 'vigente en el IDE (TaskDiffView), sin puente', slice: SLICES.PUENTE_IDE },
  open_worktree: { owner: 'host', label: 'Abrir worktree', requires: ['attemptId'], hoy: 'sin puente', slice: SLICES.PUENTE_IDE },
  open_in_ide: { owner: 'host', label: 'Abrir en el IDE', requires: ['attemptId'], hoy: 'sin puente', slice: SLICES.PUENTE_IDE },
  open_terminal: { owner: 'host', label: 'Ir a la terminal', requires: ['attemptId'], hoy: 'vigente en el IDE (AgentTerminal), sin puente', slice: SLICES.PUENTE_IDE },
});

export const INTENT_IDS = Object.freeze(Object.keys(INTENTS));
export const CORE_INTENT_IDS = Object.freeze(INTENT_IDS.filter((id) => INTENTS[id].owner === 'core'));
export const HOST_INTENT_IDS = Object.freeze(INTENT_IDS.filter((id) => INTENTS[id].owner === 'host'));
export const RESERVED_INTENT_IDS = Object.freeze(INTENT_IDS.filter((id) => INTENTS[id].reserved));

/** Construye una Capability (forma que devolverá getCapabilities()). */
export function capability(intent, availability, reason = '') {
  const def = INTENTS[intent];
  return {
    intent,
    availability,
    slice: def?.slice ?? null,
    reason,
    requiresConfirmation: Boolean(def?.requiresConfirmation),
  };
}

/** Capacidad por omisión de un intent que el cliente no declaró: no disponible, con su slice. */
export function unavailableCapability(intent, reason) {
  const def = INTENTS[intent];
  return capability(intent, AVAILABILITY.unavailable, reason || (def?.slice ? `Requiere ${def.slice}.` : 'No disponible.'));
}

/** Comprueba que el intent existe y trae sus argumentos obligatorios. Devuelve null si es válido, o un texto. */
export function validateIntent(intent) {
  const def = INTENTS[intent?.type];
  if (!def) return `Intent desconocido: ${String(intent?.type)}`;
  const faltan = def.requires.filter((k) => intent[k] === undefined || intent[k] === null || intent[k] === '');
  return faltan.length ? `Faltan argumentos de ${intent.type}: ${faltan.join(', ')}` : null;
}
