// Los dos canales remotos que pueden reemplazar la snapshot del orquestador (`channel_status` y `orch`) y la validez del `seq`
// (LXO-243). Puro y sin dependencias: lo ejecutan las pruebas con `node --test` sin montar el cliente.

import { sanitizeOrchSnapshot } from './remotePrUrl.js';

/**
 * ¿Es utilizable el `seq` de un evento? Sin `seq` vale (algunos eventos no van numerados). Con `seq`, debe ser un entero seguro
 * >= 0: un `NaN`, un `Infinity`, un negativo, un decimal, un texto o un `null` NO se aplican ni envenenan `lastSeq` (con `NaN` ninguna
 * comparación volvería a descartar un duplicado; con `Infinity` se descartaría todo lo que llegue después).
 */
export function hasValidSeq(ev) {
  if (!Object.prototype.hasOwnProperty.call(ev, 'seq') || ev.seq === undefined) return true;
  return Number.isSafeInteger(ev.seq) && ev.seq >= 0;
}

/**
 * Aplica un `channel_status` o un `orch`. Ambos pueden traer una snapshot y las dos pasan por la allowlist de `pr_url`
 * (`sanitizeOrchSnapshot`); una snapshot que no se puede sanear no reemplaza a la que ya hay.
 *
 * - `orch` con `seq` repetido o anterior al último aplicado no reemplaza la snapshot ni mueve el cursor.
 * - `channel_status` llega primero al (re)conectar con el `seq` más alto del canal: NO avanza `lastSeq`, o el replay de lo perdido que
 *   viene detrás se descartaría entero como duplicado. Actualiza el estado del host y, si trae una snapshot válida, la reemplaza.
 */
export function reduceRemoteOrchEvent(state, ev) {
  if (!hasValidSeq(ev)) return state;
  const numbered = typeof ev.seq === 'number';

  if (ev.type === 'channel_status') {
    const orch = ev.orch === undefined || ev.orch === null ? null : sanitizeOrchSnapshot(ev.orch);
    return {
      ...state,
      hostConnected: !!ev.host_connected,
      session: ev.session || state.session,
      meta: ev.meta && Object.keys(ev.meta).length ? ev.meta : state.meta,
      orch: orch || state.orch,
    };
  }

  if (ev.type !== 'orch') return state;
  if (numbered && ev.seq <= state.lastSeq) return state; // replay o evento fuera de orden: no pisa la snapshot
  const orch = sanitizeOrchSnapshot(ev);
  if (!orch) return state;
  return { ...state, ...(numbered ? { lastSeq: ev.seq } : {}), orch };
}
