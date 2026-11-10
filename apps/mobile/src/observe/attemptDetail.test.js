// Pruebas de la ficha de un intento en Supervisar (LXO-127): `npm test` (node --test).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { artifactLine, attemptDetailModel, reviewLine } from './attempts.js';
import { attentionTarget } from './attention.js';

// Como llega por el relé (`core_attempt`, `slimAttempt` de Desktop).
const attempt = (status, over = {}) => ({
  id: 't3-a2', task_id: 't3', n: 2, status, provider: 'codex', model: 'gpt-5', role: 'implementador', origin: 'lixbon',
  created_at: 1, started_at: 2, ended_at: ['done', 'failed', 'stopped', 'exited'].includes(status) ? 3 : null,
  failure_reason: null, integrated: null, has_summary: null, host: null, effort: 'high', profile: 'implementar', summary: null,
  provider_session: null, worktree: null, artifacts: [], review: null, ...over,
});
const task = { id: 't3', title: 'API de sesiones', state: 'in_review', project_id: 'p1', current_attempt_id: 't3-a2' };
const session = { status: 'idle', resumable: true, bound: true, binding: 'session_id', opened_here: false };
const worktree = { path: '/home/ana/app.lixbon-wt/t3', branch: 'lx/r1/t3', base_branch: 'main', provenance: 'created', state: 'active', machine: null, branch_kept: false };

describe('running / final / failed / cancelled', () => {
  it('en marcha: sin resultado, con su ciclo de vida', () => {
    const m = attemptDetailModel(attempt('running'), task);
    assert.equal(m.status.label, 'Trabajando');
    assert.equal(m.final, false);
    assert.equal(m.result, null);
    assert.equal(m.lifecycle, 'El agente está trabajando.');
    assert.equal(m.current, true);
    assert.equal(m.taskTitle, 'API de sesiones');
    assert.equal(m.taskState, 'En revisión');
  });

  it('terminado e integrado', () => {
    const m = attemptDetailModel(attempt('done', { integrated: true, summary: 'API lista' }), task);
    assert.equal(m.final, true);
    assert.equal(m.result.text, 'Integrado');
    assert.equal(m.summary, 'API lista');
  });

  it('fallido, con su motivo', () => {
    const m = attemptDetailModel(attempt('failed', { failure_reason: 'terminal_approval_timeout' }), { ...task, current_attempt_id: 't3-a3' });
    assert.equal(m.status.tone, 'error');
    assert.equal(m.result.text, 'Falló: nadie aprobó en la terminal a tiempo');
    assert.equal(m.current, false, 'no es el actual: lo dice');
  });

  it('cancelado (detenido) y pendiente de aprobación', () => {
    assert.equal(attemptDetailModel(attempt('stopped')).lifecycle, 'Se detuvo (cancelado).');
    assert.equal(attemptDetailModel(attempt('stopped')).result.text, 'Se detuvo');
    assert.equal(attemptDetailModel(attempt('pending_approval')).lifecycle, 'Espera a que una persona apruebe su lanzamiento.');
    assert.equal(attemptDetailModel(attempt('pending_approval')).current, null, 'sin su Task no se sabe si es el actual');
  });
});

describe('con y sin sesión, worktree, artefactos y revisión', () => {
  it('sin nada registrado: cada sección lo dice', () => {
    const m = attemptDetailModel(attempt('pending_approval'));
    assert.deepEqual(m.session, { present: false });
    assert.deepEqual(m.worktree, { present: false });
    assert.deepEqual(m.artifacts, []);
    assert.equal(m.review.present, false);
    assert.equal(m.review.title, 'Sin revisión');
    assert.equal(m.host, null);
  });

  it('la sesión, resumida y sin su id (es opaco)', () => {
    const m = attemptDetailModel(attempt('done', { provider_session: session }));
    assert.deepEqual(m.session, { present: true, status: 'En espera', resumable: 'Se puede reanudar', bound: 'Vinculada al proveedor por su id de sesión', opened: 'Viene de un intento anterior de la tarea' });
    assert.ok(!JSON.stringify(m).includes('ps-'), 'ningún id de sesión');
    assert.equal(attemptDetailModel(attempt('done', { provider_session: { ...session, opened_here: true, bound: false } })).session.bound, 'Sin vincular al proveedor');
  });

  it('el worktree: la ruta es ubicación y el host desconocido se dice', () => {
    const m = attemptDetailModel(attempt('done', { worktree }));
    assert.equal(m.worktree.branch, 'lx/r1/t3');
    assert.equal(m.worktree.provenance, 'Creado por Lixbon');
    assert.deepEqual(m.worktree.state, { label: 'En disco', tone: 'ok' });
    assert.equal(m.worktree.host, null);
    assert.equal(m.worktree.path, '/home/ana/app.lixbon-wt/t3');
    assert.equal(m.id, 't3-a2', 'la identidad es el id del intento, no la ruta');
    const gone = attemptDetailModel(attempt('done', { worktree: { ...worktree, state: 'missing', machine: 'torre', provenance: 'external' } }));
    assert.deepEqual(gone.worktree.state, { label: 'No está en disco', tone: 'warn' });
    assert.equal(gone.worktree.provenance, 'Externo: Lixbon no lo limpia');
    assert.equal(gone.host, 'torre');
  });

  it('los artefactos, resumidos', () => {
    assert.deepEqual(artifactLine({ kind: 'pull_request', uri: 'https://github.com/o/r/pull/169' }), { kind: 'pull_request', label: 'Pull request', short: '#169', uri: 'https://github.com/o/r/pull/169' });
    assert.equal(artifactLine({ kind: 'report', uri: 'C:\\r\\app\\.lixbon\\informes\\r1\\t3.md' }).short, 't3.md');
    assert.equal(artifactLine({ kind: 'last_message', uri: '/home/ana/out/last.txt' }).short, 'last.txt');
    assert.equal(artifactLine({ kind: 'commit', uri: 'c3c3c3c3c3c3c3c3' }).short, 'c3c3c3c3c3');
    assert.equal(artifactLine({ kind: 'raro', uri: null }).label, 'Artefacto');
    assert.equal(attemptDetailModel(attempt('done', { artifacts: [{ kind: 'report', uri: '/x/y.md' }, { kind: 'pull_request', uri: 'https://g/o/r/pull/2' }] })).artifacts.length, 2);
  });
});

describe('la revisión, vigente u obsoleta sin ambigüedad', () => {
  const r = (status, verdict = 'accepted') => ({ verdict, status, head_commit: 'c3c3c3c3c3c3', base_commit: 'b0b0b0' });
  it('vigente', () => {
    const v = reviewLine(r('active'));
    assert.deepEqual([v.title, v.current, v.tone], ['Aceptada · vigente', true, 'ok']);
    assert.match(v.text, /Revisó c3c3c3c3c3 sobre b0b0b0, que sigue siendo el código del intento/);
  });
  it('obsoleta', () => {
    const v = reviewLine(r('stale'));
    assert.deepEqual([v.title, v.current, v.tone], ['Aceptada · obsoleta', false, 'warn']);
    assert.match(v.text, /el código cambió después: hay que revisarlo otra vez/);
  });
  it('sustituida, rechazada y estado desconocido', () => {
    assert.equal(reviewLine(r('superseded')).title, 'Aceptada · sustituida');
    assert.deepEqual([reviewLine(r('active', 'rejected')).title, reviewLine(r('active', 'rejected')).tone], ['Rechazada · vigente', 'warn']);
    assert.equal(reviewLine(r('nuevo')).current, null, 'nunca se da por vigente lo que no se sabe');
  });
});

describe('Attention con el target correcto', () => {
  it('la Attention de un intento abre ese intento; la de la Task, la Task', () => {
    assert.deepEqual(attentionTarget({ target_kind: 'attempt', target_id: 't3-a2', project_id: 'p1' }).route, { name: 'attempt', attemptId: 't3-a2', projectId: 'p1' });
    assert.equal(attentionTarget({ target_kind: 'task', target_id: 't3' }).route.name, 'task');
  });
});
