// observe/link.js — petición/respuesta con el Core por la sesión /remote (LXO-107).
//
// El móvil manda `orch` + `core_snapshot` / `core_events` con un `rid` y el IDE responde con un evento
// efímero (`orch_core_snapshot` / `orch_core_events`) con ese mismo `rid`. Aquí se emparejan y se traduce
// cada fallo a una clase que entiende el bootstrap: transporte (offline), autorización o versión.
// Sin dependencias de React Native: se prueba con `node --test`.

export const RELAY_PROTOCOL = 1;
const RESPONSES = { orch_core_snapshot: 'core_snapshot', orch_core_events: 'core_events', orch_core_attention: 'core_attention' };
const DEFAULT_TIMEOUT_MS = 20000;

let ridSeq = 0;
const defaultRid = () => `c${Date.now().toString(36)}${(++ridSeq).toString(36)}`;

/** Clase de un acuse fallido del gateway. */
function ackFailure(ack) {
  if (ack?.status === 401 || ack?.status === 403) return { ok: false, code: 'unauthorized' };
  // 422: el gateway no conoce la acción (es anterior a LXO-107).
  if (ack?.status === 422) return { ok: false, code: 'unsupported_action' };
  if (ack?.status === 409) return { ok: false, transport: 'host_offline' };
  return { ok: false, transport: 'offline' };
}

/**
 * `send(command)` entrega un comando al gateway y resuelve su acuse `{ ok, status?, detail?, retry? }`.
 * `clock` permite pruebas sin temporizadores reales.
 */
export function createCoreLink({ send, timeoutMs = DEFAULT_TIMEOUT_MS, clock = globalThis, newRid = defaultRid }) {
  const pending = new Map(); // rid → { action, resolve, timer }
  let closed = false;

  const settle = (rid, result) => {
    const p = pending.get(rid);
    if (!p) return;
    clock.clearTimeout(p.timer);
    pending.delete(rid);
    p.resolve(result);
  };

  return {
    request(action, args = {}) {
      return new Promise((resolve) => {
        if (closed) {
          resolve({ ok: false, transport: 'closed' });
          return;
        }
        const rid = newRid();
        const timer = clock.setTimeout(() => settle(rid, { ok: false, transport: 'timeout' }), timeoutMs);
        pending.set(rid, { action, resolve, timer });
        Promise.resolve()
          .then(() => send({ type: 'orch', action, args: { ...args, rid } }))
          .then((ack) => {
            if (!ack?.ok) settle(rid, ackFailure(ack));
          })
          .catch(() => settle(rid, { ok: false, transport: 'offline' }));
      });
    },

    /** Devuelve `true` si el evento era una respuesta de este enlace (y no debe ir al transcript). */
    handleEvent(ev) {
      if (!ev || typeof ev !== 'object') return false;
      const action = RESPONSES[ev.type];
      if (action) {
        const p = pending.get(ev.rid);
        if (p && p.action === action) {
          if (ev.protocol !== RELAY_PROTOCOL) settle(ev.rid, { ok: false, code: 'protocol_mismatch' });
          else if (ev.ok) settle(ev.rid, { ok: true, data: ev });
          else settle(ev.rid, { ok: false, code: typeof ev.code === 'string' ? ev.code : 'core_error' });
        }
        return true; // también una respuesta tardía o ajena: nunca es transcript
      }
      // Un IDE anterior a LXO-107 contesta «Acción no soportada» con `orch_error`.
      if (ev.type === 'orch_error' && RESPONSES[`orch_${ev.action}`]) {
        for (const [rid, p] of pending) if (p.action === ev.action) settle(rid, { ok: false, code: 'unsupported_action' });
        return true;
      }
      return false;
    },

    get pendingCount() {
      return pending.size;
    },

    close() {
      closed = true;
      for (const rid of [...pending.keys()]) settle(rid, { ok: false, transport: 'closed' });
    },
  };
}
