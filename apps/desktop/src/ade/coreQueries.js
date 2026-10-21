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

const QUERY_NAMES = new Set(['projects_overview', 'tasks_by_project', 'task_detail', 'attention_list', 'resource_inventory']);

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
  if (query === 'resource_inventory') return resourceInventoryRequest(args);
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
  if (query === 'resource_inventory') {
    // El contrato del inventario (vocabulario cerrado, eco de filtros y coherencia de las
    // entradas entre sí) vive en `coreInventoryContract.js`.
    return validateResourceInventory(response, args);
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
export const readAdeResources = ({ projectId = null, probe = true } = {}) =>
  queryAdeCore('resource_inventory', { projectId, probe });
