/**
 * Modelo de capabilities del ADE (LXO-135): de la matriz que reporta el Core a lo que la interfaz muestra y habilita.
 *
 * REGLAS (las invariantes de la issue, comprobadas en `capabilityModel.test.js`):
 * 1. Una capability solo habilita una acción si el Core la declara `available`. `unsupported`, `unavailable`,
 *    `environment_blocked` y «el Core no sabe» NUNCA habilitan nada.
 * 2. Este archivo no conoce ningún proveedor por su nombre. El proveedor de un Attempt se busca por su id EXACTO en lo que
 *    informa el Core; si no aparece, el estado es `unknown`, no «el que sería por defecto». Ni nombre ni versión deciden.
 * 3. Un bloqueo del entorno NO es un Attempt fallido ni una capability inexistente: tiene su propio estado, su propio texto y
 *    su propia forma visual (ver `Capabilities.css`).
 * 4. Un estado que el contrato no define se trata como `unknown` (deshabilitado): nunca se interpreta.
 *
 * Puro y sin dependencias de React ni de Tauri.
 */
import { CAPABILITIES, CAPABILITY_STATES } from './providerCapabilitiesContract';

export const CAPABILITY_LABELS = Object.freeze({
  start: 'Iniciar',
  events: 'Seguir la ejecución',
  answer: 'Responder permisos',
  interrupt: 'Interrumpir',
  steer: 'Dirigir en curso',
  resume: 'Reanudar sesión',
});

/** Qué hace cada capability, en una frase, para el tooltip y el inspector. */
export const CAPABILITY_HELP = Object.freeze({
  start: 'Lanzar una ejecución nueva.',
  events: 'Recibir en directo lo que hace la ejecución.',
  answer: 'Responder desde Lixbon a las peticiones de permiso del proveedor.',
  interrupt: 'Detener el turno en curso sin cerrar la sesión.',
  steer: 'Cambiar de rumbo una ejecución mientras trabaja.',
  resume: 'Continuar la conversación de una sesión anterior del proveedor.',
});

export const STATE_LABELS = Object.freeze({
  available: 'Disponible',
  unsupported: 'No ofrecida',
  unavailable: 'No disponible ahora',
  environment_blocked: 'Bloqueada por el entorno',
  unknown: 'Sin información',
});

/** El estado en una o dos palabras, para las celdas de una tabla donde la columna ya dice de qué capability se trata. */
export const STATE_SHORT = Object.freeze({
  available: 'Sí',
  unsupported: 'No ofrece',
  unavailable: 'Ahora no',
  environment_blocked: 'Bloqueada',
  unknown: 'Sin datos',
});

/** Tono y forma por estado. El color acompaña: lo que distingue es el texto, el glifo y el borde (Capabilities.css). */
export const STATE_TONES = Object.freeze({
  available: 'good',
  unsupported: 'muted',
  unavailable: 'warn',
  environment_blocked: 'info',
  unknown: 'unknown',
});

export const STATE_GLYPHS = Object.freeze({
  available: '✓',
  unsupported: '–',
  unavailable: '!',
  environment_blocked: '⊘',
  unknown: '?',
});

/** Texto de cada bloqueo de entorno del Core. Uno desconocido no se inventa: se nombra por su código. */
const BLOCK_COPY = Object.freeze({
  cli_missing: 'no se encuentra la CLI del proveedor',
  cli_flags_unsupported: 'la CLI instalada no admite las opciones que Lixbon necesita',
  windows_sandbox_elevated: 'el sandbox de Windows requiere elevación',
  windows_sandbox_setup: 'el sandbox de Windows no está listo o está en uso',
});

export const blockText = (code) => BLOCK_COPY[code] ?? `bloqueo del entorno «${code}»`;

/** El proveedor `id` de lo que informa el Core, por id exacto. Nada de buscar «parecidos». */
export function providerOf(snapshot, id) {
  if (!snapshot || !Array.isArray(snapshot.providers) || typeof id !== 'string') return null;
  return snapshot.providers.find((p) => p.id === id) ?? null;
}

/**
 * Qué se sabe de UNA capability de UN proveedor y qué se puede hacer con ella. `provider` es la entrada del Core (o `null`
 * si el Core no informa de él). `enabled` es lo único que una acción debe mirar.
 */
export function describeCapability(provider, capability, providerId = provider?.id ?? null) {
  const label = CAPABILITY_LABELS[capability] ?? capability;
  const who = providerId ?? 'El proveedor';
  const base = { capability, label, help: CAPABILITY_HELP[capability] ?? '', providerId };
  const state = provider?.matrix?.capabilities?.[capability];
  if (!provider || !state || !CAPABILITY_STATES.includes(state.state) || !CAPABILITIES.includes(capability)) {
    return {
      ...base,
      state: 'unknown',
      enabled: false,
      stateLabel: STATE_LABELS.unknown,
      stateShort: STATE_SHORT.unknown,
      tone: STATE_TONES.unknown,
      glyph: STATE_GLYPHS.unknown,
      reason: provider
        ? `El Core no informa de «${label}» para ${who}.`
        : `El Core todavía no informa de lo que ofrece ${who}.`,
    };
  }
  const reasons = {
    available: `${who} ofrece «${label}».`,
    unsupported: `${who} no ofrece «${label}»: no es un fallo, el proveedor no la tiene.`,
    unavailable: `«${label}» no está disponible ahora${state.reason ? `: ${state.reason}` : ''}.`,
    environment_blocked: `«${label}» está bloqueada por el entorno: ${blockText(state.block)}. No es un intento fallido.`,
  };
  return {
    ...base,
    state: state.state,
    enabled: state.state === 'available',
    stateLabel: STATE_LABELS[state.state],
    stateShort: STATE_SHORT[state.state],
    tone: STATE_TONES[state.state],
    glyph: STATE_GLYPHS[state.state],
    reason: reasons[state.state],
  };
}

/** Las seis capabilities de un proveedor, en el orden de la matriz. */
export const describeAll = (provider, providerId = provider?.id ?? null) => CAPABILITIES.map((c) => describeCapability(provider, c, providerId));

/** ¿Puede la interfaz ofrecer esta acción para este proveedor AHORA? Solo si el Core la declara `available`. */
export const canDo = (snapshot, providerId, capability) => describeCapability(providerOf(snapshot, providerId), capability, providerId).enabled;

/** Resumen del entorno de un proveedor: listo, o bloqueado con los textos de cada bloqueo. */
export function describeEnvironment(provider) {
  if (!provider) return { state: 'unknown', label: STATE_LABELS.unknown, blocks: [] };
  if (provider.environment?.state === 'blocked') {
    const blocks = (provider.environment.blocks ?? []).map((code) => ({ code, text: blockText(code) }));
    return { state: 'blocked', label: 'Entorno bloqueado', blocks };
  }
  return { state: 'ready', label: 'Entorno listo', blocks: [] };
}

/**
 * ¿Se puede reanudar la sesión de este Attempt? Combina lo que el PROVEEDOR ofrece (capability `resume`) con lo que la SESIÓN
 * es (`attempt.provider_session`, del Core). Es información para la persona, no una orden: quien decide cómo se continúa
 * es el Core (docs/core/CONTINUIDAD.md).
 *
 * `kind`: resumable · in_use · no_session · not_resumable · not_bound · closed · unsupported · unavailable ·
 *         environment_blocked · unknown
 */
export function resumeAvailability(provider, session, providerId = provider?.id ?? null) {
  const cap = describeCapability(provider, 'resume', providerId);
  if (cap.state !== 'available') {
    return { kind: cap.state, tone: cap.tone, glyph: cap.glyph, label: `Reanudar: ${cap.stateLabel.toLowerCase()}`, reason: cap.reason, enabled: false };
  }
  const made = (kind, tone, glyph, label, reason, enabled = false) => ({ kind, tone, glyph, label, reason, enabled });
  if (!session) return made('no_session', 'muted', '–', 'Sin sesión que reanudar', 'Este intento no corrió en una sesión del proveedor: se continuaría con un paquete de contexto.');
  if (session.status === 'closed') return made('closed', 'muted', '–', 'Sesión cerrada', 'La sesión está cerrada y ya no se reanuda: se continuaría con un paquete de contexto.');
  if (session.resumable !== true) return made('not_resumable', 'muted', '–', 'Sesión no reanudable', 'El proveedor no dejó esta sesión reanudable: se continuaría con un paquete de contexto.');
  if (session.bound !== true) return made('not_bound', 'warn', '!', 'Sesión sin vincular', 'El proveedor todavía no entregó la referencia de la sesión.');
  if (session.status === 'open') return made('in_use', 'info', '⊘', 'Sesión en uso', 'Un intento activo está corriendo en esta sesión.');
  return made('resumable', 'good', '✓', 'Reanudable', 'El proveedor ofrece reanudar y la sesión está en espera.', true);
}
