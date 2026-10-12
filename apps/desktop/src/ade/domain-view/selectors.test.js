import { describe, it, expect } from 'vitest';
import {
  sortAttention, visibleAttention, groupAttentionByKind, countAttention, attentionByProject, buildAttentionViews,
} from './attention';
import { attentionHint } from './attentionText';
import { attentionActions } from './attentionActions';
import {
  attemptsByTaskId, latestAttempt, groupTasksByProject, summarizeProject, sortProjectsByHeat, activeAttemptsByProvider,
} from './projects';
import { describeEvent, actorLabel, isDurableEvent } from './activity';
import { formatAgo, formatDuration, shortCommit, attemptDuration } from './format';
import { eligibilityText } from './integrationText';
import { makeClient, NOW } from '../testing/helpers';

const item = (id, kind, extra = {}) => ({ id, kind, reason: null, entity: { kind: 'attempt', id }, projectId: 'p', taskId: 't', attemptId: id, subject: id, createdAt: 100, dueAt: null, person: { seen: false, snoozedUntil: null }, ...extra });

describe('Attention: orden, agrupación y conteo', () => {
  it('ordena por kind (posición en el vocabulario), luego caducidad y antigüedad', () => {
    const items = [
      item('f', 'failed', { createdAt: 5 }), item('r2', 'review', { createdAt: 9 }), item('r1', 'review', { createdAt: 3 }),
      item('t', 'approve_in_terminal'), item('i', 'integrate'), item('q', 'unanswered_question'),
      item('s2', 'pending_spawn', { dueAt: 900 }), item('s1', 'pending_spawn', { dueAt: 500 }),
    ];
    expect(sortAttention(items).map((i) => i.id)).toEqual(['t', 'i', 'r1', 'r2', 'f', 's1', 's2', 'q']);
  });

  it('no muta la entrada y un kind desconocido va al final', () => {
    const items = [item('x', 'kind_nuevo'), item('t', 'approve_in_terminal')];
    const copia = [...items];
    expect(sortAttention(items).map((i) => i.id)).toEqual(['t', 'x']);
    expect(items).toEqual(copia);
  });

  it('agrupa por kind en orden de prioridad y omite los vacíos', () => {
    const g = groupAttentionByKind([item('f', 'failed'), item('r', 'review'), item('r2', 'review')]);
    expect(g.map((x) => x.kind)).toEqual(['review', 'failed']);
    expect(g[0].items).toHaveLength(2);
    expect(g[0].info).toMatchObject({ title: 'Revisar diff', estado: 'vigente' });
  });

  it('lo pospuesto se oculta hasta que vence el aplazamiento', () => {
    const items = [item('a', 'review', { person: { seen: true, snoozedUntil: NOW + 1000 } }), item('b', 'review')];
    expect(visibleAttention(items, NOW).map((i) => i.id)).toEqual(['b']);
    expect(visibleAttention(items, NOW + 2000).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('cuenta total, no vistas y por kind; agrupa por proyecto', () => {
    const items = [item('a', 'review'), item('b', 'review', { person: { seen: true, snoozedUntil: null } }), item('c', 'failed', { projectId: 'q' })];
    expect(countAttention(items)).toEqual({ total: 3, unseen: 2, byKind: { review: 2, failed: 1 } });
    expect(Object.keys(attentionByProject(items))).toEqual(['p', 'q']);
  });

  it('une cada elemento con su proyecto, task e intento; lo que falta queda en null', () => {
    const v = buildAttentionViews([item('a', 'review')], { projects: [{ id: 'p', name: 'P' }], tasks: [], attempts: [{ id: 'a' }] });
    expect(v[0]).toMatchObject({ project: { name: 'P' }, task: null, attempt: { id: 'a' }, kindInfo: { id: 'review' } });
  });
});

describe('Attention: textos y acciones (presentación)', () => {
  it('las pistas de los kinds vigentes son las del Desktop', () => {
    expect(attentionHint({ item: item('a', 'approve_in_terminal') })).toBe('Espera tu aprobación en su terminal.');
    expect(attentionHint({ item: item('a', 'integrate') })).toBe('Revisada y lista para integrar.');
    expect(attentionHint({ item: item('a', 'review', { reason: 'none' }) })).toBe('Revisa su diff antes de integrar.');
    expect(attentionHint({ item: item('a', 'review', { reason: 'stale' }) })).toMatch(/cambió después de tu revisión/);
    expect(attentionHint({ item: item('a', 'failed', { reason: 'terminal_approval_timeout' }) })).toBe('Nadie aprobó en la terminal a tiempo');
    expect(attentionHint({ item: item('a', 'failed') })).toBe('Terminó con error.');
  });

  it('la pista de un lanzamiento elevado avisa y la de una pregunta cita al agente', () => {
    expect(attentionHint({ item: item('a', 'pending_spawn'), attempt: { policy: { elevated: true } } })).toMatch(/elevada/);
    expect(attentionHint({ item: item('a', 'unanswered_question'), attempt: { pendingQuestion: { text: '¿Por clave?' } } })).toBe('¿Por clave?');
  });

  it('cada kind ofrece las acciones que corresponden y ninguna finge una aprobación en la terminal', () => {
    const ids = (kind, attempt) => attentionActions({ item: item('a', kind), attempt }).map((a) => a.id);
    expect(ids('approve_in_terminal')).toEqual(['ir_terminal', 'ver_intento']);
    expect(ids('review')).toEqual(['revisar', 'diff_ide', 'ver_intento']);
    expect(ids('integrate')).toEqual(['integrar', 'diff_ide', 'ver_intento']);
    expect(ids('failed')).toEqual(['ver_intento', 'reintentar', 'continuar_otro']);
    expect(ids('pending_spawn', { policy: { command: ['x'] } })).toEqual(['aprobar', 'rechazar', 'ver_intento']);
    expect(ids('unanswered_question')).toEqual(['responder', 'ver_intento']);
    const aprobar = attentionActions({ item: item('a', 'pending_spawn'), attempt: { policy: { command: ['claude', '--x'] } } })[0];
    expect(aprobar.args.confirmedCommand).toEqual(['claude', '--x']);
    for (const kind of ['approve_in_terminal', 'review', 'integrate', 'failed', 'pending_spawn', 'unanswered_question']) {
      expect(attentionActions({ item: item('a', kind) }).some((a) => a.intent === 'approve_in_terminal')).toBe(false);
    }
  });
});

describe('Proyectos, tasks e intentos', () => {
  const t = (id, projectId, updatedAt, derivedState = 'in_progress') => ({ id, projectId, updatedAt, derivedState });
  const a = (id, taskId, ordinal, state, projectId = 'p1', provider = 'claude') => ({ id, taskId, ordinal, state, projectId, agent: { provider } });

  it('agrupa tasks por proyecto en el orden dado, recientes primero, y no pierde las huérfanas', () => {
    const proyectos = [{ id: 'p1' }, { id: 'p2' }];
    const g = groupTasksByProject([t('a', 'p1', 1), t('b', 'p1', 9), t('c', 'zzz', 5)], proyectos);
    expect(g.map((x) => x.project?.id ?? null)).toEqual(['p1', 'p2', null]);
    expect(g[0].tasks.map((x) => x.id)).toEqual(['b', 'a']);
    expect(g[1].tasks).toEqual([]);
  });

  it('último intento = mayor ordinal; agrupa los intentos por task', () => {
    const porTarea = attemptsByTaskId([a('x2', 't', 2, 'running'), a('x1', 't', 1, 'failed')]);
    expect(porTarea.t.map((i) => i.id)).toEqual(['x1', 'x2']);
    expect(latestAttempt({ id: 't' }, porTarea.t).id).toBe('x2');
    expect(latestAttempt({ id: 'z' }, [])).toBeNull();
  });

  it('resume un proyecto por grupo visual del último intento, ignorando tasks cerradas', () => {
    const tasks = [t('a', 'p1', 1), t('b', 'p1', 2), t('c', 'p1', 3, 'integrated'), t('d', 'p1', 4), t('o', 'p2', 1)];
    const attempts = [
      a('a1', 'a', 1, 'failed'), a('a2', 'a', 2, 'running'), a('b1', 'b', 1, 'awaiting_terminal_approval'),
      a('c1', 'c', 1, 'done'), a('d1', 'd', 1, 'pending_approval'), a('o1', 'o', 1, 'running', 'p2'),
    ];
    const attention = [item('x', 'review', { projectId: 'p1' }), item('y', 'review', { projectId: 'p2' })];
    const s = summarizeProject({ id: 'p1', locations: [{ path: '/a', primary: true, state: 'missing' }] }, { tasks, attempts, attention, activity: [{ projectId: 'p1', ts: 50 }, { projectId: 'p1', ts: 70 }] });
    expect(s).toMatchObject({ taskCount: 4, openTaskCount: 3, activeAttempts: 3, attentionCount: 1, lastEventAt: 70, locationMissing: true });
    expect(s.byGroup).toEqual({ active: 1, waiting: 0, needs_person: 2, ok: 0, error: 0, halted: 0 });
    expect(s.byDerivedState).toEqual({ in_progress: 3, integrated: 1 });
  });

  it('ordena los proyectos por calor: archivados al final, luego atención, trabajo en marcha y reciente', () => {
    const proyectos = [{ id: 'a', name: 'a', state: 'active' }, { id: 'b', name: 'b', state: 'active' }, { id: 'c', name: 'c', state: 'archived' }, { id: 'd', name: 'd', state: 'active' }];
    const res = { a: { attentionCount: 0, activeAttempts: 5, lastEventAt: 1 }, b: { attentionCount: 2, activeAttempts: 0, lastEventAt: 1 }, c: { attentionCount: 9, activeAttempts: 9, lastEventAt: 9 }, d: { attentionCount: 0, activeAttempts: 5, lastEventAt: 9 } };
    expect(sortProjectsByHeat(proyectos, res).map((p) => p.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('cuenta los intentos vivos por proveedor', () => {
    expect(activeAttemptsByProvider([a('1', 't', 1, 'running'), a('2', 't', 2, 'done'), a('3', 't', 3, 'waiting', 'p', 'codex')])).toEqual({ claude: 1, codex: 1 });
  });

  it('sobre las fixtures reales: Orbita tiene atención y trabajo en marcha', async () => {
    const c = makeClient();
    const [proyectos, tasks, attempts, attention, activity] = await Promise.all([c.listProjects(), c.listTasks(), c.listAttempts(), c.listAttention(), c.listActivity({ limit: 100 })]);
    const s = summarizeProject(proyectos.find((p) => p.id === 'prj_orbita'), { tasks, attempts, attention, activity });
    expect(s.attentionCount).toBe(2);
    expect(s.activeAttempts).toBeGreaterThanOrEqual(1);
    expect(sortProjectsByHeat(proyectos, Object.fromEntries(proyectos.map((p) => [p.id, summarizeProject(p, { tasks, attempts, attention, activity })])))[0].id).toBe('prj_api');
  });
});

describe('actividad y formato', () => {
  it('describe los eventos en español y con la decisión', () => {
    const e = (type, data) => ({ type, data });
    expect(describeEvent(e('attempt.completed'))).toBe('terminó su intento');
    expect(describeEvent(e('review.completed', { decision: 'rejected' }))).toBe('rechazó la revisión');
    expect(describeEvent(e('review.completed', { decision: 'accepted' }))).toBe('aceptó la revisión');
    expect(describeEvent(e('attempt.failed', { failure_reason: 'terminal_approval_timeout' }))).toMatch(/^falló: nadie aprobó/);
    expect(describeEvent(e('attempt.waiting', { motivo: 'terminal' }))).toMatch(/terminal/);
    expect(describeEvent(e('tipo.nuevo'))).toBe('tipo.nuevo');
  });

  it('indica el cliente desde el que decidió una persona', () => {
    expect(actorLabel({ kind: 'human', label: 'Tú', client: 'mobile' })).toBe('Tú (móvil)');
    expect(actorLabel({ kind: 'agent', label: 'Codex', client: null })).toBe('Codex');
    expect(actorLabel(null)).toBe('Alguien');
  });

  it('los eventos efímeros no se consideran actividad', () => {
    expect(isDurableEvent({ type: 'attempt.completed' })).toBe(true);
    expect(isDurableEvent({ type: 'terminal.output' })).toBe(false);
    expect(isDurableEvent({ type: 'token.stream' })).toBe(false);
  });

  it('formatea tiempos y commits', () => {
    expect(formatAgo(NOW - 10000, NOW)).toBe('ahora');
    expect(formatAgo(NOW - 5 * 60000, NOW)).toBe('hace 5 min');
    expect(formatAgo(NOW - 3 * 3600000, NOW)).toBe('hace 3 h');
    expect(formatAgo(NOW - 24 * 3600000, NOW)).toBe('ayer');
    expect(formatAgo(NOW - 4 * 86400000, NOW)).toBe('hace 4 d');
    expect(formatAgo(NaN, NOW)).toBe('');
    expect(formatDuration(45000)).toBe('45 s');
    expect(formatDuration(125 * 60000)).toBe('2 h 5 min');
    expect(shortCommit('abcdef0123456789')).toBe('abcdef0');
    expect(shortCommit(null)).toBe('');
    expect(attemptDuration({ startedAt: NOW - 120000, endedAt: null }, NOW)).toBe('2 min');
  });

  it('textos de elegibilidad de integración', () => {
    expect(eligibilityText('review_required')).toMatch(/revisión aceptada/);
    expect(eligibilityText('otro')).toMatch(/otro/);
    expect(eligibilityText(null)).toBe('');
  });
});
