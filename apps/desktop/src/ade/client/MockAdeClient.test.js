import { describe, it, expect, vi } from 'vitest';
import { checkAdeClientConformance } from './conformance';
import { ADE_METHODS, assertAdeClient, missingAdeMethods } from './contract';
import { CORE_INTENT_IDS, RESERVED_INTENT_IDS, INTENT_IDS, HOST_INTENT_IDS } from './intents';
import { makeClient, NOW } from '../testing/helpers';

describe('conformidad del MockAdeClient con la interfaz', () => {
  it('implementa todos los métodos del contrato', () => {
    const c = makeClient();
    expect(missingAdeMethods(c)).toEqual([]);
    expect(assertAdeClient(c)).toBe(c);
    for (const m of ADE_METHODS) expect(typeof c[m], m).toBe('function');
  });

  it('pasa la batería de conformidad: formas, ids del vocabulario y todo campo con slice declarado', async () => {
    expect(await checkAdeClientConformance(makeClient())).toEqual([]);
    expect(await checkAdeClientConformance(makeClient({ clientKind: 'mobile' }))).toEqual([]);
  });

  it('la batería detecta un cliente al que le faltan métodos y un campo sin slice', async () => {
    expect((await checkAdeClientConformance({ listProjects() {} }))[0]).toMatch(/faltan métodos/);
    const c = makeClient();
    const original = c.listProjects;
    c.listProjects = async (o) => (await original(o)).map((p) => ({ ...p, campoNuevo: 1 }));
    expect((await checkAdeClientConformance(c)).join('\n')).toMatch(/campoNuevo/);
  });

  it('getConnection dice que la fuente es mock; getCapabilities cubre todos los intents del Core', async () => {
    const c = makeClient();
    expect(await c.getConnection()).toMatchObject({ source: 'mock', clientKind: 'desktop', coreMode: 'in_process' });
    const caps = await c.getCapabilities();
    expect(Object.keys(caps).sort()).toEqual([...CORE_INTENT_IDS].sort());
  });
});

describe('capacidades: lo simulado se rotula y lo que el Core no ofrece no se finge', () => {
  it('las decisiones disponibles son «simulated», nunca «available»', async () => {
    const caps = await makeClient().getCapabilities();
    for (const id of ['approve_spawn', 'reject_spawn', 'answer_question', 'review_attempt', 'integrate_attempt', 'launch_task', 'stop_attempt']) {
      expect(caps[id].availability, id).toBe('simulated');
    }
    expect(Object.values(caps).some((c) => c.availability === 'available')).toBe(false);
  });

  it('retry, resume, continuar con otro agente, competir y comparar están no disponibles y nombran su slice', async () => {
    const caps = await makeClient().getCapabilities();
    const esperado = {
      retry_attempt: 'Task/Attempt', resume_attempt: 'Task/Attempt', continue_with_other_agent: 'ContextPackage',
      race_attempts: 'Task/Attempt', compare_attempts: 'Task/Attempt', register_project: 'D',
    };
    for (const [id, slice] of Object.entries(esperado)) {
      expect(caps[id].availability, id).toBe('unavailable');
      expect(caps[id].slice, id).toBe(slice);
      expect(caps[id].reason, id).toContain(slice);
    }
    expect([...RESERVED_INTENT_IDS].sort()).toEqual(Object.keys(esperado).sort());
  });

  it('despachar un intent reservado rechaza con «unavailable» y el slice, sin cambiar nada', async () => {
    const c = makeClient();
    const antes = JSON.stringify(await c.listAttempts());
    await expect(c.dispatch({ type: 'retry_attempt', attemptId: 'att_webhook_2' })).rejects.toMatchObject({ code: 'unavailable', slice: 'Task/Attempt' });
    expect(JSON.stringify(await c.listAttempts())).toBe(antes);
  });

  it('las capacidades del cliente (abrir diff/IDE/terminal) no son del Core: dispatch las rechaza', async () => {
    const c = makeClient();
    for (const id of HOST_INTENT_IDS) await expect(c.dispatch({ type: id, attemptId: 'att_pago_1' })).rejects.toMatchObject({ code: 'invalid' });
    expect(INTENT_IDS).toEqual(expect.arrayContaining(HOST_INTENT_IDS));
  });

  it('el móvil no integra ni lanza (fuera del alcance aprobado) pero sí responde, aprueba y revisa', async () => {
    const m = makeClient({ clientKind: 'mobile' });
    const caps = await m.getCapabilities();
    expect(caps.integrate_attempt.availability).toBe('unavailable');
    expect(caps.launch_task.availability).toBe('unavailable');
    for (const id of ['answer_question', 'approve_spawn', 'reject_spawn', 'review_attempt', 'stop_attempt']) expect(caps[id].availability, id).toBe('simulated');
    await expect(m.dispatch({ type: 'integrate_attempt', attemptId: 'att_pago_1', headCommit: 'x', confirm: true })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('el móvil no puede aprobar un lanzamiento con política elevada', async () => {
    const m = makeClient({ clientKind: 'mobile' });
    const a = await m.getAttempt('att_deploy_1');
    expect(a.policy.elevated).toBe(true);
    await expect(m.dispatch({ type: 'approve_spawn', attemptId: a.id, confirmedCommand: a.policy.command })).rejects.toMatchObject({ code: 'forbidden', slice: 'F' });
    expect((await m.getAttempt(a.id)).state).toBe('pending_approval');
    const normal = await m.getAttempt('att_guia_1');
    await expect(m.dispatch({ type: 'approve_spawn', attemptId: normal.id, confirmedCommand: normal.policy.command })).resolves.toMatchObject({ ok: true, simulated: true });
  });
});

describe('las decisiones solo mutan la memoria del mock y son coherentes', () => {
  it('toda respuesta de una decisión es simulada', async () => {
    const r = await makeClient().dispatch({ type: 'stop_attempt', attemptId: 'att_checkout_2' });
    expect(r).toMatchObject({ ok: true, simulated: true, intent: 'stop_attempt' });
    expect(r.message).toMatch(/Simulado/);
  });

  it('aprobar un lanzamiento exige el comando confirmado y crea el worktree', async () => {
    const c = makeClient();
    await expect(c.dispatch({ type: 'approve_spawn', attemptId: 'att_guia_1', confirmedCommand: ['otro'] })).rejects.toMatchObject({ code: 'invalid' });
    await c.dispatch({ type: 'approve_spawn', attemptId: 'att_guia_1', confirmedCommand: (await c.getAttempt('att_guia_1')).policy.command });
    expect((await c.getAttempt('att_guia_1')).state).toBe('starting');
    expect(await c.listWorktrees({ attemptId: 'att_guia_1' })).toHaveLength(1);
    expect((await c.listAttention()).some((i) => i.attemptId === 'att_guia_1')).toBe(false);
    await expect(c.dispatch({ type: 'approve_spawn', attemptId: 'att_guia_1', confirmedCommand: ['x'] })).rejects.toMatchObject({ code: 'stale' });
  });

  it('rechazar un lanzamiento detiene el intento y lo registra en la actividad', async () => {
    const c = makeClient();
    await c.dispatch({ type: 'reject_spawn', attemptId: 'att_deploy_1' });
    expect((await c.getAttempt('att_deploy_1')).state).toBe('stopped');
    expect((await c.listActivity({ attemptId: 'att_deploy_1' }))[0].type).toBe('attempt.rejected');
  });

  it('responder una pregunta limpia la Attention, reanuda el intento y añade la respuesta al hilo', async () => {
    const c = makeClient();
    expect((await c.listAttention()).some((i) => i.kind === 'unanswered_question')).toBe(true);
    await expect(c.dispatch({ type: 'answer_question', attemptId: 'att_rate_1', text: '   ' })).rejects.toMatchObject({ code: 'invalid' });
    await c.dispatch({ type: 'answer_question', attemptId: 'att_rate_1', text: 'Por clave de API.' });
    const a = await c.getAttempt('att_rate_1');
    expect(a.state).toBe('running');
    expect(a.pendingQuestion).toBeNull();
    expect((await c.listAttention()).some((i) => i.kind === 'unanswered_question')).toBe(false);
    const hilo = await c.getThread('th_rate');
    expect(hilo.messages.at(-1)).toMatchObject({ kind: 'reply', replyTo: 'msg_rate_q1', text: 'Por clave de API.' });
    await expect(c.dispatch({ type: 'answer_question', attemptId: 'att_rate_1', text: 'otra' })).rejects.toMatchObject({ code: 'stale' });
  });

  it('revisar: aceptar convierte «review» en «integrate»; un commit viejo da «stale»', async () => {
    const c = makeClient();
    const antes = (await c.listAttention()).find((i) => i.attemptId === 'att_i18n_1');
    expect(antes).toMatchObject({ kind: 'review', reason: 'none' });
    const rev = await c.getReview('att_i18n_1');
    await expect(c.dispatch({ type: 'review_attempt', attemptId: 'att_i18n_1', decision: 'accepted', headCommit: 'commit-viejo' })).rejects.toMatchObject({ code: 'stale' });
    await c.dispatch({ type: 'review_attempt', attemptId: 'att_i18n_1', decision: 'accepted', headCommit: rev.currentHeadCommit });
    expect((await c.getReview('att_i18n_1')).state).toBe('accepted');
    expect((await c.listAttention()).find((i) => i.attemptId === 'att_i18n_1').kind).toBe('integrate');
    expect((await c.getTask('tsk_i18n')).derivedState).toBe('in_review');
  });

  it('una revisión rechazada no genera Attention (el coordinador debe corregir)', async () => {
    const c = makeClient();
    const rev = await c.getReview('att_i18n_1');
    await c.dispatch({ type: 'review_attempt', attemptId: 'att_i18n_1', decision: 'rejected', headCommit: rev.currentHeadCommit });
    expect((await c.listAttention()).some((i) => i.attemptId === 'att_i18n_1')).toBe(false);
  });

  it('integrar exige confirmación y revisión aceptada; al integrar, la Task pasa a «integrated»', async () => {
    const c = makeClient();
    const head = (await c.getReview('att_pago_1')).currentHeadCommit;
    await expect(c.dispatch({ type: 'integrate_attempt', attemptId: 'att_pago_1', headCommit: head, confirm: false })).rejects.toMatchObject({ code: 'invalid' });
    await expect(c.dispatch({ type: 'integrate_attempt', attemptId: 'att_i18n_1', headCommit: 'x', confirm: true })).rejects.toMatchObject({ code: 'forbidden' });
    await c.dispatch({ type: 'integrate_attempt', attemptId: 'att_pago_1', headCommit: head, confirm: true });
    expect((await c.getIntegration('att_pago_1')).outcome).toBe('merged');
    expect((await c.getTask('tsk_pago')).derivedState).toBe('integrated');
    expect((await c.listAttention()).some((i) => i.attemptId === 'att_pago_1')).toBe(false);
  });

  it('lanzar trabajo nuevo crea Task + intento pendiente de aprobación + Attention pending_spawn', async () => {
    const c = makeClient();
    await expect(c.dispatch({ type: 'launch_task', projectId: 'prj_movil', title: 'x', agent: { provider: 'claude' } })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(c.dispatch({ type: 'launch_task', projectId: 'prj_orbita', title: 'x', agent: { provider: 'opencode' } })).rejects.toMatchObject({ code: 'invalid' });
    const r = await c.dispatch({ type: 'launch_task', projectId: 'prj_orbita', title: 'Nuevo objetivo', agent: { provider: 'codex' } });
    const tid = r.effects.find((e) => e.kind === 'task').id;
    const t = await c.getTask(tid);
    expect(t).toMatchObject({ projectId: 'prj_orbita', title: 'Nuevo objetivo', derivedState: 'in_progress' });
    const [a] = await c.listAttempts({ taskId: tid });
    expect(a).toMatchObject({ state: 'pending_approval', ordinal: 1 });
    expect((await c.listAttention()).find((i) => i.attemptId === a.id)).toMatchObject({ kind: 'pending_spawn' });
  });

  it('detener un intento ya terminado es «stale»', async () => {
    const c = makeClient();
    await expect(c.dispatch({ type: 'stop_attempt', attemptId: 'att_pago_1' })).rejects.toMatchObject({ code: 'stale' });
  });

  it('posponer oculta lo pospuesto en el estado de la persona, no lo borra', async () => {
    const c = makeClient();
    const id = (await c.listAttention())[0].id;
    await c.dispatch({ type: 'snooze_attention', attentionId: id, forMs: 3600000 });
    const item = (await c.listAttention()).find((i) => i.id === id);
    expect(item.person.snoozedUntil).toBeGreaterThan(NOW);
    expect(item.person.seen).toBe(true);
  });

  it('intents mal formados se rechazan con «invalid»', async () => {
    const c = makeClient();
    await expect(c.dispatch({ type: 'no_existe' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(c.dispatch({ type: 'stop_attempt' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(c.dispatch({ type: 'stop_attempt', attemptId: 'nada' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('consultas', () => {
  it('lo que devuelve es una copia: mutarlo no altera el mock', async () => {
    const c = makeClient();
    (await c.listProjects())[0].name = 'cambiado';
    expect((await c.listProjects())[0].name).not.toBe('cambiado');
  });

  it('un id inexistente es not_found', async () => {
    const c = makeClient();
    for (const m of ['getProject', 'getTask', 'getAttempt', 'getThread', 'getReview', 'getIntegration']) {
      await expect(c[m]('inexistente'), m).rejects.toMatchObject({ code: 'not_found' });
    }
  });

  it('listProjects oculta los archivados salvo que se pidan', async () => {
    const c = makeClient();
    expect((await c.listProjects()).every((p) => p.state === 'active')).toBe(true);
    expect((await c.listProjects({ includeArchived: true })).some((p) => p.state === 'archived')).toBe(true);
  });

  it('la actividad llega de más reciente a más antigua, con limit y filtros', async () => {
    const c = makeClient();
    const todo = await c.listActivity();
    expect(todo.map((e) => e.seq)).toEqual([...todo.map((e) => e.seq)].sort((a, b) => b - a));
    expect(await c.listActivity({ limit: 3 })).toHaveLength(3);
    expect((await c.listActivity({ projectId: 'prj_docs' })).every((e) => e.projectId === 'prj_docs')).toBe(true);
  });

  it('resolveLocation: camino IDE → intento por worktree, por rama y por archivo; null si no pertenece', async () => {
    const c = makeClient();
    const [w] = await c.listWorktrees({ attemptId: 'att_checkout_2' });
    const esperado = { projectId: 'prj_orbita', taskId: 'tsk_checkout', attemptId: 'att_checkout_2', worktreeId: w.id };
    expect(await c.resolveLocation({ worktreePath: w.path })).toEqual(esperado);
    expect(await c.resolveLocation({ path: `${w.path}/src/a.jsx` })).toEqual(esperado);
    expect(await c.resolveLocation({ branch: w.branch })).toEqual(esperado);
    expect(await c.resolveLocation({ path: 'C:/proyectos/orbita-web/src/x.js' })).toEqual({ projectId: 'prj_orbita', taskId: null, attemptId: null, worktreeId: null });
    expect(await c.resolveLocation({ path: 'D:/otro/lado' })).toBeNull();
  });
});

describe('simulación: latencia, fallos y datos vacíos', () => {
  it('la latencia retrasa las respuestas', async () => {
    vi.useFakeTimers();
    const c = makeClient({ latencyMs: 500 });
    let listo = false;
    c.listProjects().then(() => { listo = true; });
    await vi.advanceTimersByTimeAsync(400);
    expect(listo).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    expect(listo).toBe(true);
    vi.useRealTimers();
  });

  it('failNext falla una sola vez; failAlways hasta limpiarlo', async () => {
    const c = makeClient();
    c.sim.failNext('listAttention');
    await expect(c.listAttention()).rejects.toMatchObject({ code: 'unavailable', simulated: true });
    await expect(c.listAttention()).resolves.toBeInstanceOf(Array);
    c.sim.failAlways('listTasks');
    await expect(c.listTasks()).rejects.toBeTruthy();
    await expect(c.listTasks()).rejects.toBeTruthy();
    c.sim.clearFailures();
    await expect(c.listTasks()).resolves.toBeInstanceOf(Array);
  });

  it('un error propio llega tal cual', async () => {
    const c = makeClient();
    const e = new Error('boom');
    c.sim.failNext('listProjects', e);
    await expect(c.listProjects()).rejects.toBe(e);
  });

  it('useEmptyData deja el espacio sin proyectos ni Attention, y reset lo recupera', async () => {
    const c = makeClient();
    c.sim.useEmptyData();
    expect(await c.listProjects({ includeArchived: true })).toEqual([]);
    expect(await c.listAttention()).toEqual([]);
    expect((await c.listAgents()).length).toBeGreaterThan(0);
    c.sim.reset();
    expect((await c.listProjects()).length).toBeGreaterThanOrEqual(3);
  });
});

describe('suscripción a cambios', () => {
  it('avisa QUÉ cambió (no los datos) y deja de avisar al darse de baja', async () => {
    const c = makeClient();
    const oyente = vi.fn();
    const baja = c.subscribe(oyente);
    await c.dispatch({ type: 'stop_attempt', attemptId: 'att_checkout_2' });
    expect(oyente).toHaveBeenCalledTimes(1);
    const aviso = oyente.mock.calls[0][0];
    expect(aviso).toMatchObject({ type: 'changed', entities: [{ kind: 'attempt', id: 'att_checkout_2' }] });
    expect(typeof aviso.seq).toBe('number');
    baja();
    await c.dispatch({ type: 'stop_attempt', attemptId: 'att_busq_1' });
    expect(oyente).toHaveBeenCalledTimes(1);
  });

  it('un fallo de la decisión no emite ningún aviso', async () => {
    const c = makeClient();
    const oyente = vi.fn();
    c.subscribe(oyente);
    await c.dispatch({ type: 'stop_attempt', attemptId: 'att_pago_1' }).catch(() => {});
    expect(oyente).not.toHaveBeenCalled();
  });
});
