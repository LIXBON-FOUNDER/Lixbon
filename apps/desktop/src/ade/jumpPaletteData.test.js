import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_RESULTS,
  MAX_RECENTS,
  PALETTE_TASK_STATUS,
  RECENTS_STORAGE_KEY,
  addRecent,
  loadJumpPaletteResults,
  loadRecents,
  pruneRecents,
  recentFromTarget,
  sanitizeRecents,
} from './jumpPaletteData';
import { queryAdeCore } from './coreQueries';

vi.mock('./coreQueries', async (importOriginal) => ({ ...(await importOriginal()), queryAdeCore: vi.fn() }));

// Fixtures con los DTO documentados de projects_overview y tasks_by_project en docs/core/QUERIES.md.

const FINAL_STATUSES = ['done', 'failed', 'stopped', 'exited'];
const task = (id, status, over = {}) => ({
  id,
  run_id: `run-${id}`,
  parent_id: null,
  root_id: id,
  status,
  title: `Título ${id}`,
  provider: null,
  model: null,
  created_at: 1,
  updated_at: 2,
  branch: null,
  worktree: null,
  ...over,
});

const projectDto = (over = {}) => ({
  id: 'prj-1',
  name: 'Alpha',
  state: 'active',
  status: 'idle',
  counts: {
    tasks: 1,
    active: 1,
    failed: 0,
    attention: {
      total: 0,
      by_category: { question: 0, approval: 0, review_ready: 0, conflict: 0, failed: 0, environment_blocked: 0, risk: 0 },
    },
  },
  locations: [],
  ...over,
});

const TASK_CURSORS = new Map([[null, 0], ['core.tasks.page/2', 50], ['core.tasks.page/3', 100], ['core.tasks.page/4', 150]]);
const TASK_NEXT_CURSOR = new Map([[50, 'core.tasks.page/2'], [100, 'core.tasks.page/3'], [150, 'core.tasks.page/4']]);
const ATTENTION_CURSORS = new Map([[null, 0], ['core.attention.page/2', 100], ['core.attention.page/3', 200]]);
const ATTENTION_NEXT_CURSOR = new Map([[100, 'core.attention.page/2'], [200, 'core.attention.page/3']]);

/** Core de fixture: `tasks_by_project` respeta el filtro `status` del contrato (active · final · all) y pagina de 50 en 50. */
function core({ projects, tasksOf, attention = [] }) {
  const isFinal = (item) => FINAL_STATUSES.includes(item.status);
  queryAdeCore.mockImplementation(async (query, args) => {
    if (query === 'projects_overview') return {
      v: 1,
      filters: { archived: args.archived, machine: null },
      total: projects.length,
      projects,
      unassigned: { tasks: 0, active: 0, failed: 0, attention: { total: 0, by_category: { question: 0, approval: 0, review_ready: 0, conflict: 0, failed: 0, environment_blocked: 0, risk: 0 } } },
    };
    if (query === 'attention_list') {
      const start = ATTENTION_CURSORS.get(args.cursor);
      const end = start + 100;
      return { v: 1, limit: 100, items: attention.slice(start, end), has_more: end < attention.length, next_cursor: end < attention.length ? ATTENTION_NEXT_CURSOR.get(end) : null };
    }
    const all = tasksOf[args.projectId] ?? [];
    const filtered = args.status === 'all' ? all : all.filter((item) => (args.status === 'final') === isFinal(item));
    const start = TASK_CURSORS.get(args.cursor);
    const end = start + 50;
    return {
      v: 1,
      project_id: args.projectId,
      filters: { status: args.status },
      limit: 50,
      tasks: filtered.slice(start, end),
      has_more: end < filtered.length,
      next_cursor: end < filtered.length ? TASK_NEXT_CURSOR.get(end) : null,
    };
  });
}

const attentionItem = (index) => ({
  id: `att-${index}`, category: 'question', severity: 'low', status: 'active', target_kind: 'task', target_id: `t-${index}`,
  project_id: 'prj-1', run_id: null, occurrence: 1, created_at: 1, resolved_at: null, resolution: null,
});

async function load(previous = EMPTY_RESULTS) {
  const published = [];
  await loadJumpPaletteResults({ previous, initial: previous.phase !== 'ready', publish: (snapshot) => published.push(snapshot), isAlive: () => true });
  return published.at(-1);
}

afterEach(() => queryAdeCore.mockReset());

describe('jumpPaletteData · Tasks finalizadas', () => {
  it('pide el grupo `all` para que las Tasks finalizadas sean localizables', async () => {
    expect(PALETTE_TASK_STATUS).toBe('all');
    core({ projects: [{ id: 'prj-1', name: 'Alpha', status: 'idle' }], tasksOf: { 'prj-1': [task('t-run', 'running'), ...FINAL_STATUSES.map((status) => task(`t-${status}`, status))] } });
    const result = await load();

    const calls = queryAdeCore.mock.calls.filter(([name]) => name === 'tasks_by_project');
    expect(calls.every(([, args]) => args.status === 'all')).toBe(true);
    expect(result.tasks.map((item) => item.id)).toEqual(['t-run', ...FINAL_STATUSES.map((status) => `t-${status}`)]);
  });

  it('conserva el estado real de cada Task como metadato y solo usa las tres queries de lectura', async () => {
    core({ projects: [{ id: 'prj-1', name: 'Alpha', status: 'idle' }], tasksOf: { 'prj-1': [task('t-1', 'done'), task('t-2', 'failed'), task('t-3', 'running')] } });
    const result = await load();

    expect(result.tasks.map((item) => item.facts[0])).toEqual(['Estado done', 'Estado failed', 'Estado running']);
    expect(new Set(queryAdeCore.mock.calls.map(([name]) => name))).toEqual(new Set(['projects_overview', 'tasks_by_project', 'attention_list']));
  });

  it('deriva host de las ubicaciones autoritativas del Project, no de campos ajenos al DTO de Task', async () => {
    const project = projectDto({ locations: [{ machine: 'machine-alpha', path: 'C:/work/alpha', primary: true, state: 'ok', last_seen: 1_760_000_000_000 }] });
    core({ projects: [project], tasksOf: { 'prj-1': [task('t-1', 'running')] } });
    const result = await load();

    expect(result.projects[0].facts).toContain('Host machine-alpha');
    expect(result.projects[0].facts).toContain('Origen no informado');
    expect(result.tasks[0].facts).toEqual(['Estado running', 'Ubicación/host del Project machine-alpha', 'Origen no informado']);
  });

  it('indica ubicación/host del Project no informado si el DTO no publica ubicaciones', async () => {
    core({ projects: [projectDto()], tasksOf: { 'prj-1': [task('t-1', 'running')] } });
    const result = await load();

    expect(result.tasks[0].facts).toEqual(['Estado running', 'Ubicación/host del Project no informado', 'Origen no informado']);
  });

  it('alcanza las finalizadas que quedan más allá de 100 Tasks siguiendo el cursor opaco', async () => {
    const many = [
      ...Array.from({ length: 60 }, (_, index) => task(`t-act-${index}`, 'running')),
      ...Array.from({ length: 70 }, (_, index) => task(`t-fin-${index}`, 'done')),
    ];
    core({ projects: [{ id: 'prj-1', name: 'Alpha', status: 'idle' }], tasksOf: { 'prj-1': many } });
    const result = await load();

    expect(result.tasks).toHaveLength(130);
    expect(result.tasks.some((item) => item.id === 't-fin-69')).toBe(true);
    expect(result.taskGroups['prj-1'].complete).toBe(true);
    expect(queryAdeCore.mock.calls.filter(([name]) => name === 'tasks_by_project').map(([, args]) => args.cursor)).toEqual([null, 'core.tasks.page/2', 'core.tasks.page/3']);
  });

  it('relee desde el head y sustituye los resultados de páginas ya leídas al refrescar 100+ Tasks', async () => {
    const tasksOf = {
      'prj-1': Array.from({ length: 130 }, (_, index) => task(`t-${index}`, 'running')),
    };
    core({ projects: [projectDto()], tasksOf });
    const previous = await load();
    expect(previous.tasks).toHaveLength(130);

    tasksOf['prj-1'] = [...tasksOf['prj-1'].slice(0, 100), task('t-new-100', 'running'), ...Array.from({ length: 4 }, (_, index) => task(`t-new-${index + 101}`, 'running'))];
    queryAdeCore.mockClear();
    const refreshed = await load(previous);

    expect(refreshed.tasks).toHaveLength(105);
    expect(refreshed.tasks.some((item) => item.id === 't-129')).toBe(false);
    expect(refreshed.tasks.at(-1).id).toBe('t-new-104');
    expect(refreshed.taskGroups['prj-1'].complete).toBe(true);
    expect(queryAdeCore.mock.calls.filter(([name]) => name === 'tasks_by_project').map(([, args]) => args.cursor)).toEqual([null, 'core.tasks.page/2', 'core.tasks.page/3']);
  });

  it('lee las páginas de Attention más allá de 100 respuestas', async () => {
    core({
      projects: [{ id: 'prj-1', name: 'Alpha', status: 'attention' }],
      tasksOf: {},
      attention: Array.from({ length: 230 }, (_, index) => attentionItem(index)),
    });
    const result = await load();

    expect(result.attention).toHaveLength(230);
    expect(result.sources.attentionComplete).toBe(true);
    expect(queryAdeCore.mock.calls.filter(([name]) => name === 'attention_list').map(([, args]) => args.cursor)).toEqual([null, 'core.attention.page/2', 'core.attention.page/3']);
  });
});

describe('jumpPaletteData · estado del Project', () => {
  it('usa `status` (estado agregado) y no confunde `state` activo/archivado con él', async () => {
    core({
      projects: [
        { id: 'prj-1', name: 'Alpha', state: 'active', status: 'failed' },
        { id: 'prj-2', name: 'Beta', state: 'archived', status: 'idle' },
        { id: 'prj-3', name: 'Gamma', state: 'active' },
      ],
      tasksOf: {},
    });
    const [alpha, beta, gamma] = (await load()).projects;

    expect(alpha.facts[0]).toBe('Estado failed');
    expect(alpha.archived).toBe(false);
    expect(alpha.facts).not.toContain('Archivado');
    expect(beta.facts[0]).toBe('Estado idle');
    expect(beta.archived).toBe(true);
    expect(beta.facts).toContain('Archivado');
    // Sin `status` el estado agregado es desconocido: nunca se sustituye por `state`.
    expect(gamma.facts[0]).toBe('Estado no informado');
    expect(gamma.facts.join(' ')).not.toContain('active');
  });
});

describe('jumpPaletteData · recientes', () => {
  beforeEach(() => localStorage.clear());

  it('reduce los destinos a IDs durables y descarta lo irreconocible', () => {
    expect(recentFromTarget({ kind: 'project', projectId: 'p', extra: 'x' })).toEqual({ kind: 'project', projectId: 'p' });
    expect(recentFromTarget({ kind: 'task', projectId: 'p', taskId: 't', title: 'x' })).toEqual({ kind: 'task', projectId: 'p', taskId: 't' });
    expect(recentFromTarget({ kind: 'attention', attentionId: 'a', targetKind: 'run', targetId: 'r', projectId: null })).toEqual({ kind: 'attention', attentionId: 'a' });
    expect(recentFromTarget({ kind: 'task', projectId: 'p' })).toBeNull();
    expect(recentFromTarget({ kind: 'run', projectId: 'p' })).toBeNull();
    expect(recentFromTarget(null)).toBeNull();
  });

  it('sanea lo almacenado: sin duplicados, sin basura y con tope', () => {
    const many = Array.from({ length: MAX_RECENTS + 5 }, (_, index) => ({ kind: 'project', projectId: `p-${index}` }));
    const clean = sanitizeRecents([{ kind: 'project', projectId: 'p-0' }, 7, null, { kind: 'x' }, { kind: 'project', projectId: 'p-0' }, ...many]);
    expect(clean).toHaveLength(MAX_RECENTS);
    expect(new Set(clean.map((item) => item.projectId)).size).toBe(MAX_RECENTS);
    expect(sanitizeRecents('no es una lista')).toEqual([]);

    localStorage.setItem(RECENTS_STORAGE_KEY, '{no es json');
    expect(loadRecents()).toEqual([]);
  });

  it('añade al frente, mueve repetidos y respeta el tope', () => {
    let recents = [];
    for (let index = 0; index < MAX_RECENTS + 3; index += 1) recents = addRecent(recents, { kind: 'project', projectId: `p-${index}` });
    expect(recents).toHaveLength(MAX_RECENTS);
    expect(recents[0].projectId).toBe(`p-${MAX_RECENTS + 2}`);
    recents = addRecent(recents, { kind: 'project', projectId: `p-${MAX_RECENTS + 1}` });
    expect(recents[0].projectId).toBe(`p-${MAX_RECENTS + 1}`);
    expect(recents).toHaveLength(MAX_RECENTS);
    expect(addRecent(recents, { kind: 'task', projectId: 'p' })).toBe(recents);
  });

  const ready = (over = {}) => ({
    phase: 'ready',
    projects: [{ id: 'p-1' }],
    attention: [{ id: 'a-1' }],
    taskGroups: { 'p-1': { complete: true, tasks: [{ id: 't-1' }] } },
    sources: { projects: true, attention: true, attentionComplete: true },
    ...over,
  });
  const all = [
    { kind: 'project', projectId: 'p-1' }, { kind: 'project', projectId: 'p-gone' },
    { kind: 'task', projectId: 'p-1', taskId: 't-1' }, { kind: 'task', projectId: 'p-1', taskId: 't-gone' }, { kind: 'task', projectId: 'p-gone', taskId: 't-1' },
    { kind: 'attention', attentionId: 'a-1' }, { kind: 'attention', attentionId: 'a-gone' },
  ];

  it('poda los IDs que Core ya no devuelve', () => {
    expect(pruneRecents(all, ready())).toEqual([
      { kind: 'project', projectId: 'p-1' }, { kind: 'task', projectId: 'p-1', taskId: 't-1' }, { kind: 'attention', attentionId: 'a-1' },
    ]);
  });

  it('no poda lo que no se pudo comprobar: carga en curso, fuente caída o lectura parcial', () => {
    expect(pruneRecents(all, ready({ phase: 'loading' }))).toEqual(all);
    expect(pruneRecents(all, ready({ sources: { projects: false, attention: false, attentionComplete: false } }))).toEqual(all);
    const partial = pruneRecents(all, ready({
      taskGroups: { 'p-1': { complete: false, tasks: [{ id: 't-1' }] } },
      sources: { projects: true, attention: true, attentionComplete: false },
    }));
    expect(partial).toContainEqual({ kind: 'task', projectId: 'p-1', taskId: 't-gone' });
    expect(partial).toContainEqual({ kind: 'attention', attentionId: 'a-gone' });
    // El Project ausente sí es autoritativo: `projects_overview` no pagina.
    expect(partial).not.toContainEqual({ kind: 'project', projectId: 'p-gone' });
  });
});
