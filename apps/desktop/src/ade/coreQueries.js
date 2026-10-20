import { invoke } from '@tauri-apps/api/core';

const QUERY_NAMES = new Set(['projects_overview', 'tasks_by_project', 'task_detail', 'attention_list']);

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

/** Página fija de la lista: el cursor opaco queda ligado a este límite (LXO-89). */
export const ATTENTION_LIMIT = 100;

const ATTENTION_CATEGORY_SET = new Set(ATTENTION_CATEGORIES);
const ATTENTION_SEVERITY_SET = new Set(ATTENTION_SEVERITIES);
const ARCHIVED_FILTERS = new Set(['exclude', 'include', 'only']);

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

// Solo los filtros del contrato de `attention_list`; `limit` fijo para que el cursor siga siendo válido.
function attentionRequest(args) {
  const request = { limit: ATTENTION_LIMIT };
  const projectId = optionalDurableId(args?.projectId, 'project_id');
  const category = optionalCode(args?.category, 'category', ATTENTION_CATEGORY_SET);
  const severity = optionalCode(args?.severity, 'severity', ATTENTION_SEVERITY_SET);
  const cursor = optionalCursor(args?.cursor);
  if (projectId) request.project_id = projectId;
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
  if (query === 'tasks_by_project') {
    return { project_id: durableId(args?.projectId, 'project_id'), status: 'active', limit: 50 };
  }
  return {
    project_id: durableId(args?.projectId, 'project_id'),
    task_id: durableId(args?.taskId, 'task_id'),
  };
}

function invalidResponse(query, detail) {
  return new Error(`ade_query_invalid_response: ${query}: ${detail}`);
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
    return response;
  }
  if (query === 'tasks_by_project') {
    const cursorIsValid = response.has_more
      ? typeof response.next_cursor === 'string' && response.next_cursor.length > 0
      : response.next_cursor === null;
    if (response.project_id !== args.project_id || response.filters?.status !== 'active' || response.limit !== 50
      || !Array.isArray(response.tasks) || typeof response.has_more !== 'boolean' || !cursorIsValid) {
      throw invalidResponse(query, 'la página no corresponde al Project solicitado');
    }
    if (response.tasks.some((task) => !task || typeof task.id !== 'string' || !task.id.trim() || typeof task.title !== 'string' || typeof task.status !== 'string')) {
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
export const listAdeTasks = (projectId) => queryAdeCore('tasks_by_project', { projectId });
export const readAdeTask = (projectId, taskId) => queryAdeCore('task_detail', { projectId, taskId });

/**
 * Lista autoritativa de Attention activa (LXO-89). Los filtros son los del contrato del Core y el
 * cursor es el `next_cursor` opaco de la página anterior; no se deriva ni se amplía nada aquí.
 */
export const listAdeAttention = ({ projectId = null, category = null, severity = null, cursor = null } = {}) =>
  queryAdeCore('attention_list', { projectId, category, severity, cursor });
