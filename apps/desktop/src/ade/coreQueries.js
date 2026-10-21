import { invoke } from '@tauri-apps/api/core';

const QUERY_NAMES = new Set(['projects_overview', 'tasks_by_project', 'task_detail', 'attention_list', 'activity_list']);

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

const ATTENTION_CATEGORY_SET = new Set(ATTENTION_CATEGORIES);
const ATTENTION_SEVERITY_SET = new Set(ATTENTION_SEVERITIES);
const ATTENTION_TARGET_KIND_SET = new Set(ATTENTION_TARGET_KINDS);
const ARCHIVED_FILTERS = new Set(['exclude', 'include', 'only']);
const TASK_STATUS_SET = new Set(TASK_STATUS_FILTERS);
const ACTIVITY_ORDER_SET = new Set(['asc', 'desc']);
const ACTIVITY_CLASS_SET = new Set(['state', 'effect', 'decision', 'system']);
const ACTIVITY_VISUAL_SET = new Set(['info', 'success', 'warning', 'error']);
const ACTIVITY_ACTOR_KIND_SET = new Set(['person', 'agent', 'system']);

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

function activityRequest(args) {
  const allowed = new Set(['cursor', 'limit', 'order', 'projectId', 'runId', 'targetKind', 'targetId']);
  if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
    throw new Error('ade_query_invalid_request: los parámetros de activity_list deben ser un objeto');
  }
  const input = args ?? {};
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error('ade_query_invalid_request: activity_list solo acepta cursor, limit, order, projectId, runId, targetKind y targetId');
  }
  const cursor = input.cursor ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error('ade_query_invalid_request: cursor debe ser un entero seguro no negativo');
  }
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

function requestFor(query, args) {
  if (!QUERY_NAMES.has(query)) throw new Error(`ade_query_forbidden: ${query} no es una query read-only del ADE`);
  if (query === 'projects_overview') {
    const archived = args?.archived ?? 'exclude';
    if (!ARCHIVED_FILTERS.has(archived)) throw new Error('ade_query_invalid_request: archived no es un filtro del contrato');
    return { archived };
  }
  if (query === 'attention_list') return attentionRequest(args);
  if (query === 'activity_list') return activityRequest(args);
  if (query === 'tasks_by_project') {
    const request = {
      project_id: durableId(args?.projectId, 'project_id'),
      status: taskStatus(args?.status),
      limit: TASK_PAGE_LIMIT,
    };
    const cursor = optionalCursor(args?.cursor);
    if (cursor) request.cursor = cursor;
    return request;
  }
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
const nonNegativeSafeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

function hasExactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validActivityItem(item) {
  return hasExactKeys(item, ACTIVITY_ITEM_KEYS)
    && Number.isSafeInteger(item.seq) && item.seq > 0
    && nonEmptyText(item.event_id)
    && nonNegativeSafeInteger(item.ts)
    && nonEmptyText(item.kind)
    && Number.isSafeInteger(item.v) && item.v >= 1
    && ACTIVITY_CLASS_SET.has(item.class)
    && typeof item.message_key === 'string' && /^activity\.[a-z0-9_.]+$/.test(item.message_key)
    && isRecord(item.args)
    && Object.values(item.args).every((value) => value === null || typeof value === 'string'
      || typeof value === 'boolean' || (Number.isSafeInteger(value) && value >= 0))
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
  if (!hasExactKeys(response, ACTIVITY_RESPONSE_KEYS)
    || response.v !== 1 || response.projection !== 1 || response.order !== args.order
    || response.limit !== args.limit || typeof response.has_more !== 'boolean'
    || !nonNegativeSafeInteger(response.next_cursor) || !nonNegativeSafeInteger(response.head_seq)
    || response.next_cursor > response.head_seq || !Array.isArray(response.items)
    || response.items.length > args.limit) {
    throw invalidResponse('activity_list', 'la página no corresponde al contrato de Activity');
  }
  if (args.cursor > response.head_seq) {
    throw invalidResponse('activity_list', 'head_seq es menor que el cursor solicitado');
  }
  if (response.items.some((item) => !validActivityItem(item))) {
    throw invalidResponse('activity_list', 'la lista contiene un ActivityItem fuera del DTO contractual');
  }

  let previousSeq = null;
  for (const item of response.items) {
    if (item.seq > response.head_seq
      || (args.project_id !== undefined && item.project_id !== args.project_id)
      || (args.run_id !== undefined && item.run_id !== args.run_id)
      || (args.target_kind !== undefined && item.target.kind !== args.target_kind)
      || (args.target_id !== undefined && item.target.id !== args.target_id)) {
      throw invalidResponse('activity_list', 'la lista contiene un item fuera de los filtros o head_seq');
    }
    if (args.order === 'asc') {
      if (item.seq <= args.cursor || (previousSeq !== null && item.seq <= previousSeq)) {
        throw invalidResponse('activity_list', 'los items no respetan el cursor exclusivo y el orden ascendente');
      }
    } else if ((args.cursor > 0 && item.seq >= args.cursor) || (previousSeq !== null && item.seq >= previousSeq)) {
      throw invalidResponse('activity_list', 'los items no respetan el cursor exclusivo y el orden descendente');
    }
    previousSeq = item.seq;
  }

  if (response.has_more) {
    if (response.items.length !== args.limit || response.items.length === 0
      || response.next_cursor !== response.items[response.items.length - 1].seq) {
      throw invalidResponse('activity_list', 'el cursor de continuación no corresponde a la página');
    }
  } else if (args.order === 'asc') {
    if (response.next_cursor !== response.head_seq) {
      throw invalidResponse('activity_list', 'next_cursor debe coincidir con head_seq al terminar en asc');
    }
  } else {
    const lastSeq = response.items.length === 0 ? args.cursor : response.items[response.items.length - 1].seq;
    if (response.next_cursor !== lastSeq) {
      throw invalidResponse('activity_list', 'next_cursor debe coincidir con el seq más bajo en desc');
    }
  }
  return response;
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

function validateResponse(query, args, response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw invalidResponse(query, 'respuesta no es un objeto');
  }
  if (response.v !== 1) throw invalidResponse(query, 'versión de respuesta no compatible');
  if (query === 'activity_list') return validateActivityResponse(args, response);
  if (query === 'projects_overview') {
    if (response.filters?.archived !== args.archived || response.filters?.machine !== null
      || !Array.isArray(response.projects) || response.total !== response.projects.length
      || response.projects.some((project) => !project || typeof project.id !== 'string' || !project.id.trim() || typeof project.name !== 'string')) {
      throw invalidResponse(query, 'falta la lista contractual de Projects');
    }
    return response;
  }
  if (query === 'attention_list') {
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
  if (query === 'tasks_by_project') {
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
  const task = response.task;
  if (!task || task.id !== args.task_id || task.project_id !== args.project_id || typeof task.status !== 'string') {
    throw invalidResponse(query, 'el detalle no corresponde al Project y Task solicitados');
  }
  return response;
}

/** Ejecuta exclusivamente las queries read-only del shell F2 mediante el límite autenticado de Desktop. */
export async function queryAdeCore(query, input = {}) {
  const args = requestFor(query, input);
  const response = await invoke('orch_query', { query, args });
  return validateResponse(query, args, response);
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

/** Activity es una proyección de solo lectura; su cursor numérico es el `seq` exclusivo del Core. */
export const listAdeActivity = ({ cursor = 0, limit = ACTIVITY_DEFAULT_LIMIT, order = 'asc', projectId = null, runId = null, targetKind = null, targetId = null } = {}) =>
  queryAdeCore('activity_list', { cursor, limit, order, projectId, runId, targetKind, targetId });
