import { invoke } from '@tauri-apps/api/core';
import {
  RESOURCE_DIRTY_VALUES,
  RESOURCE_MERGED_VALUES,
  RESOURCE_PHYSICAL_VALUES,
  RESOURCE_SCAN_REASONS,
  RESOURCE_SCAN_VALUES,
  RESOURCE_WORKTREE_ORIGINS,
  RESOURCE_WORKTREE_STATES,
  validateResourceInventory,
} from './coreInventoryContract';
import { CORE_MODEL_QUERY_SPECS } from './coreModelContract';


/** Categorías del conjunto cerrado de Attention (LXO-87/89). No se amplían desde el cliente. */
export const ATTENTION_CATEGORIES = Object.freeze([
  'question',
  'approval',
  'review_ready',
  'conflict',
  'failed',
  'environment_blocked',
  'risk',
]);

/** Escala de severidad del Core, de más a menos urgente (LXO-87/89). */
export const ATTENTION_SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);

/** Tipos de target del contrato (`TargetKind` de Core, LXO-87). Se envían tal cual; no se amplían aquí. */
export const ATTENTION_TARGET_KINDS = Object.freeze([
  'project',
  'task',
  'run',
  'spawn_request',
  'attempt',
  'thread',
  'worktree',
  'artifact',
  'review',
  'integration',
  'agent',
  'decision',
  'policy',
]);

/** Página fija de la lista: el cursor opaco queda ligado a este límite (LXO-89). */
export const ATTENTION_LIMIT = 100;

/** Grupos de estado del contrato de `tasks_by_project` (LXO-91). No se amplían desde el cliente. */
export const TASK_STATUS_FILTERS = Object.freeze(['active', 'final', 'all']);

/** Página fija de la lista de Tasks: el cursor opaco queda ligado a este límite (LXO-91). */
export const TASK_PAGE_LIMIT = 50;

/** Límites del contrato de páginas de Activity (LXO-92). */
export const ACTIVITY_DEFAULT_LIMIT = 100;
export const ACTIVITY_MAX_LIMIT = 500;

/**
 * Vocabularios cerrados de `resource_inventory` (docs/core/RESOURCES.md). No se amplían desde el
 * cliente: un valor fuera del contrato es una respuesta inválida, no un dato que se reinterpreté.
 * Viven en `coreInventoryContract.js` (sin dependencias) y se reexportan aquí para no cambiar la
 * superficie pública de este módulo.
 */
export {
  RESOURCE_DIRTY_VALUES,
  RESOURCE_MERGED_VALUES,
  RESOURCE_PHYSICAL_VALUES,
  RESOURCE_SCAN_REASONS,
  RESOURCE_SCAN_VALUES,
  RESOURCE_WORKTREE_ORIGINS,
  RESOURCE_WORKTREE_STATES,
};

const ATTENTION_CATEGORY_SET = new Set(ATTENTION_CATEGORIES);
const ATTENTION_SEVERITY_SET = new Set(ATTENTION_SEVERITIES);
const ATTENTION_TARGET_KIND_SET = new Set(ATTENTION_TARGET_KINDS);
const ARCHIVED_FILTERS = new Set(['exclude', 'include', 'only']);
const TASK_STATUS_SET = new Set(TASK_STATUS_FILTERS);
const ACTIVITY_ORDER_SET = new Set(['asc', 'desc']);
const ACTIVITY_CLASS_SET = new Set(['state', 'effect', 'decision', 'system']);
const ACTIVITY_VISUAL_SET = new Set(['info', 'success', 'warning', 'error']);
const ACTIVITY_ACTOR_KIND_SET = new Set(['person', 'agent', 'system']);
const ACTIVITY_I64_MAX = 9_223_372_036_854_775_807n;
const ACTIVITY_UNKNOWN_REASONS = new Set(['unknown_kind', 'unsupported_version', 'invalid_payload']);

const ACTIVITY_ARG_SCHEMAS = new Map([
  ['activity.run.created', { required: { root_task: 'string' } }],
  ['activity.run.closed', { required: { forced: 'boolean', stopped_total: 'integer' } }],
  ['activity.run.removed', { required: { tasks: 'integer' } }],
  ['activity.task.created', {
    required: { title: 'text', agent: 'string', depth: 'integer', external: 'boolean' },
    optional: { role: 'string', model: 'string', parent: 'string' },
  }],
  ['activity.task.phase_started', { required: {} }],
  ['activity.task.phase_done', { required: {} }],
  ['activity.task.question', { required: { message_id: 'integer', to: 'string' } }],
  ['activity.task.reply', { required: { question_id: 'integer', message_id: 'integer' } }],
  ['activity.task.removed', { required: { cause: 'string' } }],
  ['activity.task.review_requested', { required: { branch: 'text' } }],
  ['activity.decision.review.accepted', { required: { decision_id: 'integer', has_comment: 'boolean' } }],
  ['activity.decision.review.rejected', { required: { decision_id: 'integer', has_comment: 'boolean' } }],
  ['activity.decision.merge.merged', {
    required: { decision_id: 'integer', branch: 'text', squash: 'boolean' },
    optional: { conflict_count: 'integer' },
  }],
  ['activity.decision.merge.conflict', {
    required: { decision_id: 'integer', branch: 'text', squash: 'boolean' },
    optional: { conflict_count: 'integer' },
  }],
  ['activity.decision.merge.error', {
    required: { decision_id: 'integer', branch: 'text', squash: 'boolean' },
    optional: { conflict_count: 'integer' },
  }],
  ['activity.decision.merge.target_moved', {
    required: { decision_id: 'integer', branch: 'text', squash: 'boolean' },
    optional: { conflict_count: 'integer' },
  }],
  ['activity.decision.pr.created', { required: { decision_id: 'integer', branch: 'text', has_pr_url: 'boolean' } }],
  ['activity.decision.pr.already_exists', { required: { decision_id: 'integer', branch: 'text', has_pr_url: 'boolean' } }],
  ['activity.decision.pr.error', { required: { decision_id: 'integer', branch: 'text', has_pr_url: 'boolean' } }],
  ['activity.effect.git_merge.merged', { required: { effect_id: 'string', branch: 'text' } }],
  ['activity.effect.git_merge.conflict', { required: { effect_id: 'string', branch: 'text' } }],
  ['activity.effect.git_merge.error', { required: { effect_id: 'string', branch: 'text' } }],
  ['activity.effect.git_push_pr.created', { required: { effect_id: 'string', branch: 'text', has_pr_url: 'boolean' } }],
  ['activity.effect.git_push_pr.already_exists', { required: { effect_id: 'string', branch: 'text', has_pr_url: 'boolean' } }],
  ['activity.effect.git_push_pr.error', { required: { effect_id: 'string', branch: 'text', has_pr_url: 'boolean' } }],
  ['activity.effect.git_worktree.created', {
    required: { effect_id: 'string', branch: 'text' },
    optional: { base: 'text' },
  }],
  ['activity.effect.git_worktree.removed', {
    required: { effect_id: 'string', worktree_removed: 'boolean', branch_deleted: 'boolean' },
    optional: { branch: 'text' },
  }],
  ['activity.effect.process.launched', { required: { effect_id: 'string' } }],
  ['activity.effect.process.not_launched', { required: { effect_id: 'string' } }],
  ['activity.project.registered', { required: { name: 'text', origin: 'string', has_remote: 'boolean' } }],
  ['activity.project.location_added', { required: { primary: 'boolean', fingerprint_adopted: 'boolean' } }],
  ['activity.project.archived', { required: {} }],
  ['activity.project.restored', { required: {} }],
  ['activity.project.relocated', { required: { fingerprint_adopted: 'boolean', confirmed_mismatch: 'boolean' } }],
  ['activity.spawn.requested', {
    required: {
      parent_task: 'string', title: 'text', provider: 'string', profile: 'string',
      shared: 'boolean', policy_status: 'string',
    },
    optional: { role: 'string', model: 'string', effort: 'string' },
  }],
  ['activity.environment.blocked', { required: { provider: 'string', profile: 'string', code: 'string' } }],
  ['activity.environment.cleared', { required: { provider: 'string', profile: 'string', code: 'string' } }],
  ['activity.attention.risk_acted', { required: { resolution: 'string' } }],
  ['activity.attention.created', {
    required: {
      category: 'string', severity: 'string', occurrence: 'integer', target_kind: 'string', target_id: 'string',
    },
  }],
  ['activity.attention.resolved', { required: { resolution: 'string' } }],
  ['activity.unknown', { required: { reason: 'activityUnknownReason', kind: 'string', event_version: 'integer' } }],
]);

for (const state of ['starting', 'running', 'waiting', 'awaiting_terminal_approval', 'done', 'failed', 'stopped', 'exited']) {
  ACTIVITY_ARG_SCHEMAS.set(`activity.task.${state}`, {
    required: { from: 'string', to: 'string' },
    optional: { cause: 'string' },
  });
}
for (const outcome of ['approved', 'rejected', 'launch_failed', 'timeout', 'coordinator_closed', 'cancelled_run_removed']) {
  ACTIVITY_ARG_SCHEMAS.set(`activity.spawn.${outcome}`, {
    required: { has_reason: 'boolean' },
    optional: { task: 'string' },
  });
}

const ACTIVITY_RESPONSE_KEYS = ['v', 'projection', 'order', 'items', 'next_cursor', 'has_more', 'head_seq', 'limit'];
const ACTIVITY_ITEM_KEYS = [
  'seq', 'event_id', 'ts', 'kind', 'v', 'class', 'message_key', 'args', 'visual', 'fallback',
  'target', 'project_id', 'run_id', 'actor', 'provenance', 'correlation_id',
];

function durableId(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`ade_query_invalid_request: ${name} debe ser un ID durable`);
  return value.trim();
}

function optionalDurableId(value, name) {
  if (value === undefined || value === null || value === '') return null;
  return durableId(value, name);
}

function optionalCode(value, name, allowed) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`ade_query_invalid_request: ${name} debe ser un código del contrato`);
  const code = value.trim();
  if (!allowed.has(code)) throw new Error(`ade_query_invalid_request: ${name} no es un código del contrato de Attention`);
  return code;
}

function optionalCursor(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error('ade_query_invalid_request: cursor debe ser el next_cursor opaco del Core');
  return value;
}

/**
 * `probe` decide si el Core calcula `dirty` y `merged` (docs/core/RESOURCES.md). El valor por defecto
 * es el del contrato (`true`); el cliente solo puede pedir `true` o `false`, nunca otra cosa.
 */
function optionalProbe(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'boolean') throw new Error('ade_query_invalid_request: probe debe ser verdadero o falso');
  return value;
}

/**
 * Petición de `resource_inventory`: solo los dos parámetros del contrato. `project_id` acota a un
 * Project por su ID duradero (ausente = todos) y `probe` viaja siempre explícito para poder verificar
 * el eco del Core.
 */
function resourceInventoryRequest(args) {
  const request = {};
  const projectId = optionalDurableId(args?.projectId, 'project_id');
  if (projectId) request.project_id = projectId;
  request.probe = optionalProbe(args?.probe);
  return request;
}

/** `status` de `tasks_by_project`: solo los tres grupos del contrato; ausente equivale a `active`. */
function taskStatus(value) {
  if (value === undefined || value === null || value === '') return 'active';
  if (typeof value !== 'string' || !value.trim()) throw new Error('ade_query_invalid_request: status debe ser active, final o all');
  const status = value.trim();
  if (!TASK_STATUS_SET.has(status)) throw new Error('ade_query_invalid_request: status debe ser active, final o all');
  return status;
}

function activityFilter(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`ade_query_invalid_request: ${name} debe ser texto`);
  const filter = value.trim();
  if (!filter || [...filter].length > 200) {
    throw new Error(`ade_query_invalid_request: ${name} debe contener de 1 a 200 caracteres`);
  }
  return filter;
}

// Tauri transports Activity i64 fields as decimal strings; keep large values exact and
// normalize only values that JavaScript can represent safely back to Number.
function activityI64(value) {
  if (typeof value === 'bigint') {
    return value >= 0n && value <= ACTIVITY_I64_MAX ? value : null;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value !== 'string' || value.length > 19 || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= ACTIVITY_I64_MAX ? parsed : null;
}

function activityRequestCursor(value) {
  const cursor = activityI64(value);
  if (cursor === null) {
    throw new Error('ade_query_invalid_request: cursor debe ser un entero i64 no negativo y exacto');
  }
  return cursor.toString();
}

function publicActivityI64(value) {
  return value.toString();
}

function activityRequest(args) {
  const allowed = new Set(['cursor', 'limit', 'order', 'projectId', 'runId', 'targetKind', 'targetId']);
  if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
    throw new Error('ade_query_invalid_request: los parámetros de activity_list deben ser un objeto');
  }
  const input = args ?? {};
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error('ade_query_invalid_request: activity_list solo acepta cursor, limit, order, projectId, runId, targetKind y targetId');
  }
  const cursor = activityRequestCursor(input.cursor ?? 0);
  const limit = input.limit ?? ACTIVITY_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ACTIVITY_MAX_LIMIT) {
    throw new Error(`ade_query_invalid_request: limit debe ser un entero entre 1 y ${ACTIVITY_MAX_LIMIT}`);
  }
  const order = input.order ?? 'asc';
  if (!ACTIVITY_ORDER_SET.has(order)) {
    throw new Error('ade_query_invalid_request: order debe ser asc o desc');
  }

  const request = { cursor, limit, order };
  const projectId = activityFilter(input.projectId, 'project_id');
  const runId = activityFilter(input.runId, 'run_id');
  const targetKind = activityFilter(input.targetKind, 'target_kind');
  const targetId = activityFilter(input.targetId, 'target_id');
  if (targetId && !targetKind) {
    throw new Error('ade_query_invalid_request: target_id exige target_kind');
  }
  if (projectId !== null) request.project_id = projectId;
  if (runId !== null) request.run_id = runId;
  if (targetKind !== null) request.target_kind = targetKind;
  if (targetId !== null) request.target_id = targetId;
  return request;
}

// Solo los filtros del contrato de `attention_list`; `limit` fijo para que el cursor siga siendo válido.
// El filtro de target lo resuelve el Core: `target_kind` y `target_id` van siempre juntos (un ID sin tipo es ambiguo).
function attentionRequest(args) {
  const request = { limit: ATTENTION_LIMIT };
  const projectId = optionalDurableId(args?.projectId, 'project_id');
  const targetKind = optionalCode(args?.targetKind, 'target_kind', ATTENTION_TARGET_KIND_SET);
  const targetId = optionalDurableId(args?.targetId, 'target_id');
  if (Boolean(targetKind) !== Boolean(targetId)) {
    throw new Error('ade_query_invalid_request: target_kind y target_id deben enviarse juntos');
  }
  const category = optionalCode(args?.category, 'category', ATTENTION_CATEGORY_SET);
  const severity = optionalCode(args?.severity, 'severity', ATTENTION_SEVERITY_SET);
  const cursor = optionalCursor(args?.cursor);
  if (projectId) request.project_id = projectId;
  if (targetKind) {
    request.target_kind = targetKind;
    request.target_id = targetId;
  }
  if (category) request.category = category;
  if (severity) request.severity = severity;
  if (cursor) request.cursor = cursor;
  return request;
}

function projectsOverviewRequest(args) {
  const archived = args?.archived ?? 'exclude';
  if (!ARCHIVED_FILTERS.has(archived)) throw new Error('ade_query_invalid_request: archived no es un filtro del contrato');
  return { archived };
}

function tasksByProjectRequest(args) {
  const request = {
    project_id: durableId(args?.projectId, 'project_id'),
    status: taskStatus(args?.status),
    limit: TASK_PAGE_LIMIT,
  };
  const cursor = optionalCursor(args?.cursor);
  if (cursor) request.cursor = cursor;
  return request;
}

function taskDetailRequest(args) {
  return {
    project_id: durableId(args?.projectId, 'project_id'),
    task_id: durableId(args?.taskId, 'task_id'),
  };
}

function invalidResponse(query, detail) {
  return new Error(`ade_query_invalid_response: ${query}: ${detail}`);
}

const optionalText = (value) => value === null || value === undefined || typeof value === 'string';
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmptyText = (value) => typeof value === 'string' && Boolean(value.trim());
const freeText = (value) => typeof value === 'string' && (value === '' || Boolean(value.trim()));
const nonNegativeSafeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

function hasExactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validActivityArgs(messageKey, args) {
  const schema = ACTIVITY_ARG_SCHEMAS.get(messageKey);
  if (!schema || !isRecord(args)) return false;
  const required = schema.required ?? {};
  const optional = schema.optional ?? {};
  const fields = { ...required, ...optional };
  const validators = {
    string: nonEmptyText,
    text: freeText,
    boolean: (value) => typeof value === 'boolean',
    integer: nonNegativeSafeInteger,
    activityUnknownReason: (value) => typeof value === 'string' && ACTIVITY_UNKNOWN_REASONS.has(value),
  };
  return Object.keys(required).every((key) => Object.hasOwn(args, key))
    && Object.keys(args).every((key) => Object.hasOwn(fields, key)
      && validators[fields[key]]?.(args[key]) === true);
}

function validActivityItem(item) {
  const seq = activityI64(item?.seq);
  return hasExactKeys(item, ACTIVITY_ITEM_KEYS)
    && seq !== null && seq > 0n
    && nonEmptyText(item.event_id)
    && nonNegativeSafeInteger(item.ts)
    && nonEmptyText(item.kind)
    && Number.isSafeInteger(item.v) && item.v >= 1
    && ACTIVITY_CLASS_SET.has(item.class)
    && typeof item.message_key === 'string' && /^activity\.[a-z0-9_.]+$/.test(item.message_key)
    && validActivityArgs(item.message_key, item.args)
    && ACTIVITY_VISUAL_SET.has(item.visual)
    && typeof item.fallback === 'boolean'
    && hasExactKeys(item.target, ['kind', 'id'])
    && nonEmptyText(item.target.kind) && nonEmptyText(item.target.id)
    && (item.project_id === null || typeof item.project_id === 'string')
    && (item.run_id === null || typeof item.run_id === 'string')
    && hasExactKeys(item.actor, ['kind', 'id'])
    && ACTIVITY_ACTOR_KIND_SET.has(item.actor.kind)
    && (item.actor.id === null || typeof item.actor.id === 'string')
    && hasExactKeys(item.provenance, ['channel', 'client_id'])
    && (item.provenance.channel === null || typeof item.provenance.channel === 'string')
    && (item.provenance.client_id === null || typeof item.provenance.client_id === 'string')
    && (item.correlation_id === null || typeof item.correlation_id === 'string');
}

function validateActivityResponse(args, response) {
  const cursor = activityI64(args.cursor);
  const nextCursor = activityI64(response?.next_cursor);
  const headSeq = activityI64(response?.head_seq);
  if (!hasExactKeys(response, ACTIVITY_RESPONSE_KEYS)
    || response.v !== 1 || response.projection !== 1 || response.order !== args.order
    || response.limit !== args.limit || typeof response.has_more !== 'boolean'
    || cursor === null || nextCursor === null || headSeq === null
    || nextCursor > headSeq || !Array.isArray(response.items)
    || response.items.length > args.limit) {
    throw invalidResponse('activity_list', 'la página no corresponde al contrato de Activity');
  }
  if (cursor > headSeq) {
    throw invalidResponse('activity_list', 'head_seq es menor que el cursor solicitado');
  }
  if (response.items.some((item) => !validActivityItem(item))) {
    throw invalidResponse('activity_list', 'la lista contiene un ActivityItem fuera del DTO contractual');
  }

  let previousSeq = null;
  for (const item of response.items) {
    const seq = activityI64(item.seq);
    if (seq > headSeq
      || (args.project_id !== undefined && item.project_id !== args.project_id)
      || (args.run_id !== undefined && item.run_id !== args.run_id)
      || (args.target_kind !== undefined && item.target.kind !== args.target_kind)
      || (args.target_id !== undefined && item.target.id !== args.target_id)) {
      throw invalidResponse('activity_list', 'la lista contiene un item fuera de los filtros o head_seq');
    }
    if (args.order === 'asc') {
      if (seq <= cursor || (previousSeq !== null && seq <= previousSeq)) {
        throw invalidResponse('activity_list', 'los items no respetan el cursor exclusivo y el orden ascendente');
      }
    } else if ((cursor > 0n && seq >= cursor) || (previousSeq !== null && seq >= previousSeq)) {
      throw invalidResponse('activity_list', 'los items no respetan el cursor exclusivo y el orden descendente');
    }
    previousSeq = seq;
  }

  if (response.has_more) {
    if (response.items.length !== args.limit || response.items.length === 0
      || nextCursor !== activityI64(response.items[response.items.length - 1].seq)) {
      throw invalidResponse('activity_list', 'el cursor de continuación no corresponde a la página');
    }
  } else if (args.order === 'asc') {
    if (nextCursor !== headSeq) {
      throw invalidResponse('activity_list', 'next_cursor debe coincidir con head_seq al terminar en asc');
    }
  } else {
    const lastSeq = response.items.length === 0 ? cursor : activityI64(response.items[response.items.length - 1].seq);
    if (nextCursor !== lastSeq) {
      throw invalidResponse('activity_list', 'next_cursor debe coincidir con el seq más bajo en desc');
    }
  }
  return {
    ...response,
    next_cursor: publicActivityI64(nextCursor),
    head_seq: publicActivityI64(headSeq),
    items: response.items.map((item) => ({ ...item, seq: publicActivityI64(activityI64(item.seq)) })),
  };
}

/** Task de la lista (LXO-91): identidad durable, estado real y metadato opcional, sin inferir nada. */
function validTask(task) {
  return Boolean(task)
    && typeof task.id === 'string' && Boolean(task.id.trim())
    && typeof task.title === 'string'
    && typeof task.status === 'string' && Boolean(task.status.trim())
    && Number.isSafeInteger(task.created_at) && task.created_at >= 0
    && Number.isSafeInteger(task.updated_at) && task.updated_at >= 0
    && optionalText(task.run_id) && optionalText(task.parent_id) && optionalText(task.root_id)
    && optionalText(task.provider) && optionalText(task.model)
    && optionalText(task.branch) && optionalText(task.worktree);
}

function validAttentionItem(item) {
  return Boolean(item)
    && typeof item.id === 'string' && Boolean(item.id.trim())
    && ATTENTION_CATEGORY_SET.has(item.category)
    && ATTENTION_SEVERITY_SET.has(item.severity)
    && item.status === 'active'
    && typeof item.target_kind === 'string' && Boolean(item.target_kind.trim())
    && typeof item.target_id === 'string' && Boolean(item.target_id.trim())
    && (item.project_id === null || typeof item.project_id === 'string')
    && (item.run_id === null || typeof item.run_id === 'string')
    && Number.isSafeInteger(item.occurrence) && item.occurrence >= 1
    && Number.isSafeInteger(item.created_at) && item.created_at >= 0
    && (item.resolved_at === null || Number.isSafeInteger(item.resolved_at))
    && (item.resolution === null || typeof item.resolution === 'string');
}

function requireObject(query, response, version = 1) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw invalidResponse(query, 'respuesta no es un objeto');
  }
  if (response.v !== version) throw invalidResponse(query, 'versión de respuesta no compatible');
}

function validateProjectsOverview(response, args) {
  requireObject('projects_overview', response);
  if (response.filters?.archived !== args.archived || response.filters?.machine !== null
    || !Array.isArray(response.projects) || response.total !== response.projects.length
    || response.projects.some((project) => !project || typeof project.id !== 'string' || !project.id.trim() || typeof project.name !== 'string')) {
    throw invalidResponse('projects_overview', 'falta la lista contractual de Projects');
  }
  return response;
}

function validateAttentionList(response, args) {
  const query = 'attention_list';
  requireObject(query, response);
  const cursorIsValid = response.has_more
    ? typeof response.next_cursor === 'string' && response.next_cursor.length > 0
    : response.next_cursor === null;
  if (response.limit !== ATTENTION_LIMIT || typeof response.has_more !== 'boolean' || !cursorIsValid
    || !Array.isArray(response.items)) {
    throw invalidResponse(query, 'la página no corresponde a la consulta de Attention');
  }
  if (response.items.some((item) => !validAttentionItem(item))) {
    throw invalidResponse(query, 'la lista contiene una Attention fuera del contrato');
  }
  // El filtro lo aplica el Core; aquí solo se verifica que la respuesta corresponde al target pedido.
  if (args.target_kind && response.items.some((item) => item.target_kind !== args.target_kind || item.target_id !== args.target_id)) {
    throw invalidResponse(query, 'la lista contiene una Attention de otro target');
  }
  return response;
}

function validateTasksByProject(response, args) {
  const query = 'tasks_by_project';
  requireObject(query, response);
  const cursorIsValid = response.has_more
    ? typeof response.next_cursor === 'string' && response.next_cursor.length > 0
    : response.next_cursor === null;
  if (response.project_id !== args.project_id || response.filters?.status !== args.status || response.limit !== TASK_PAGE_LIMIT
    || !Array.isArray(response.tasks) || typeof response.has_more !== 'boolean' || !cursorIsValid) {
    throw invalidResponse(query, 'la página no corresponde al Project, al filtro de estado y al límite solicitados');
  }
  if (response.tasks.some((task) => !validTask(task))) {
    throw invalidResponse(query, 'la lista contiene una Task incompleta');
  }
  return response;
}

function validateTaskDetail(response, args) {
  requireObject('task_detail', response);
  const task = response.task;
  if (!task || task.id !== args.task_id || task.project_id !== args.project_id || typeof task.status !== 'string') {
    throw invalidResponse('task_detail', 'el detalle no corresponde al Project y Task solicitados');
  }
  return response;
}

/**
 * Única tabla de queries read-only del ADE: cada una declara cómo se construye su petición y cómo
 * se valida su respuesta. Una query que no está aquí se rechaza; no hay caída silenciosa a otra.
 * Las vNext del modelo Task/Attempt (LXO-119) viven en `coreModelContract.js`.
 */
const QUERY_SPECS = Object.freeze({
  projects_overview: { request: projectsOverviewRequest, validate: validateProjectsOverview },
  tasks_by_project: { request: tasksByProjectRequest, validate: validateTasksByProject },
  task_detail: { request: taskDetailRequest, validate: validateTaskDetail },
  attention_list: { request: attentionRequest, validate: validateAttentionList },
  activity_list: {
    request: activityRequest,
    validate: (response, args) => { requireObject('activity_list', response); return validateActivityResponse(args, response); },
  },
  // El contrato del inventario (vocabulario cerrado, eco de filtros y coherencia) vive en `coreInventoryContract.js`.
  resource_inventory: {
    request: resourceInventoryRequest,
    validate: (response, args) => { requireObject('resource_inventory', response); return validateResourceInventory(response, args); },
  },
  ...CORE_MODEL_QUERY_SPECS,
});

export const ADE_QUERY_NAMES = Object.freeze(Object.keys(QUERY_SPECS));

function specFor(query) {
  if (!Object.hasOwn(QUERY_SPECS, query)) throw new Error(`ade_query_forbidden: ${query} no es una query read-only del ADE`);
  return QUERY_SPECS[query];
}

/** Ejecuta exclusivamente las queries read-only del shell F2 mediante el límite autenticado de Desktop. */
export async function queryAdeCore(query, input = {}) {
  const spec = specFor(query);
  const args = spec.request(input);
  const response = await invoke('orch_query', { query, args });
  return spec.validate(response, args);
}

export const listAdeProjects = ({ archived = 'exclude' } = {}) => queryAdeCore('projects_overview', { archived });

/**
 * Lista paginada de Tasks de un Project (LXO-91). `status` es uno de los tres grupos del contrato
 * (`active` · `final` · `all`, por defecto `active`) y `cursor` es el `next_cursor` opaco de la página
 * anterior; nada se deriva ni se amplía aquí.
 */
export const listAdeTasks = (projectId, { status = 'active', cursor = null } = {}) =>
  queryAdeCore('tasks_by_project', { projectId, status, cursor });
export const readAdeTask = (projectId, taskId) => queryAdeCore('task_detail', { projectId, taskId });

/**
 * Lista autoritativa de Attention activa (LXO-89). Los filtros son los del contrato del Core y el
 * cursor es el `next_cursor` opaco de la página anterior; no se deriva ni se amplía nada aquí.
 */
export const listAdeAttention = ({ projectId = null, targetKind = null, targetId = null, category = null, severity = null, cursor = null } = {}) =>
  queryAdeCore('attention_list', { projectId, targetKind, targetId, category, severity, cursor });

/** Activity es una proyección de solo lectura; su cursor decimal canónico es el `seq` exclusivo del Core. */
export const listAdeActivity = ({ cursor = 0, limit = ACTIVITY_DEFAULT_LIMIT, order = 'asc', projectId = null, runId = null, targetKind = null, targetId = null } = {}) =>
  queryAdeCore('activity_list', { cursor, limit, order, projectId, runId, targetKind, targetId });

/**
 * Inventario de recursos del Core (LXO-93): repos, worktrees y ramas conservadas, TAL CUAL los da
 * el Core (docs/core/RESOURCES.md). `projectId` acota a un Project por su ID duradero (ausente =
 * todos) y `probe` decide si el Core calcula `dirty` y `merged` (por defecto `true`, como en el
 * contrato).
 *
 * El DTO no se traduce aquí: `dirty`/`merged` en `skipped` («no evaluado») siguen siendo `skipped`,
 * nunca «limpio» ni «fusionado»; `owner: null` sigue siendo «sin propietario»; y `unknown` nunca se
 * presenta como «falta». Detectar no es adoptar ni borrar: esta lectura no escribe nada.
 */
export const readAdeResources = ({ projectId = null, probe = true } = {}) => {
  // El ADE solo lee el inventario de un Project durable: sin `project_id` no hay alcance y se
  // rechaza antes de preguntar al Core (un inventario global es un escaneo de todos los repos).
  if (typeof projectId !== 'string' || !projectId.trim()) {
    return Promise.reject(new Error('ade_query_invalid_request: resource_inventory exige project_id'));
  }
  return queryAdeCore('resource_inventory', { projectId, probe });
};
