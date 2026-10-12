// AdeHost.js — puerto de las CAPACIDADES DEL CLIENTE (no del Core).
//
// «Clients own capabilities and presentation»: abrir el diff en el IDE, enfocar la terminal del agente o
// el worktree en el explorador es cosa del shell que aloja al ADE, no del Core. El ADE solo pide:
// `host.perform({ type: 'open_diff', attemptId })`. Hoy no existe el puente IDE↔ADE, así que el
// host por omisión (NullHost) declara todo como no disponible, y las pantallas lo muestran tal cual.
import { adeError } from '../client/contract';
import { HOST_INTENT_IDS, INTENTS, AVAILABILITY, capability } from '../client/intents';

export const RAZON_SIN_PUENTE = 'El puente IDE↔ADE todavía no está conectado.';

/** Host sin puente: todas las navegaciones son «no disponibles». Es el de la vista previa. */
export function createNullHost() {
  return {
    kind: 'null',
    getCapabilities() {
      return Object.fromEntries(HOST_INTENT_IDS.map((id) => [id, capability(id, AVAILABILITY.unavailable, RAZON_SIN_PUENTE)]));
    },
    async perform(intent) {
      throw adeError('unavailable', `${INTENTS[intent?.type]?.label ?? 'La acción'}: ${RAZON_SIN_PUENTE}`, { slice: INTENTS[intent?.type]?.slice ?? null });
    },
  };
}

/** Host de pruebas: acepta los intents de navegación y los registra. No es una simulación para la persona. */
export function createRecordingHost(disponibles = HOST_INTENT_IDS) {
  const llamadas = [];
  return {
    kind: 'recording',
    llamadas,
    getCapabilities() {
      return Object.fromEntries(HOST_INTENT_IDS.map((id) => [id, disponibles.includes(id)
        ? capability(id, AVAILABILITY.available) : capability(id, AVAILABILITY.unavailable, RAZON_SIN_PUENTE)]));
    },
    async perform(intent) {
      llamadas.push(intent);
      return { ok: true, intent: intent.type };
    },
  };
}
