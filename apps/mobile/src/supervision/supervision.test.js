// Pruebas del prototipo de supervisión: `npm test` (node --test, sin Jest).
// Cada bloque fija una invariante de LXO-227.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildFixtures } from './fixtures.js';
import { attention, connectionState, containsDiff, containsSecret, decide, desktopHandoff, hostState, pushPayload, reviewComplexity, unreadCount } from './model.js';
import { act, initialState, reducer } from './store.js';

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const task = (state, id) => state.tasks.find((t) => t.id === id);
const hostOf = (state, t) => state.hosts.find((h) => h.id === t.hostId);

describe('1 · atención ≠ no leído', () => {
  it('leer todos los avisos no vacía la atención', () => {
    const s = initialState(NOW);
    const before = attention(s.tasks).map((a) => a.taskId);
    const read = reducer(s, { type: 'readAll', now: NOW });
    assert.equal(unreadCount(read.notifications), 0);
    assert.deepEqual(attention(read.tasks).map((a) => a.taskId), before);
  });

  it('un aviso sin leer de una tarea terminada no pide atención', () => {
    const s = initialState(NOW);
    const unreadDone = s.notifications.find((n) => !n.read && n.kind === 'done');
    assert.ok(unreadDone);
    assert.ok(!attention(s.tasks).some((a) => a.taskId === unreadDone.taskId));
  });

  it('lo que bloquea al agente va primero', () => {
    const kinds = attention(initialState(NOW).tasks).map((a) => a.kind);
    assert.deepEqual(kinds, [...kinds].sort((a, b) => ['approval', 'question', 'failed', 'review'].indexOf(a) - ['approval', 'question', 'failed', 'review'].indexOf(b)));
  });
});

describe('2 · sin conexión / desactualizado ≠ fallido', () => {
  it('distingue los tres estados de la conexión', () => {
    assert.equal(connectionState({ deviceOnline: true, syncedAt: NOW - 5000 }, NOW), 'online');
    assert.equal(connectionState({ deviceOnline: true, syncedAt: NOW - 120000 }, NOW), 'stale');
    assert.equal(connectionState({ deviceOnline: false, syncedAt: NOW }, NOW), 'offline');
  });

  it('en línea la sincronización sigue sola; desactualizado no', () => {
    const later = NOW + 5 * 60 * 1000;
    const online = reducer(initialState(NOW), { type: 'tick', now: later });
    assert.equal(connectionState(online, later), 'online');
    assert.equal(hostState(hostOf(online, task(online, 't-docs')), later), 'online');
    assert.equal(hostState(hostOf(online, task(online, 't-icons')), later), 'stale');
    const stale = reducer(reducer(initialState(NOW), { type: 'connection', value: 'stale', now: NOW }), { type: 'tick', now: later });
    assert.equal(connectionState(stale, later), 'stale');
  });

  it('una tarea en un host sin conexión sigue «en curso», no fallida', () => {
    const s = initialState(NOW);
    const bench = task(s, 't-bench');
    assert.equal(hostState(hostOf(s, bench), NOW), 'offline');
    assert.equal(bench.status, 'running');
    assert.ok(!attention(s.tasks).some((a) => a.taskId === 't-bench'));
  });

  it('sin conexión una respuesta queda en cola y no resuelve la tarea', () => {
    const offline = reducer(initialState(NOW), { type: 'connection', value: 'offline', now: NOW });
    const { state, verdict } = act(offline, { type: 'answer', taskId: 't-migracion', label: 'Tabla nueva' }, NOW);
    assert.equal(verdict.mode, 'queue');
    assert.equal(state.outbox.length, 1);
    assert.equal(task(state, 't-migracion').pending.kind, 'question');
    assert.ok(attention(state.tasks).some((a) => a.taskId === 't-migracion'));
  });

  it('al reconectar se manda lo que estaba en cola', () => {
    const offline = reducer(initialState(NOW), { type: 'connection', value: 'offline', now: NOW });
    const queued = act(offline, { type: 'answer', taskId: 't-migracion', label: 'Tabla nueva' }, NOW).state;
    const back = reducer(queued, { type: 'connection', value: 'online', now: NOW + 1000 });
    assert.equal(back.outbox.length, 0);
    assert.equal(task(back, 't-migracion').pending, null);
  });

  it('sin conexión no se aprueba con datos guardados', () => {
    const offline = reducer(initialState(NOW), { type: 'connection', value: 'offline', now: NOW });
    const { state, verdict } = act(offline, { type: 'approve', taskId: 't-dependencia' }, NOW);
    assert.equal(verdict.mode, 'blocked');
    assert.equal(state, offline);
  });

  it('con datos desactualizados hay que actualizar antes de decidir', () => {
    const stale = reducer(initialState(NOW), { type: 'connection', value: 'stale', now: NOW });
    assert.equal(act(stale, { type: 'approve', taskId: 't-dependencia' }, NOW).verdict.mode, 'refresh');
    const fresh = reducer(stale, { type: 'refresh', now: NOW });
    assert.equal(act(fresh, { type: 'approve', taskId: 't-dependencia' }, NOW).verdict.mode, 'send');
  });
});

describe('3 · destino, host y política antes de decidir', () => {
  it('sin contexto la decisión se bloquea', () => {
    const s = initialState(NOW);
    const t = { ...task(s, 't-dependencia'), target: null };
    assert.equal(decide('approval', { task: t, host: hostOf(s, t), connection: 'online', now: NOW }).mode, 'blocked');
  });

  it('todas las tareas de los fixtures traen destino, host y política', () => {
    for (const t of initialState(NOW).tasks) {
      assert.ok(t.target?.branch && t.hostId && t.policy?.level, t.id);
    }
  });

  it('la política elevada se aprueba en Desktop, pero se puede rechazar', () => {
    const s = initialState(NOW);
    assert.equal(act(s, { type: 'approve', taskId: 't-release' }, NOW).verdict.mode, 'desktop');
    assert.equal(act(s, { type: 'reject', taskId: 't-release' }, NOW).verdict.mode, 'send');
  });
});

describe('4 · la revisión compleja escala a Desktop y la vieja no se acepta', () => {
  it('clasifica por tamaño y zonas delicadas', () => {
    const s = initialState(NOW);
    assert.equal(reviewComplexity(task(s, 't-avatar').pending.review), 'normal');
    assert.equal(reviewComplexity(task(s, 't-cobros').pending.review), 'high');
    const small = { additions: 3, deletions: 0, files: [{ path: 'db/migrations/0001.sql' }] };
    assert.equal(reviewComplexity(small), 'high');
  });

  it('la revisión pequeña y al día se acepta', () => {
    const { state, verdict } = act(initialState(NOW), { type: 'accept', taskId: 't-avatar' }, NOW);
    assert.equal(verdict.mode, 'send');
    assert.equal(task(state, 't-avatar').status, 'done');
  });

  it('la revisión grande se manda a Desktop', () => {
    assert.equal(act(initialState(NOW), { type: 'accept', taskId: 't-cobros' }, NOW).verdict.mode, 'desktop');
  });

  it('la revisión vieja no se acepta hasta regenerarla', () => {
    let s = reducer(initialState(NOW), { type: 'refresh', now: NOW });
    assert.equal(act(s, { type: 'accept', taskId: 't-tema' }, NOW).verdict.mode, 'refresh');
    s = reducer(s, { type: 'refreshReview', taskId: 't-tema', now: NOW });
    assert.equal(act(s, { type: 'accept', taskId: 't-tema' }, NOW).verdict.mode, 'send');
  });

  it('el traspaso a Desktop no se inventa un host', () => {
    const s = initialState(NOW);
    assert.equal(desktopHandoff(task(s, 't-cobros'), s.hosts, NOW).id, 'h-studio');
    const noDesktop = s.hosts.map((h) => ({ ...h, connected: h.kind !== 'desktop' }));
    assert.equal(desktopHandoff(task(s, 't-cobros'), noDesktop, NOW), null);
  });
});

describe('5 · push y fixtures sin secretos ni diffs', () => {
  it('detecta secretos y diffs', () => {
    assert.ok(containsSecret('Authorization: Bearer abcdefghijklmnop'));
    assert.ok(containsSecret('ghp_0123456789abcdefghij0123'));
    assert.ok(containsDiff('diff --git a/x b/x\n@@ -1 +1 @@'));
    assert.ok(!containsSecret('Migrar la tabla de sesiones a UUID'));
  });

  it('los fixtures no llevan secretos ni diffs', () => {
    const raw = JSON.stringify(buildFixtures(NOW));
    assert.ok(!containsSecret(raw));
    assert.ok(!containsDiff(raw.replace(/\\n/g, '\n')));
  });

  it('el push no lleva el comando, la pregunta ni el diff', () => {
    const s = initialState(NOW);
    for (const n of s.notifications) {
      const t = task(s, n.taskId);
      const p = pushPayload(n, t, s.projects.find((x) => x.id === t.projectId));
      const text = JSON.stringify(p);
      assert.ok(!containsSecret(text) && !containsDiff(text), n.id);
      if (t.pending?.action) assert.ok(!text.includes(t.pending.action), n.id);
      if (t.pending?.question) assert.ok(!text.includes(t.pending.question), n.id);
      assert.deepEqual(Object.keys(p.data), ['taskId']);
    }
  });

  it('si el título trae algo sensible, el push no lo repite', () => {
    const p = pushPayload({ kind: 'done', taskId: 'x' }, { title: 'Rotar token: abc123' }, { name: 'core' });
    assert.equal(p.body, 'Abre Lixbon para verlo');
  });
});
