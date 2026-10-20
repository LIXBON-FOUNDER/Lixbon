import { invoke } from '@tauri-apps/api/core';

const QUERY_NAMES = new Set(['projects_overview', 'tasks_by_project', 'task_detail']);

function durableId(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`ade_query_invalid_request: ${name} debe ser un ID durable`);
  return value.trim();
}

function requestFor(query, args) {
  if (!QUERY_NAMES.has(query)) throw new Error(`ade_query_forbidden: ${query} no es una query read-only del ADE`);
  if (query === 'projects_overview') return { archived: 'exclude' };
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

function validateResponse(query, args, response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw invalidResponse(query, 'respuesta no es un objeto');
  }
  if (response.v !== 1) throw invalidResponse(query, 'versión de respuesta no compatible');
  if (query === 'projects_overview') {
    if (response.filters?.archived !== 'exclude' || response.filters?.machine !== null
      || !Array.isArray(response.projects) || response.total !== response.projects.length
      || response.projects.some((project) => !project || typeof project.id !== 'string' || !project.id.trim() || typeof project.name !== 'string')) {
      throw invalidResponse(query, 'falta la lista contractual de Projects');
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

export const listAdeProjects = () => queryAdeCore('projects_overview');
export const listAdeTasks = (projectId) => queryAdeCore('tasks_by_project', { projectId });
export const readAdeTask = (projectId, taskId) => queryAdeCore('task_detail', { projectId, taskId });
