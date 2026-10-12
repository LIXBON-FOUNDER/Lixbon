// attentionActions.js — qué botones se ofrecen para cada kind de Attention.
//
// PRESENTACIÓN, transitoria hasta el slice G: hoy no existe ninguna API de «acciones de una Attention»,
// así que este es el ÚNICO mapa kind → acciones de la interfaz. El Core solo decide si una acción está
// permitida (AdeClient.getCapabilities); no se deduce nada de la plataforma. Si G entrega las acciones
// propuestas por el Core, se sustituye este archivo y nada más.
import { routes, routeForAttention } from '../navigation/routes';

/**
 * Cada acción: { id, label, tipo, ... }
 *  - tipo 'nav'    -> navega dentro del ADE a `route`.
 *  - tipo 'intent' -> decisión del Core (AdeClient.dispatch) con los `args` que ya conoce la vista.
 *  - tipo 'host'   -> capacidad del cliente (AdeHost.perform): abrir diff, terminal, IDE…
 *  - tipo 'inline' -> la tarjeta pide más datos (respuesta de texto).
 * `intent` es el id del catálogo (client/intents.js) que fija su disponibilidad.
 */
export function attentionActions({ item, attempt }) {
  const a = item.attemptId;
  const ver = { id: 'ver_intento', label: 'Ver intento', tipo: 'nav', route: a ? routes.attempt(a) : routeForAttention(item) };
  switch (item.kind) {
    case 'approve_in_terminal':
      return [
        { id: 'ir_terminal', label: 'Ir a la terminal', tipo: 'host', intent: 'open_terminal', args: { attemptId: a }, primary: true },
        ver,
      ];
    case 'review':
      return [
        { id: 'revisar', label: 'Revisar diff', tipo: 'nav', route: routes.review(a), primary: true },
        { id: 'diff_ide', label: 'Abrir diff en el IDE', tipo: 'host', intent: 'open_diff', args: { attemptId: a } },
        ver,
      ];
    case 'integrate':
      return [
        { id: 'integrar', label: 'Integrar', tipo: 'nav', route: routes.integration(a), primary: true },
        { id: 'diff_ide', label: 'Abrir diff en el IDE', tipo: 'host', intent: 'open_diff', args: { attemptId: a } },
        ver,
      ];
    case 'failed':
      return [
        ver,
        { id: 'reintentar', label: 'Reintentar', tipo: 'intent', intent: 'retry_attempt', args: { attemptId: a } },
        { id: 'continuar_otro', label: 'Continuar con otro agente', tipo: 'intent', intent: 'continue_with_other_agent', args: { attemptId: a } },
      ];
    case 'pending_spawn':
      return [
        { id: 'aprobar', label: 'Aprobar', tipo: 'intent', intent: 'approve_spawn', args: { attemptId: a, confirmedCommand: attempt?.policy?.command }, primary: true },
        { id: 'rechazar', label: 'Rechazar', tipo: 'intent', intent: 'reject_spawn', args: { attemptId: a } },
        ver,
      ];
    case 'unanswered_question':
      return [
        { id: 'responder', label: 'Responder', tipo: 'inline', intent: 'answer_question', args: { attemptId: a }, primary: true },
        ver,
      ];
    default:
      return [ver];
  }
}
