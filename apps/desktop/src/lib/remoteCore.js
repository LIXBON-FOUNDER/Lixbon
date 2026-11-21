// remoteCore.js — bootstrap observacional de Mobile por /remote (LXO-107).
//
// El móvil no habla con el Core: el Core solo escucha en 127.0.0.1 y, según F1 (LXO-85), una Person
// Mobile no lee el Event Log. El IDE es el host de la sesión remota y ya es Person + Desktop en F1: hace
// las dos lecturas (`compact_snapshot` y `events`) y devuelve por el relé SOLO lo permitido. El móvil se
// autentica ante el gateway con su cuenta (API key en SecureStore) y la sesión debe ser suya.
//
// Ninguna de estas acciones escribe en el Core. Contrato: docs/core/MOBILE_BOOTSTRAP.md.

import { desktopLinkRequest, desktopLink } from './remoteDesktopLink.js';
import { CAPABILITIES, validateProviderCapabilities } from '../ade/providerCapabilitiesContract.js';
import { validateContextPreview } from '../ade/contextPreviewContract.js';
import { USAGE_FIELDS, validateUsageResponse } from '../ade/usageContract.js';

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
/** Intentos que `core_attempts` detalla (los últimos por `n`); el resto se cuenta en `attempt_count`. */
export const CORE_ATTEMPTS_MAX = 20;
const SUMMARY_CHARS = 400;
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
    ...(a?.launch_approval === true ? { launch_approval: true } : {}),
  };
}

/**
 * Detalle de una Task (`task_detail`, LXO-98/91) para el móvil. Sin cuerpos de mensaje (solo cuántas preguntas
 * suyas siguen sin respuesta), sin el nombre de la fase (como Activity) y con la ruta como ubicación secundaria.
 * Lo que el modelo legacy no registra no se inventa: queda `null`.
 */
// ── Task/Attempt (LXO-126) ──────────────────────────────────────────────────

const bool = (v) => (typeof v === 'boolean' ? v : null);
const originOf = (external) => (typeof external === 'boolean' ? (external ? 'external' : 'lixbon') : null);

/** La Task de `task_detail_v2` sin el encargo: intención, estado derivado y cuántos intentos tiene. */
export function slimTaskV2(t) {
  return {
    id: id(t?.id),
    project_id: id(t?.project_id),
    run_id: id(t?.run_id),
    parent_task_id: id(t?.parent_task_id),
    title: text(t?.title),
    intent: text(t?.intent, 40),
    state: text(t?.state, 40),
    origin: text(t?.origin, 40),
    attempt_count: int(t?.attempt_count),
    current_attempt_id: id(t?.current_attempt?.id),
    created_at: int(t?.created_at),
    updated_at: int(t?.updated_at),
  };
}

/** Un intento para la lista compacta del móvil: estado, proveedor, fechas, resultado y su host. */
export function slimAttemptBrief(a) {
  return {
    id: id(a?.id),
    task_id: id(a?.task_id),
    n: int(a?.n),
    status: text(a?.status, 40),
    provider: text(a?.provider, 60),
    model: text(a?.model, 120),
    role: text(a?.role, 60),
    origin: originOf(a?.external),
    created_at: int(a?.created_at),
    started_at: int(a?.started_at),
    ended_at: int(a?.ended_at),
    failure_reason: text(a?.failure_reason, 60),
    integrated: bool(a?.integrated),
    has_summary: typeof a?.summary === 'string' ? a.summary.length > 0 : null,
    // El equipo donde corrió, si el Core lo registra en su Worktree; si no, desconocido (nunca se deduce).
    host: text(a?.worktree?.machine, 120),
  };
}

/** La ficha de un intento (`attempt_detail`): sin la referencia del proveedor ni ids internos de la sesión. */
export function slimAttempt(a) {
  const ps = a?.provider_session;
  const wt = a?.worktree;
  const rv = a?.review;
  return {
    ...slimAttemptBrief(a),
    effort: text(a?.effort, 40),
    profile: text(a?.profile, 60),
    summary: text(a?.summary, SUMMARY_CHARS),
    provider_session: ps && typeof ps === 'object'
      ? { status: text(ps.status, 40), resumable: bool(ps.resumable), bound: bool(ps.bound), binding: text(ps.binding, 40), opened_here: ps.opened_by_attempt_id === a?.id }
      : null,
    worktree: wt && typeof wt === 'object'
      ? {
          path: text(wt.path, PATH_CHARS),
          branch: text(wt.branch),
          base_branch: text(wt.base_branch),
          provenance: text(wt.provenance, 40),
          state: text(wt.state, 40),
          machine: text(wt.machine, 120),
          branch_kept: bool(wt.branch_kept),
        }
      : null,
    artifacts: (Array.isArray(a?.artifacts) ? a.artifacts : []).slice(0, 20).map((x) => ({ kind: text(x?.kind, 40), uri: text(x?.uri, PATH_CHARS) })),
    review: rv && typeof rv === 'object'
      ? { verdict: text(rv.verdict, 40), status: text(rv.status, 40), head_commit: text(rv.head_commit, 64), base_commit: text(rv.base_commit, 64) }
      : null,
  };
}

/** La matriz vigente del proveedor de este Attempt, sin diagnósticos libres ni ids de sesión. */
export function slimAttemptCapabilities(attempt, snapshot) {
  validateProviderCapabilities(snapshot);
  const provider = snapshot.providers.find((entry) => entry.id === attempt.provider);
  const capabilities = {};
  for (const capability of CAPABILITIES) {
    const state = provider?.matrix.capabilities[capability];
    capabilities[capability] = {
      state: state?.state || 'unknown',
      block: typeof state?.block === 'string' && /^[a-z_]{1,64}$/.test(state.block) ? state.block : null,
    };
  }
  const profileBlock = provider?.blocked_profiles?.find((entry) => entry.profile === attempt.profile);
  return {
    attempt_id: id(attempt.id),
    provider: text(attempt.provider, 60),
    profile: text(attempt.profile, 60),
    status: snapshot.status,
    refreshing: snapshot.refreshing,
    checked_at_ms: snapshot.checked_at_ms,
    capabilities,
    profile_block: typeof profileBlock?.block === 'string' && /^[a-z_]{1,64}$/.test(profileBlock.block) ? profileBlock.block : null,
    environment: provider?.environment.state || 'unknown',
    transport: text(provider?.transport, 40),
    fallback: !!provider?.transport_fallback,
    session: attempt.provider_session ? {
      status: text(attempt.provider_session.status, 40),
      resumable: bool(attempt.provider_session.resumable),
      bound: bool(attempt.provider_session.bound),
    } : null,
  };
}

/** Solo metadatos del paquete verificado por el Core. El contenido permanece en el host. */
export function slimContextPackage(preview, attempt) {
  validateContextPreview(preview);
  if (preview.status === 'invalid') {
    return { attempt_id: attempt.id, status: 'invalid', error: preview.error.code, portable: false };
  }
  const pkg = preview.package;
  if (pkg.source.attempt_id !== attempt.id || pkg.source.task_id !== attempt.task_id || pkg.source.provider !== attempt.provider) {
    return { attempt_id: attempt.id, status: 'invalid', error: 'source_mismatch', portable: false };
  }
  const counts = preview.summary.counts;
  const attachments = preview.attachments;
  const missing = Array.isArray(attachments) ? attachments.some((item) => !item.omitted && item.stored !== true) : pkg.attachments?.length > 0;
  let portability = 'ready';
  if (preview.summary.completeness === 'partial') portability = 'partial';
  else if (missing) portability = 'attachments_missing';
  else if (counts.attachments > 0) portability = 'attachments_not_verified';
  return {
    attempt_id: attempt.id,
    status: 'valid',
    package_id: preview.package_id,
    source: { project_id: id(pkg.source.project_id), task_id: id(pkg.source.task_id), attempt_id: id(pkg.source.attempt_id), provider: text(pkg.source.provider, 60) },
    created_at_ms: int(pkg.created_at_ms),
    serialized_bytes: preview.summary.serialized_bytes,
    completeness: preview.summary.completeness,
    notes: preview.summary.notes,
    counts: Object.fromEntries(Object.entries(counts).filter(([key]) => ['decisions', 'constraints', 'files', 'untracked', 'artifacts', 'attachments', 'attachments_bytes', 'attachments_omitted', 'attachments_not_scanned', 'redactions', 'truncated_fields'].includes(key))),
    objective_chars: [...pkg.objective].length,
    revision: pkg.revision ? { base_commit: text(pkg.revision.base_commit, 64), head_commit: text(pkg.revision.head_commit, 64) } : null,
    tests: pkg.test_results ? { passed: int(pkg.test_results.passed), failed: int(pkg.test_results.failed), ignored: int(pkg.test_results.ignored), source: 'package_reported' } : null,
    portability,
    portable: portability === 'ready',
    checksum: preview.verification.identity,
  };
}

/** Informe normalizado de uso. Las cuentas se transmiten como huella y los errores como código. */
export function slimUsage(response) {
  validateUsageResponse(response);
  return {
    status: response.status,
    refreshing: response.refreshing,
    generated_at_ms: response.report?.generated_at_ms ?? null,
    providers: (response.report?.providers || []).slice(0, 30).map((provider) => {
      const source = provider.snapshot;
      const snapshot = source ? {
        observed_at_ms: source.observed_at_ms,
        provenance: source.provenance,
        account: /^[a-f0-9]{8}$/.test(source.account || '') ? source.account : null,
        plan: text(source.plan, 80),
        limit_reached: bool(source.limit_reached),
        windows: (source.windows || []).slice(0, 20).map((window) => ({
          id: text(window.id, 80), minutes: int(window.minutes), resets_at: int(window.resets_at),
          used_percent: Number.isFinite(window.used_percent) ? window.used_percent : null,
        })),
        models: (source.models || []).slice(0, 30).map((model) => ({
          model: text(model.model, 120), input_tokens: int(model.input_tokens), output_tokens: int(model.output_tokens),
          cache_read_tokens: int(model.cache_read_tokens), cache_creation_tokens: int(model.cache_creation_tokens),
          cost_usd: Number.isFinite(model.cost_usd) ? model.cost_usd : null,
        })),
        credits: source.credits ? {
          has_credits: bool(source.credits.has_credits), unlimited: bool(source.credits.unlimited),
          balance: typeof source.credits.balance === 'string' && /^-?\d{1,20}(\.\d{1,12})?$/.test(source.credits.balance) ? source.credits.balance : null,
        } : null,
      } : null;
      return {
        provider: text(provider.provider, 60), status: provider.status,
        support: Object.fromEntries(USAGE_FIELDS.map((field) => [field, provider.support.fields[field].state])),
        age_ms: int(provider.age_ms),
        error: provider.error?.kind || null,
        throttled: provider.throttled === true,
        snapshot,
        truncated: (source?.windows?.length || 0) > 20 || (source?.models?.length || 0) > 30,
      };
    }),
    truncated: (response.report?.providers.length || 0) > 30,
  };
}

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
  if (action === 'core_desktop_link') {
    const args = desktopLinkRequest(raw);
    return args ? { rid, args } : { rid, code: 'invalid_request' };
  }
  if (action === 'core_usage') {
    if (raw.refresh !== undefined && typeof raw.refresh !== 'boolean') return { rid, code: 'invalid_request' };
    return { rid, args: { refresh: raw.refresh === true } };
  }
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
  if (action === 'core_attempts') {
    if (!id(raw.task_id) || !raw.task_id) return { rid, code: 'invalid_request' };
    return { rid, args: { task_id: raw.task_id } };
  }
  if (action === 'core_attempt') {
    if (!id(raw.attempt_id) || !raw.attempt_id) return { rid, code: 'invalid_request' };
    return { rid, args: { attempt_id: raw.attempt_id } };
  }
  if (action === 'core_attempt_capabilities' || action === 'core_attempt_context') {
    if (!id(raw.attempt_id) || !raw.attempt_id || (raw.refresh !== undefined && typeof raw.refresh !== 'boolean')) {
      return { rid, code: 'invalid_request' };
    }
    return { rid, args: { attempt_id: raw.attempt_id, refresh: raw.refresh === true } };
  }
  if (action === 'core_activity') {
    // De una Task (`task_id`) o de un intento concreto (`attempt_id`, LXO-127), nunca de los dos.
    const attempt = raw.attempt_id !== undefined && raw.attempt_id !== null;
    const target = attempt ? raw.attempt_id : raw.task_id;
    if ((attempt && raw.task_id !== undefined && raw.task_id !== null) || !id(target) || !target) return { rid, code: 'invalid_request' };
    const cursor = raw.cursor ?? 0;
    const limit = raw.limit ?? CORE_ACTIVITY_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(cursor) || cursor < 0) return { rid, code: 'invalid_cursor' };
    if (!Number.isInteger(limit) || limit < 1 || limit > CORE_ACTIVITY_MAX_LIMIT) return { rid, code: 'invalid_request' };
    // Lo último primero: `desc` con cursor exclusivo (0 = desde lo más nuevo).
    return { rid, args: { target_kind: attempt ? 'attempt' : 'task', target_id: target, order: 'desc', cursor, limit } };
  }
  return { rid, code: 'invalid_request' };
}

/**
 * Atiende `core_snapshot` o `core_events` y devuelve el evento que se emite al controller.
 * `call(cmd, args)` llama al Core con la identidad del IDE (`orch_call`).
 */
export async function handleCoreAction(action, raw, call, openDesktop) {
  const type =
    {
      core_events: 'orch_core_events',
      core_attention: 'orch_core_attention',
      core_task: 'orch_core_task',
      core_activity: 'orch_core_activity',
      core_attempts: 'orch_core_attempts',
      core_attempt: 'orch_core_attempt',
      core_attempt_capabilities: 'orch_core_attempt_capabilities',
      core_attempt_context: 'orch_core_attempt_context',
      core_desktop_link: 'orch_core_desktop_link',
      core_usage: 'orch_core_usage',
    }[action] ||
    'orch_core_snapshot';
  const req = parseCoreRequest(action, raw || {});
  if (req.code) return { type, fields: { rid: req.rid, ok: false, code: req.code, protocol: CORE_RELAY_PROTOCOL } };
  try {
    if (action === 'core_desktop_link') return { type, fields: { rid: req.rid, ok: true, protocol: CORE_RELAY_PROTOCOL, ...await desktopLink(req.args, call, openDesktop) } };
    if (action === 'core_usage') {
      const report = await call('usage_report', req.args);
      return { type, fields: { rid: req.rid, ok: true, protocol: CORE_RELAY_PROTOCOL, summary: slimUsage(report) } };
    }
    if (action === 'core_attempt_context') {
      const detail = await call('attempt_detail_v2', { attempt_id: req.args.attempt_id });
      const attempt = detail?.attempt;
      if (attempt?.id !== req.args.attempt_id) throw new Error('invalid_response: destino inesperado');
      let summary;
      try {
        const stored = await call('context_package_get', { attempt_id: attempt.id });
        summary = slimContextPackage(stored, attempt);
      } catch (error) {
        const code = coreErrorCode(error);
        if (code === 'context_store_not_found') summary = { attempt_id: attempt.id, status: 'absent', portable: false };
        else if (code === 'context_store_corrupt') summary = { attempt_id: attempt.id, status: 'invalid', error: 'stored_corrupt', portable: false };
        else throw error;
      }
      return { type, fields: { rid: req.rid, ok: true, protocol: CORE_RELAY_PROTOCOL, summary } };
    }
    if (action === 'core_attempt_capabilities') {
      const detail = await call('attempt_detail_v2', { attempt_id: req.args.attempt_id });
      if (detail?.attempt?.id !== req.args.attempt_id) throw new Error('invalid_response: destino inesperado');
      const providers = await call('provider_capabilities', { refresh: req.args.refresh });
      return { type, fields: { rid: req.rid, ok: true, protocol: CORE_RELAY_PROTOCOL, summary: slimAttemptCapabilities(detail.attempt, providers) } };
    }
    if (action === 'core_snapshot') {
      const snapshot = await call('compact_snapshot', req.args);
      return { type, fields: { rid: req.rid, ok: true, protocol: CORE_RELAY_PROTOCOL, snapshot } };
    }
    if (action === 'core_task') {
      const detail = await call('task_detail', req.args);
      return { type, fields: { rid: req.rid, ok: true, protocol: CORE_RELAY_PROTOCOL, task: slimTaskDetail(detail?.task || {}) } };
    }
    if (action === 'core_attempts') {
      // Antes del corte, `task_detail_v2` responde `core_model_inactive` y el móvil sigue con `core_task`.
      const detail = await call('task_detail_v2', req.args);
      const task = detail?.task || {};
      const all = (Array.isArray(task.attempts) ? task.attempts : []).filter((a) => id(a?.id));
      const recent = all.slice(-CORE_ATTEMPTS_MAX);
      // El detalle de cada intento da su resultado y su host; si uno falla, va lo de la lista.
      const attempts = await Promise.all(
        recent.map((a) =>
          call('attempt_detail', { attempt_id: a.id })
            .then((d) => d?.attempt || a)
            .catch(() => a),
        ),
      );
      return {
        type,
        fields: {
          rid: req.rid,
          ok: true,
          protocol: CORE_RELAY_PROTOCOL,
          task: slimTaskV2(task),
          attempts: attempts.map(slimAttemptBrief),
          truncated: all.length > recent.length,
        },
      };
    }
    if (action === 'core_attempt') {
      const detail = await call('attempt_detail', req.args);
      const attempt = slimAttempt(detail?.attempt || {});
      // Su Task, para nombrarla: si su lectura falla, el intento se enseña igual.
      const task = attempt.task_id
        ? await call('task_detail_v2', { task_id: attempt.task_id })
            .then((d) => {
              const t = slimTaskV2(d?.task || {});
              return { id: t.id, title: t.title, state: t.state, project_id: t.project_id, current_attempt_id: t.current_attempt_id };
            })
            .catch(() => null)
        : null;
      return { type, fields: { rid: req.rid, ok: true, protocol: CORE_RELAY_PROTOCOL, attempt, task } };
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
