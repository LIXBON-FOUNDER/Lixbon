// Las fixtures son realistas, variadas y válidas contra el vocabulario canónico.
// Se leen a través del MockAdeClient (lo que ve la interfaz), no en bruto.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClient, makeFixtures, NOW } from '../testing/helpers';
import { checkAdeClientConformance } from '../client/conformance';
import { createFixtures as createFixturesAt } from './fixtures';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const contrato = JSON.parse(readFileSync(resolve(RAIZ, 'contracts', 'status-vocabulary.json'), 'utf8')).domain;

async function cargar() {
  const c = makeClient();
  const [proyectos, tareas, intentos, atencion, actividad, agentes] = await Promise.all([
    c.listProjects({ includeArchived: true }), c.listTasks(), c.listAttempts(), c.listAttention(), c.listActivity({ limit: 500 }), c.listAgents(),
  ]);
  return { c, proyectos, tareas, intentos, atencion, actividad, agentes };
}

describe('fixtures del ADE', () => {
  it('son válidas contra el vocabulario y todos los campos tienen slice declarado', async () => {
    expect(await checkAdeClientConformance(makeClient())).toEqual([]);
  });

  it('3 o más proyectos activos, uno archivado y una ruta ausente', async () => {
    const { proyectos } = await cargar();
    expect(proyectos.filter((p) => p.state === 'active').length).toBeGreaterThanOrEqual(3);
    expect(proyectos.some((p) => p.state === 'archived')).toBe(true);
    expect(proyectos.some((p) => p.locations.some((l) => l.state === 'missing'))).toBe(true);
    expect(proyectos.some((p) => p.locations.length > 1)).toBe(true);
  });

  it('cubren los nueve estados de Attempt del vocabulario', async () => {
    const { intentos } = await cargar();
    expect([...new Set(intentos.map((a) => a.state))].sort()).toEqual([...contrato.attempt_state.ids].sort());
  });

  it('cubren los seis kinds de Attention (cuatro vigentes y dos reservados)', async () => {
    const { atencion } = await cargar();
    const kinds = new Set(atencion.map((i) => i.kind));
    for (const k of [...contrato.attention_kind.ids, ...contrato.attention_kind.reservados]) expect(kinds.has(k), k).toBe(true);
  });

  it('hay Tasks con varios intentos, de varios agentes y proveedores', async () => {
    const { tareas, intentos, agentes } = await cargar();
    expect(tareas.some((t) => t.attemptIds.length >= 2)).toBe(true);
    const proveedores = new Set(intentos.map((a) => a.agent.provider));
    expect(proveedores.has('claude') && proveedores.has('codex')).toBe(true);
    expect(new Set(intentos.map((a) => a.agent.model)).size).toBeGreaterThanOrEqual(4);
    expect(agentes.some((g) => g.id === 'claude') && agentes.some((g) => g.id === 'codex')).toBe(true);
    expect(agentes.some((g) => !g.available)).toBe(true);
  });

  it('el estado derivado de cada Task es coherente con sus intentos y cubre los cinco estados', async () => {
    const { tareas } = await cargar();
    expect(new Set(tareas.map((t) => t.derivedState))).toEqual(new Set(contrato.task_derived_state.ids));
    const por = Object.fromEntries(tareas.map((t) => [t.id, t.derivedState]));
    expect(por.tsk_dark).toBe('integrated');
    expect(por.tsk_pago).toBe('in_review');
    expect(por.tsk_checkout).toBe('in_progress');
    expect(por.tsk_old).toBe('discarded');
  });

  it('hay una pregunta pendiente, una revisión desactualizada, una rechazada, un fallo con motivo y una aprobación en la terminal', async () => {
    const { c, intentos, atencion } = await cargar();
    expect(intentos.find((a) => a.pendingQuestion)).toBeTruthy();
    expect((await c.getReview('att_logs_1')).state).toBe('stale');
    expect((await c.getReview('att_ref_1')).state).toBe('rejected');
    expect((await c.getReview('att_pago_1')).state).toBe('accepted');
    expect(intentos.find((a) => a.state === 'failed').failureReason).toBeTruthy();
    expect(atencion.find((i) => i.kind === 'approve_in_terminal')).toBeTruthy();
    expect(intentos.find((a) => a.state === 'awaiting_terminal_approval').approvalDeadline).toBeGreaterThan(NOW);
  });

  it('hay un lanzamiento pendiente con política elevada y con avisos', async () => {
    const { intentos } = await cargar();
    const pend = intentos.filter((a) => a.state === 'pending_approval');
    expect(pend.length).toBeGreaterThanOrEqual(2);
    expect(pend.some((a) => a.policy.elevated && a.policy.warnings.length > 0)).toBe(true);
  });

  it('la actividad reciente usa solo eventos durables, tiene personas, agentes y sistema, y viene de varios clientes', async () => {
    const { actividad } = await cargar();
    expect(actividad.length).toBeGreaterThanOrEqual(12);
    expect(new Set(actividad.map((e) => e.actor.kind))).toEqual(new Set(['human', 'agent', 'system']));
    expect(actividad.some((e) => e.actor.client === 'mobile')).toBe(true);
    expect(actividad.every((e) => contrato.event.dominio_durable_reservado.ids.includes(e.type))).toBe(true);
    expect(actividad.every((e) => contrato.entity_kind.ids.includes(e.entity.kind))).toBe(true);
  });

  it('los ids son únicos y las referencias cruzadas existen', () => {
    const f = makeFixtures();
    const unicos = (lista) => new Set(lista.map((x) => x.id)).size === lista.length;
    for (const k of ['projects', 'tasks', 'attempts', 'threads', 'worktrees', 'artifacts']) expect(unicos(f[k]), k).toBe(true);
    const proy = new Set(f.projects.map((p) => p.id));
    const intentos = new Map(f.attempts.map((a) => [a.id, a]));
    for (const t of f.tasks) {
      expect(proy.has(t.projectId), t.id).toBe(true);
      t.attemptIds.forEach((id) => expect(intentos.get(id)?.taskId, id).toBe(t.id));
    }
    for (const a of f.attempts) expect(f.tasks.some((t) => t.id === a.taskId), a.id).toBe(true);
    for (const w of f.worktrees) expect(intentos.has(w.attemptId), w.id).toBe(true);
    for (const h of f.threads) h.attemptIds.forEach((id) => expect(intentos.has(id), h.id).toBe(true));
  });

  it('los tiempos son relativos al instante base (no hay fechas fijas)', () => {
    const a = createFixturesAt(1000000000000);
    const b = createFixturesAt(2000000000000);
    expect(b.projects[0].locations[0].lastSeen - a.projects[0].locations[0].lastSeen).toBe(1000000000000);
  });
});
