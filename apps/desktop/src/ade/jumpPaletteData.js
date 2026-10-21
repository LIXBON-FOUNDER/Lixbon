import { useCallback, useEffect, useRef, useState, startTransition } from 'react';
import { queryAdeCore } from './coreQueries';

// Lecturas del Jump Palette (LXO-102): solo las queries read-only del ADE, solo mientras la paleta está abierta.
// Los cursores son los `next_cursor` opacos del Core; nunca se calculan offsets.

export const PALETTE_TASK_STATUS = 'active';
export const PALETTE_CONCURRENCY = 4;
export const PALETTE_REFRESH_MS = 15_000;
export const PALETTE_QUERY_TIMEOUT_MS = 10_000;
export const MAX_TASK_PAGES_PER_PROJECT = 20;
export const MAX_ATTENTION_PAGES = 10;

export const EMPTY_RESULTS = Object.freeze({
  phase: 'idle',
  projects: Object.freeze([]),
  tasks: Object.freeze([]),
  attention: Object.freeze([]),
  taskGroups: Object.freeze({}),
  issues: Object.freeze([]),
  error: null,
  progress: Object.freeze({ done: 0, total: 0 }),
  updatedAt: null,
});

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const NOT_REPORTED = 'no informado';

function read(query, args) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('ade_query_timeout: Core no respondió a tiempo')), PALETTE_QUERY_TIMEOUT_MS);
  });
  return Promise.race([queryAdeCore(query, args), timeout]).finally(() => clearTimeout(timer));
}

const errorText = (error) => (error instanceof Error ? error.message : String(error ?? 'Error desconocido del Core'));

/** Reparte `items` en `limit` carriles; `worker` no debe lanzar. Devuelve los resultados en el orden de entrada. */
export async function mapBounded(items, limit, worker, shouldStop = () => false) {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length && !shouldStop()) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/** Sigue `next_cursor` tal cual lo devuelve el Core. Un error a mitad conserva lo leído y lo declara parcial. */
async function readPages(fetchPage, pick, { maxPages, shouldStop }) {
  const items = [];
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  for (;;) {
    let page;
    try {
      page = await fetchPage(cursor);
    } catch (error) {
      return { items, complete: false, error: errorText(error), failed: pages === 0 };
    }
    pages += 1;
    items.push(...pick(page));
    if (!page.has_more) return { items, complete: true, error: null, failed: false };
    if (seen.has(page.next_cursor)) return { items, complete: false, error: 'cursor repetido', failed: false };
    if (pages >= maxPages || shouldStop()) return { items, complete: false, error: null, failed: false };
    cursor = page.next_cursor;
    seen.add(cursor);
  }
}

const dedupe = (items, keyOf) => {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

function normalizeProject(project) {
  const id = text(project.id);
  const machines = (Array.isArray(project.locations) ? project.locations : [])
    .map((location) => text(location?.machine))
    .filter(Boolean);
  const hosts = [...new Set(machines)];
  const status = text(project.status) || text(project.state);
  return {
    id,
    name: text(project.name),
    facts: [
      status ? `Estado ${status}` : `Estado ${NOT_REPORTED}`,
      hosts.length ? `Host ${hosts.join(', ')}` : `Host/origen ${NOT_REPORTED}`,
    ],
  };
}

function normalizeTask(projectId, task) {
  const host = text(task.host);
  const origin = text(task.origin);
  return {
    id: text(task.id),
    projectId,
    title: text(task.title),
    branch: text(task.branch),
    facts: [
      `Estado ${text(task.status) || NOT_REPORTED}`,
      host || origin ? `Host/origen ${[host, origin].filter(Boolean).join(' / ')}` : `Host/origen ${NOT_REPORTED}`,
    ],
  };
}

const normalizeAttention = (item) => ({
  id: text(item.id),
  projectId: text(item.project_id),
  targetKind: text(item.target_kind),
  targetId: text(item.target_id),
  category: text(item.category),
  severity: text(item.severity),
});

function flattenTasks(projects, taskGroups) {
  return projects.flatMap((project) => taskGroups[project.id]?.tasks ?? []);
}

/**
 * Lee Projects, Tasks por Project (concurrencia acotada) y Attention activa. En la carga inicial publica de forma
 * progresiva; en un refresco publica una sola vez y conserva lo anterior de lo que no se pudo releer.
 */
export async function loadJumpPaletteResults({ previous = EMPTY_RESULTS, initial, publish, isAlive }) {
  const draft = {
    projects: null,
    attention: null,
    taskGroups: {},
    issues: [],
    errors: [],
    progress: { done: 0, total: 0 },
  };
  const hasPrevious = previous.phase === 'ready';

  const snapshot = (phase) => {
    const projects = draft.projects ?? (hasPrevious ? previous.projects : []);
    const taskGroups = { ...draft.taskGroups };
    if (hasPrevious && !draft.projects) Object.assign(taskGroups, previous.taskGroups);
    const attention = draft.attention ?? (hasPrevious ? previous.attention : []);
    const loadedSomething = Boolean(draft.projects || draft.attention) || hasPrevious;
    return {
      phase: phase === 'done' ? (loadedSomething ? 'ready' : 'error') : 'loading',
      projects,
      taskGroups,
      tasks: flattenTasks(projects, taskGroups),
      attention,
      issues: [...draft.issues],
      error: phase === 'done' && !loadedSomething ? draft.errors[0] ?? 'Error desconocido del Core' : null,
      progress: { ...draft.progress },
      updatedAt: Date.now(),
    };
  };
  const emit = (phase) => { if (isAlive()) publish(snapshot(phase)); };
  const progressive = () => { if (initial) emit('loading'); };

  const loadAttention = async () => {
    const result = await readPages(
      (cursor) => read('attention_list', { cursor }),
      (page) => page.items.map(normalizeAttention),
      { maxPages: MAX_ATTENTION_PAGES, shouldStop: () => !isAlive() },
    );
    if (result.failed) {
      draft.errors.push(result.error);
      if (hasPrevious) draft.issues.push('No se pudo actualizar Attention: se conservan los últimos resultados.');
      else draft.issues.push('No se pudo leer Attention.');
      return;
    }
    draft.attention = dedupe(result.items, (item) => item.id);
    if (!result.complete) draft.issues.push('Vista parcial de Attention: quedan páginas sin cargar.');
    progressive();
  };

  const loadTasks = async () => {
    let overview;
    try {
      overview = await read('projects_overview', { archived: 'exclude' });
    } catch (error) {
      draft.errors.push(errorText(error));
      draft.issues.push(hasPrevious
        ? 'No se pudo actualizar Projects: se conservan los últimos resultados.'
        : 'No se pudieron leer los Projects.');
      return;
    }
    draft.projects = dedupe(overview.projects.map(normalizeProject).filter((project) => project.id), (project) => project.id);
    draft.progress = { done: 0, total: draft.projects.length };
    progressive();

    let failedProjects = 0;
    let partialProjects = 0;
    await mapBounded(draft.projects, PALETTE_CONCURRENCY, async (project) => {
      const result = await readPages(
        (cursor) => read('tasks_by_project', { projectId: project.id, status: PALETTE_TASK_STATUS, cursor }),
        (page) => page.tasks.map((task) => normalizeTask(project.id, task)),
        { maxPages: MAX_TASK_PAGES_PER_PROJECT, shouldStop: () => !isAlive() },
      );
      if (!isAlive()) return;
      if (result.error) draft.errors.push(result.error);
      const earlier = previous.taskGroups[project.id];
      if (result.failed || (result.error && earlier)) {
        failedProjects += 1;
        draft.taskGroups[project.id] = earlier ?? { tasks: [], complete: false };
      } else {
        if (!result.complete) partialProjects += 1;
        draft.taskGroups[project.id] = {
          tasks: dedupe(result.items, (task) => task.id),
          complete: result.complete,
        };
      }
      draft.progress = { done: draft.progress.done + 1, total: draft.progress.total };
      progressive();
    }, () => !isAlive());
    if (failedProjects) {
      draft.issues.push(`No se pudieron leer las Tasks de ${failedProjects} Project${failedProjects === 1 ? '' : 's'}.`);
    }
    if (partialProjects) {
      draft.issues.push(`Vista parcial: ${partialProjects} Project${partialProjects === 1 ? '' : 's'} con más Tasks que el límite de lectura.`);
    }
  };

  await Promise.all([loadAttention(), loadTasks()]);
  emit('done');
}

/** Resultados del Jump Palette: se cargan al abrir, se refrescan solo mientras está abierta y se descartan al cerrar. */
export function useJumpPaletteData(open, { refreshMs = PALETTE_REFRESH_MS } = {}) {
  const [data, setData] = useState(EMPTY_RESULTS);
  const [refreshToken, setRefreshToken] = useState(0);
  const latest = useRef(EMPTY_RESULTS);
  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    let running = false;
    latest.current = { ...EMPTY_RESULTS, phase: 'loading' };
    setData(latest.current);

    const publish = (next) => {
      latest.current = next;
      startTransition(() => setData(next));
    };
    const run = async () => {
      if (running || document.visibilityState === 'hidden') return;
      running = true;
      try {
        const previous = latest.current;
        await loadJumpPaletteResults({
          previous,
          initial: previous.phase !== 'ready',
          publish,
          isAlive: () => alive,
        });
      } finally {
        running = false;
      }
    };
    run();
    const timer = setInterval(run, refreshMs);
    return () => {
      alive = false;
      clearInterval(timer);
      latest.current = EMPTY_RESULTS;
      setData(EMPTY_RESULTS);
    };
  }, [open, refreshToken, refreshMs]);

  /** ¿Sigue el destino en el último conjunto autoritativo leído de Core? */
  const hasTarget = useCallback((target) => {
    const current = latest.current;
    if (target?.kind === 'project') return current.projects.some((project) => project.id === target.projectId);
    if (target?.kind === 'task') {
      return current.tasks.some((task) => task.projectId === target.projectId && task.id === target.taskId);
    }
    if (target?.kind === 'attention') return current.attention.some((item) => item.id === target.attentionId);
    return false;
  }, []);

  return { data, refresh, hasTarget };
}
