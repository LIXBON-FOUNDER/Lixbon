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
const ATTENTION_CATEGORIES = new Set(['question', 'approval', 'review_ready', 'conflict', 'failed', 'environment_blocked', 'risk']);
const ATTENTION_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
export const CORE_ATTENTION_MAX_LIMIT = 100;
const CORE_ATTENTION_DEFAULT_LIMIT = 50;
const CURSOR_CHARS = 4096;
const TARGET_KINDS = new Set(['project', 'task', 'run', 'spawn_request', 'attempt', 'thread', 'worktree', 'artifact', 'review', 'integration', 'agent', 'decision', 'policy']);
export const CORE_ACTIVITY_MAX_LIMIT = 50;
const CORE_ACTIVITY_DEFAULT_LIMIT = 30;
const TEXT_CHARS = 200;
const PATH_CHARS = 400;
// eslint-disable-next-line no-control-regex -- los textos del Core pasan a una línea
const text = (v, n = TEXT_CHARS) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n) : null);

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

/** Una fila de `attention_list` (LXO-89) con su allowlist: categoría, severidad, destino, edad y estado. */
export function slimAttention(a) {
  return {
    id: id(a?.id),
    category: typeof a?.category === 'string' ? a.category.slice(0, 40) : null,
    severity: typeof a?.severity === 'string' ? a.severity.slice(0, 20) : null,
    status: typeof a?.status === 'string' ? a.status.slice(0, 20) : null,
    target_kind: id(a?.target_kind),
    target_id: id(a?.target_id),
    project_id: id(a?.project_id),
    run_id: id(a?.run_id),
    occurrence: int(a?.occurrence),
    created_at: int(a?.created_at),
  };
}

/**
 * Detalle de una Task (`task_detail`, LXO-98/91) para el móvil. Sin cuerpos de mensaje (solo cuántas preguntas
 * suyas siguen sin respuesta), sin el nombre de la fase (como Activity) y con la ruta como ubicación secundaria.
 * Lo que el modelo legacy no registra no se inventa: queda `null`.
 */
export function slimTaskDetail(t) {
  const messages = Array.isArray(t?.messages) ? t.messages : [];
  const answered = new Set(messages.map((m) => m?.reply_to).filter((x) => x !== null && x !== undefined));
  const pendingQuestions = messages.filter((m) => m?.kind === 'question' && m.from === t.id && !answered.has(m.id)).length;
  const phase = t?.phase && typeof t.phase === 'object' ? { done: !!t.phase.done, at: int(t.phase.at) } : null;
  return {
    id: id(t?.id),
    project_id: id(t?.project_id),
    run_id: id(t?.run_id),
    parent_id: id(t?.parent_id),
    root_id: id(t?.root_id),
    child_ids: (Array.isArray(t?.child_ids) ? t.child_ids : []).map(id).filter(Boolean).slice(0, 100),
    status: text(t?.status, 40),
    title: text(t?.title),
    provider: text(t?.provider, 60),
    model: text(t?.model, 120),
    branch: text(t?.branch),
    worktree: text(t?.worktree, PATH_CHARS),
    location: text(t?.worktree || t?.cwd, PATH_CHARS),
    created_at: int(t?.created_at),
    updated_at: int(t?.updated_at),
    phase,
    pending_questions: pendingQuestions,
    merged: !!t?.merged,
    // `external` del Core (LXO-38): quién lanzó la Task. Sin el campo (Core anterior), desconocido.
    origin: typeof t?.external === 'boolean' ? (t.external ? 'external' : 'lixbon') : null,
    review: t?.review ? { decision: text(t.review.decision, 40), at: int(t.review.at) } : null,
    integration: t?.integration ? { outcome: text(t.integration.outcome, 40), at: int(t.integration.at) } : null,
  };
}

/** Un item de Activity (LXO-92) sin `provenance`, `event_id` ni `correlation_id`; el actor, solo su tipo. */
export function slimActivity(a) {
  const args = {};
  if (a?.args && typeof a.args === 'object') {
    for (const [k, v] of Object.entries(a.args).slice(0, 20)) {
      if (typeof v === 'string') args[k] = text(v);
      else if (typeof v === 'number' || typeof v === 'boolean' || v === null) args[k] = v;
      else if (Array.isArray(v)) args[k] = v.filter((x) => typeof x === 'string').slice(0, 10).map((x) => text(x, 60));
    }
  }
  return {
    seq: int(a?.seq),
    ts: int(a?.ts),
    kind: text(a?.kind, 80),
    message_key: text(a?.message_key, 80),
    args,
    visual: text(a?.visual, 20),
    fallback: !!a?.fallback,
    target: { kind: id(a?.target?.kind), id: id(a?.target?.id) },
    actor: { kind: text(a?.actor?.kind, 20) },
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
  if (action === 'core_attention') {
    const args = {};
    if (raw.project_id !== undefined && raw.project_id !== null) {
      if (!id(raw.project_id) || !raw.project_id) return { rid, code: 'invalid_request' };
      args.project_id = raw.project_id;
    }
    if (raw.category !== undefined && raw.category !== null) {
      if (!ATTENTION_CATEGORIES.has(raw.category)) return { rid, code: 'invalid_request' };
      args.category = raw.category;
    }
    if (raw.severity !== undefined && raw.severity !== null) {
      if (!ATTENTION_SEVERITIES.has(raw.severity)) return { rid, code: 'invalid_request' };
      args.severity = raw.severity;
    }
    if (raw.target_kind !== undefined && raw.target_kind !== null) {
      if (!TARGET_KINDS.has(raw.target_kind)) return { rid, code: 'invalid_request' };
      args.target_kind = raw.target_kind;
    }
    if (raw.target_id !== undefined && raw.target_id !== null) {
      if (!args.target_kind || !id(raw.target_id) || !raw.target_id) return { rid, code: 'invalid_request' };
      args.target_id = raw.target_id;
    }
    if (raw.cursor !== undefined && raw.cursor !== null) {
      if (typeof raw.cursor !== 'string' || !raw.cursor || raw.cursor.length > CURSOR_CHARS) return { rid, code: 'invalid_cursor' };
      args.cursor = raw.cursor;
    }
    const limit = raw.limit ?? CORE_ATTENTION_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > CORE_ATTENTION_MAX_LIMIT) return { rid, code: 'invalid_request' };
    args.limit = limit;
    return { rid, args };
  }
  if (action === 'core_task') {
    if (!id(raw.project_id) || !raw.project_id || !id(raw.task_id) || !raw.task_id) return { rid, code: 'invalid_request' };
    return { rid, args: { project_id: raw.project_id, task_id: raw.task_id } };
  }
  if (action === 'core_activity') {
    if (!id(raw.task_id) || !raw.task_id) return { rid, code: 'invalid_request' };
    const cursor = raw.cursor ?? 0;
    const limit = raw.limit ?? CORE_ACTIVITY_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(cursor) || cursor < 0) return { rid, code: 'invalid_cursor' };
    if (!Number.isInteger(limit) || limit < 1 || limit > CORE_ACTIVITY_MAX_LIMIT) return { rid, code: 'invalid_request' };
    // Lo último primero: `desc` con cursor exclusivo (0 = desde lo más nuevo).
    return { rid, args: { target_kind: 'task', target_id: raw.task_id, order: 'desc', cursor, limit } };
  }
  return { rid, code: 'invalid_request' };
}

/**
 * Atiende `core_snapshot` o `core_events` y devuelve el evento que se emite al controller.
 * `call(cmd, args)` llama al Core con la identidad del IDE (`orch_call`).
 */
export async function handleCoreAction(action, raw, call) {
  const type =
    { core_events: 'orch_core_events', core_attention: 'orch_core_attention', core_task: 'orch_core_task', core_activity: 'orch_core_activity' }[action] ||
    'orch_core_snapshot';
  const req = parseCoreRequest(action, raw || {});
  if (req.code) return { type, fields: { rid: req.rid, ok: false, code: req.code, protocol: CORE_RELAY_PROTOCOL } };
  try {
    if (action === 'core_snapshot') {
      const snapshot = await call('compact_snapshot', req.args);
      return { type, fields: { rid: req.rid, ok: true, protocol: CORE_RELAY_PROTOCOL, snapshot } };
    }
    if (action === 'core_task') {
      const detail = await call('task_detail', req.args);
      return { type, fields: { rid: req.rid, ok: true, protocol: CORE_RELAY_PROTOCOL, task: slimTaskDetail(detail?.task || {}) } };
    }
    if (action === 'core_activity') {
      const page = await call('activity_list', req.args);
      return {
        type,
        fields: {
          rid: req.rid,
          ok: true,
          protocol: CORE_RELAY_PROTOCOL,
          items: (page?.items || []).map(slimActivity),
          next_cursor: int(page?.next_cursor),
          has_more: !!page?.has_more,
        },
      };
    }
    if (action === 'core_attention') {
      const list = await call('attention_list', req.args);
      return {
        type,
        fields: {
          rid: req.rid,
          ok: true,
          protocol: CORE_RELAY_PROTOCOL,
          items: (list?.items || []).map(slimAttention),
          next_cursor: typeof list?.next_cursor === 'string' && list.next_cursor.length <= CURSOR_CHARS ? list.next_cursor : null,
          has_more: !!list?.has_more,
        },
      };
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
