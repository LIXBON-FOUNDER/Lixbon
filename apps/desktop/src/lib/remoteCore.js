// remoteCore.js — bootstrap observacional de Mobile por /remote (LXO-107).
//
// El móvil no habla con el Core: el Core solo escucha en 127.0.0.1 y, según F1 (LXO-85), una Person
// Mobile no lee el Event Log. El IDE es el host de la sesión remota y ya es Person + Desktop en F1: hace
// las dos lecturas (`compact_snapshot` y `events`) y devuelve por el relé SOLO lo permitido. El móvil se
// autentica ante el gateway con su cuenta (API key en SecureStore) y la sesión debe ser suya.
//
// Ninguna de estas acciones escribe en el Core. Contrato: docs/core/MOBILE_BOOTSTRAP.md.

/** Capability que anuncia el host en su `hello`: sin ella, el móvil sabe que el IDE es anterior. */
export const CORE_SNAPSHOT_CAPABILITY = 'core_snapshot';
/** Protocolo del relé (formas de `orch_core_snapshot` y `orch_core_events`). */
export const CORE_RELAY_PROTOCOL = 1;
export const CORE_EVENTS_MAX_LIMIT = 200;
const CORE_EVENTS_DEFAULT_LIMIT = 100;
const MAX_ATTENTION_ITEMS = 20;
const RID = /^[A-Za-z0-9_-]{1,64}$/;
const CODE = /^([a-z][a-z0-9_]{0,63}):/;
const ID_CHARS = 200;

/** Código estable de un error del Core. El mensaje no viaja: puede llevar rutas o detalles internos. */
export function coreErrorCode(error) {
  const text = String(error?.message ?? error ?? '');
  const m = text.match(CODE);
  if (m) return m[1];
  if (/no permitida para esta identidad/i.test(text)) return 'forbidden';
  return 'core_error';
}

const id = (v) => (typeof v === 'string' && v.length <= ID_CHARS ? v : null);
const int = (v) => (Number.isSafeInteger(v) ? v : null);

/** Un evento del Event Log reducido a lo que el móvil necesita para seguir el cursor: sin `payload`,
    actor, cliente ni correlación. */
export function slimEvent(e) {
  return {
    seq: int(e?.seq),
    kind: typeof e?.kind === 'string' ? e.kind.slice(0, 80) : null,
    ts: int(e?.ts),
    project_id: id(e?.project_id),
    run_id: id(e?.run_id),
    entity: { kind: id(e?.entity?.kind), id: id(e?.entity?.id) },
  };
}

/** Valida los argumentos que llegan del controller. Devuelve `{ rid, args }` o `{ rid, code }`. */
export function parseCoreRequest(action, raw = {}) {
  const rid = typeof raw.rid === 'string' && RID.test(raw.rid) ? raw.rid : null;
  if (!rid) return { rid: null, code: 'invalid_request' };
  if (action === 'core_snapshot') {
    const n = raw.attention_items;
    if (n !== undefined && n !== null && !(Number.isInteger(n) && n >= 0 && n <= MAX_ATTENTION_ITEMS)) {
      return { rid, code: 'invalid_request' };
    }
    return { rid, args: n === undefined || n === null ? {} : { attention_items: n } };
  }
  if (action === 'core_events') {
    const cursor = raw.cursor;
    const limit = raw.limit ?? CORE_EVENTS_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(cursor) || cursor < 0) return { rid, code: 'invalid_cursor' };
    if (!Number.isInteger(limit) || limit < 1 || limit > CORE_EVENTS_MAX_LIMIT) return { rid, code: 'invalid_request' };
    return { rid, args: { cursor, limit } };
  }
  return { rid, code: 'invalid_request' };
}

/**
 * Atiende `core_snapshot` o `core_events` y devuelve el evento que se emite al controller.
 * `call(cmd, args)` llama al Core con la identidad del IDE (`orch_call`).
 */
export async function handleCoreAction(action, raw, call) {
  const type = action === 'core_events' ? 'orch_core_events' : 'orch_core_snapshot';
  const req = parseCoreRequest(action, raw || {});
  if (req.code) return { type, fields: { rid: req.rid, ok: false, code: req.code, protocol: CORE_RELAY_PROTOCOL } };
  try {
    if (action === 'core_snapshot') {
      const snapshot = await call('compact_snapshot', req.args);
      return { type, fields: { rid: req.rid, ok: true, protocol: CORE_RELAY_PROTOCOL, snapshot } };
    }
    const page = await call('events', req.args);
    return {
      type,
      fields: {
        rid: req.rid,
        ok: true,
        protocol: CORE_RELAY_PROTOCOL,
        events: (page?.events || []).map(slimEvent),
        next_cursor: int(page?.next_cursor),
        has_more: !!page?.has_more,
        head_seq: int(page?.head_seq),
      },
    };
  } catch (e) {
    return { type, fields: { rid: req.rid, ok: false, code: coreErrorCode(e), protocol: CORE_RELAY_PROTOCOL } };
  }
}
