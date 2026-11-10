import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AttemptDetail } from './AttemptDetail';
import { validateRace, validateRaceList } from './raceContract';
import { resetOutstandingQueries } from './coreQueryPolicy';
import { coreModelFromState } from './useCoreModel';
import { CANONICAL, attemptDetail } from './testFixtures/coreModelFixtures';
import { attemptActivityPage } from './testFixtures/attemptActivityFixtures';
import { liveWith, provider } from './testFixtures/providerCapabilitiesFixtures';

// LXO-216 · Race: lanzar N candidatos comparables, ver cada uno como el intento real que es, y entrar a Compare.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const V1 = coreModelFromState({ data: CANONICAL['core_model.v1.json'], error: null });
const tick = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
const flush = async () => { for (let i = 0; i < 4; i += 1) await tick(); };
afterEach(() => { cleanup(); invoke.mockReset(); resetOutstandingQueries(); });

const RACE_ID = `rc-${'a'.repeat(20)}`;
const noLineage = () => ({ v: 1, attempt_id: 't3-a1', forked_from: null, forks: [] });

/** Un Race con la forma del Core. `candidates` = [{ outcome, provider, status?, code? }]. */
function race(candidates, over = {}) {
  const list = candidates.map((c, i) => {
    const launched = c.outcome === 'launched';
    return {
      index: i, outcome: c.outcome, provider: c.provider ?? 'fake-completo', model: c.model ?? null,
      task_id: launched ? `t1${i}` : null, attempt_id: launched ? `t1${i}-a1` : null,
      status: launched ? (c.status ?? 'pending_approval') : null, code: c.outcome === 'failed' ? (c.code ?? 'launch_failed') : null,
    };
  });
  const launched = list.filter((c) => c.outcome === 'launched');
  const running = launched.filter((c) => !['done', 'failed', 'stopped', 'exited'].includes(c.status));
  return {
    v: 1, race_id: RACE_ID, source_attempt_id: 't3-a1', requested: list.length, strategy: 'clean', package_id: null, created_at: 1_792_000_000_000,
    candidates: list,
    summary: { launched: launched.length, failed: list.filter((c) => c.outcome === 'failed').length, not_attempted: list.filter((c) => c.outcome === 'not_attempted').length, active: running.length, finished: launched.length - running.length },
    compare: { attempt_ids: launched.length >= 2 ? launched.map((c) => c.attempt_id) : null },
    cancellable: running.map((c) => c.attempt_id),
    limits: { min_candidates: 2, max_candidates: 4, max_active_tasks: 8 },
    ...over,
  };
}
const TWO = () => race([{ outcome: 'launched' }, { outcome: 'launched', provider: 'otro' }]);

function mountCore({ caps = liveWith([provider('fake-completo'), provider('otro')]), status = 'done', current = TWO, past = [], decide = () => ({ ...TWO(), status: 'Requested', replayed: 0 }), cancel = () => ({ status: 'Cancelled', race_id: RACE_ID, results: [], race: TWO() }) } = {}) {
  const calls = [];
  const state = { race: current };
  invoke.mockImplementation(async (command, payload) => {
    calls.push({ command, payload });
    if (command === 'orch_call') {
      if (payload.cmd === 'task_race') return decide(payload);
      if (payload.cmd === 'task_race_cancel') { const r = cancel(payload); state.race = () => r.race; return r; }
      throw new Error(`orden inesperada: ${payload.cmd}`);
    }
    if (payload.query === 'provider_capabilities') return caps;
    if (payload.query === 'activity_list') return attemptActivityPage([]);
    if (payload.query === 'attempts_by_task') return { ...CANONICAL['attempts_by_task.v1.json'], task_id: 't3', items: [] };
    if (payload.query === 'pending_queue') return { v: 1, attempt_id: 't3-a1', task_id: 't3', items: [], finished: [], finished_limit: 20 };
    if (payload.query === 'attempt_lineage') return noLineage();
    if (payload.query === 'task_race_status') {
      if (payload.args.race_id) return state.race();
      return { v: 1, source_attempt_id: 't3-a1', races: past };
    }
    if (payload.query === 'attempt_compare') throw new Error('compare no se abre solo');
    return attemptDetail({ id: 't3-a1', task_id: 't3', n: 1, status, provider: 'fake-completo' });
  });
  return { calls, state };
}
const open = vi.fn();
const mount = () => render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} onOpenAttempt={open} />);
const sent = (calls) => calls.filter((c) => c.command === 'orch_call').map((c) => ({ cmd: c.payload.cmd, ...c.payload.args }));
const byId = (id) => screen.getByTestId(id);
const openForm = async () => { fireEvent.click(byId('attempt-race-open')); await flush(); };
afterEach(() => open.mockReset());

describe('Race · contrato', () => {
  const bad = (r, what) => expect(() => validateRace(r), what).toThrow(/ade_query_invalid_response: task_race_status/);

  it('acepta lo del Core y rechaza lo que no cuadra o trae ganador', () => {
    expect(validateRace(TWO())).toBeTruthy();
    expect(validateRace(race([{ outcome: 'launched' }, { outcome: 'failed' }, { outcome: 'not_attempted' }]))).toBeTruthy();
    bad({ ...TWO(), v: 2 }, 'versión');
    bad({ ...TWO(), race_id: 'x' }, 'race_id');
    bad({ ...TWO(), winner: 't10-a1' }, 'un ganador no existe en el contrato');
    bad({ ...TWO(), score: 0.9 }, 'ni una puntuación');
    bad({ ...TWO(), requested: 1 }, 'menos de dos');
    bad({ ...TWO(), candidates: TWO().candidates.slice(0, 1) }, 'faltan candidatos');
    bad({ ...TWO(), summary: { ...TWO().summary, launched: 1 } }, 'las cuentas no cuadran');
    bad({ ...TWO(), strategy: 'context_package' }, 'estrategia con paquete sin paquete');
    bad({ ...TWO(), compare: { attempt_ids: null } }, 'dos lanzados y Compare no se ofrece');
    bad({ ...TWO(), cancellable: [] }, 'cancelables que no son los que no han terminado');
    const sinAttempt = TWO();
    sinAttempt.candidates[0] = { ...sinAttempt.candidates[0], attempt_id: null };
    bad(sinAttempt, 'un candidato lanzado sin Attempt no es un Attempt real');
    const fallidoConAttempt = race([{ outcome: 'launched' }, { outcome: 'failed' }]);
    fallidoConAttempt.candidates[1].attempt_id = 't99-a1';
    bad(fallidoConAttempt, 'un fallido con Attempt');
    const sinCodigo = race([{ outcome: 'launched' }, { outcome: 'failed' }]);
    sinCodigo.candidates[1].code = null;
    bad(sinCodigo, 'un fallo sin código');
    const extra = TWO();
    extra.candidates[0].best = true;
    bad(extra, 'un campo extra en un candidato');
  });

  it('la lista de Races es de ese Attempt y no admite campos de más', () => {
    const ok = { v: 1, source_attempt_id: 't3-a1', races: [{ race_id: RACE_ID, requested: 2, created_at: 1 }] };
    expect(validateRaceList(ok, { source_attempt_id: 't3-a1' })).toBeTruthy();
    expect(() => validateRaceList(ok, { source_attempt_id: 'otro' })).toThrow();
    expect(() => validateRaceList({ ...ok, races: [{ ...ok.races[0], winner: true }] }, { source_attempt_id: 't3-a1' })).toThrow();
  });
});

describe('Race · lanzar', () => {
  it('se ofrece cuando el intento no espera aprobación y el formulario dice qué hará el Core antes de confirmar', async () => {
    mountCore({ status: 'pending_approval' });
    const pending = mount();
    await flush();
    expect(screen.queryByTestId('attempt-race')).toBeNull();
    pending.unmount();

    const core = mountCore();
    mount();
    await flush();
    const reads = core.calls.length;
    await openForm();
    expect(byId('attempt-race-source').textContent).toMatch(/de 2 a 4 intentos nuevos y comparables a partir de t3-a1.*Este intento no se modifica/);
    expect(screen.getAllByTestId(/^attempt-race-candidate-/)).toHaveLength(2);
    const impl = byId('attempt-race-implications').textContent;
    expect(impl).toMatch(/worktree nuevo e independiente.*pendiente de tu aprobación/);
    expect(impl).toMatch(/No se elige ganador y no se cancela a nadie cuando otro termine/);
    expect(byId('attempt-race-cost').textContent).toMatch(/no estima el coste ni el uso de cada candidato/);
    expect(impl).toMatch(/No se puede elegir host ni worktree compartido por candidato/);
    expect(core.calls.length).toBeGreaterThan(reads);
    expect(sent(core.calls)).toEqual([]);
  });

  it('configura de 2 a 4 candidatos con proveedores mixtos y manda exactamente eso, con una clave de idempotencia', async () => {
    const core = mountCore();
    mount();
    await flush();
    await openForm();
    fireEvent.change(byId('attempt-race-provider-1'), { target: { value: 'otro' } });
    fireEvent.change(byId('attempt-race-model-1'), { target: { value: ' gpt-x ' } });
    fireEvent.click(byId('attempt-race-add'));
    fireEvent.change(byId('attempt-race-title-2'), { target: { value: 'El tercero' } });
    expect(screen.getAllByTestId(/^attempt-race-candidate-/)).toHaveLength(3);
    expect(byId('attempt-race-submit').textContent).toBe('Lanzar 3 candidatos');
    fireEvent.click(byId('attempt-race-add'));
    expect(screen.queryByTestId('attempt-race-add'), 'como mucho cuatro').toBeNull();
    fireEvent.click(byId('attempt-race-remove-3'));
    fireEvent.click(byId('attempt-race-submit'));
    await flush();
    const [call] = sent(core.calls);
    expect(call.cmd).toBe('task_race');
    expect(call.source_attempt_id).toBe('t3-a1');
    expect(call.request_id).toMatch(/\S/);
    expect(call.candidates).toEqual([{ provider: 'fake-completo' }, { provider: 'otro', model: 'gpt-x' }, { provider: 'fake-completo', title: 'El tercero' }]);
    expect(Object.keys(call).sort()).toEqual(['candidates', 'cmd', 'request_id', 'source_attempt_id']);
  });

  it('no deja bajar de dos candidatos y solo ofrece los proveedores que el Core dice que pueden arrancar', async () => {
    mountCore({ caps: liveWith([provider('fake-completo'), provider('sin-start', { start: 'unsupported' }), provider('otro')]) });
    mount();
    await flush();
    await openForm();
    expect([...byId('attempt-race-provider-0').querySelectorAll('option')].map((o) => o.value)).toEqual(['fake-completo', 'otro']);
    expect(screen.queryByTestId('attempt-race-remove-0')).toBeNull();
    expect(screen.queryByTestId('attempt-race-remove-1')).toBeNull();
  });

  it('crear el Race muestra cada candidato como el intento real que es, sin mover el foco ni abrir nada', async () => {
    const core = mountCore();
    mount();
    await flush();
    await openForm();
    fireEvent.click(byId('attempt-race-submit'));
    await flush();
    expect(byId('race-result').getAttribute('data-race-id')).toBe(RACE_ID);
    expect(screen.queryByTestId('attempt-race-form')).toBeNull();
    expect(byId('race-candidate-0').textContent).toMatch(/Candidato 1 · fake-completo.*Pendiente de aprobación.*t10-a1/);
    expect(byId('race-candidate-1').textContent).toMatch(/Candidato 2 · otro.*Pendiente de aprobación.*t11-a1/);
    expect(byId('race-context').textContent).toMatch(/solo el encargo de la tarea/);
    expect(open).not.toHaveBeenCalled();
    expect(document.activeElement === document.body || !byId('race-result').contains(document.activeElement)).toBe(true);
    expect(byId('race-summary').textContent).toMatch(/2 lanzados · 2 sin terminar · 0 terminados · 0 fallidos.*El Core no elige ganador/);
    // Abrir un intento es una elección explícita.
    fireEvent.click(byId('race-open-1'));
    expect(open).toHaveBeenCalledWith({ taskId: 't11', attemptId: 't11-a1' });
    expect(sent(core.calls)).toHaveLength(1);
  });

  it('un fallo parcial sigue mostrando los intentos creados y el que falló, con su motivo, y deja reintentar', async () => {
    const partial = () => race([{ outcome: 'launched' }, { outcome: 'failed', provider: 'nope', code: 'race_concurrency_limit' }, { outcome: 'launched', provider: 'otro' }]);
    const core = mountCore({ decide: () => ({ ...partial(), status: 'Requested', replayed: 0 }), current: partial });
    mount();
    await flush();
    await openForm();
    fireEvent.click(byId('attempt-race-add'));
    fireEvent.click(byId('attempt-race-submit'));
    await flush();
    expect(byId('race-partial').getAttribute('role')).toBe('alert');
    expect(byId('race-partial').textContent).toMatch(/Un candidato no se pudo lanzar\. Los demás siguen adelante y se pueden comparar/);
    expect(byId('race-candidate-1').getAttribute('data-outcome')).toBe('failed');
    expect(byId('race-status-1').textContent).toMatch(/No se pudo lanzar: Hay demasiadas tareas sin terminar/);
    expect(byId('race-candidate-0').getAttribute('data-outcome')).toBe('launched');
    expect(byId('race-candidate-2').getAttribute('data-outcome')).toBe('launched');
    expect(screen.queryByTestId('race-open-1'), 'un candidato fallido no tiene intento que abrir').toBeNull();
    const first = sent(core.calls)[0];
    // Reintentar manda LA MISMA petición (misma clave): el Core no duplica a los creados.
    fireEvent.click(byId('race-retry'));
    await flush();
    const second = sent(core.calls)[1];
    expect(second).toEqual(first);
  });

  it('si el Core rechaza el Race lo dice en llano (policy, límite) y el formulario se queda con lo escrito', async () => {
    mountCore({ decide: () => { throw new Error('policy_denied: la policy niega «fork» para desktop_person'); } });
    mount();
    await flush();
    await openForm();
    fireEvent.change(byId('attempt-race-model-0'), { target: { value: 'm' } });
    fireEvent.click(byId('attempt-race-submit'));
    await flush();
    expect(byId('attempt-race-form-error').textContent).toContain('La policy niega esta acción.');
    expect(byId('attempt-race-form-error').textContent).toContain('policy_denied');
    expect(byId('attempt-race-model-0').value).toBe('m');
    expect(screen.queryByTestId('race-result')).toBeNull();
  });
});

describe('Race · Compare y cancelar', () => {
  it('«Abrir Compare» pasa exactamente los intentos lanzados y no se abre solo', async () => {
    const core = mountCore();
    mount();
    await flush();
    await openForm();
    fireEvent.click(byId('attempt-race-submit'));
    await flush();
    expect(core.calls.some((c) => c.payload?.query === 'attempt_compare')).toBe(false);
    fireEvent.click(byId('race-compare'));
    await flush();
    const compare = core.calls.find((c) => c.payload?.query === 'attempt_compare');
    expect(compare.payload.args.attempt_ids).toEqual(['t10-a1', 't11-a1']);
  });

  it('con menos de dos lanzados Compare espera y lo dice', async () => {
    const one = () => race([{ outcome: 'launched' }, { outcome: 'failed' }]);
    mountCore({ decide: () => ({ ...one(), status: 'Requested', replayed: 0 }), current: one });
    mount();
    await flush();
    await openForm();
    fireEvent.click(byId('attempt-race-submit'));
    await flush();
    expect(screen.queryByTestId('race-compare')).toBeNull();
    expect(byId('race-compare-wait').textContent).toMatch(/al menos dos candidatos lanzados/);
  });

  it('cancelar es explícito y pide confirmación: un candidato, o todos los que quedan; nada se cancela solo', async () => {
    const after = race([{ outcome: 'launched' }, { outcome: 'launched', provider: 'otro', status: 'stopped' }]);
    const core = mountCore({ cancel: () => ({ status: 'Cancelled', race_id: RACE_ID, results: [{ attempt_id: 't11-a1', outcome: 'rejected' }], race: after }) });
    mount();
    await flush();
    await openForm();
    fireEvent.click(byId('attempt-race-submit'));
    await flush();
    expect(sent(core.calls).map((c) => c.cmd)).toEqual(['task_race']);
    fireEvent.click(byId('race-cancel-1'));
    expect(sent(core.calls)).toHaveLength(1); // pedir confirmación no cancela
    fireEvent.click(byId('race-cancel-yes-1'));
    await flush();
    expect(sent(core.calls)[1]).toEqual({ cmd: 'task_race_cancel', race_id: RACE_ID, attempt_id: 't11-a1' });
    expect(byId('race-cancel-note').textContent).toBe('Candidato cancelado.');
    expect(byId('race-candidate-1').getAttribute('data-status')).toBe('stopped');
    expect(screen.queryByTestId('race-cancel-1'), 'ya terminó: no se vuelve a ofrecer').toBeNull();
    // El otro sigue en marcha: se cancela lo que queda, también con confirmación.
    fireEvent.click(byId('race-cancel-all'));
    fireEvent.click(byId('race-cancel-all-yes'));
    await flush();
    expect(sent(core.calls)[2]).toEqual({ cmd: 'task_race_cancel', race_id: RACE_ID });
  });

  it('si un candidato no se pudo detener lo dice y no lo da por cancelado', async () => {
    const core = mountCore({ cancel: () => ({ status: 'Cancelled', race_id: RACE_ID, results: [{ attempt_id: 't10-a1', outcome: 'failed', error: 'No se pudo detener t10' }], race: TWO() }) });
    mount();
    await flush();
    await openForm();
    fireEvent.click(byId('attempt-race-submit'));
    await flush();
    fireEvent.click(byId('race-cancel-all'));
    fireEvent.click(byId('race-cancel-all-yes'));
    await flush();
    expect(byId('race-cancel-note').textContent).toMatch(/No se pudo detener un candidato: siguen en marcha/);
    expect(byId('race-candidate-0').getAttribute('data-status')).toBe('pending_approval');
    expect(sent(core.calls)).toHaveLength(2);
  });

  it('los Races que ya salieron de este intento se pueden volver a abrir tras recargar', async () => {
    mountCore({ past: [{ race_id: RACE_ID, requested: 2, created_at: 1 }] });
    mount();
    await flush();
    await openForm();
    expect(byId('attempt-race-past').textContent).toMatch(/Ya hay un Race de este intento/);
    fireEvent.click(byId(`attempt-race-past-${RACE_ID}`));
    await flush();
    expect(byId('race-result').getAttribute('data-race-id')).toBe(RACE_ID);
    expect(byId('race-candidate-0').textContent).toMatch(/Candidato 1/);
  });

  it('teclado y lectores de pantalla: cada candidato es un fieldset con su leyenda, el estado del Race un grupo con nombre y la lista un ol', async () => {
    mountCore();
    mount();
    await flush();
    await openForm();
    expect(screen.getByRole('group', { name: 'Candidato 1' })).toBeTruthy();
    fireEvent.click(byId('attempt-race-submit'));
    await flush();
    const result = screen.getByRole('group', { name: 'Estado del Race' });
    expect(within(result).getByRole('list', { name: 'Candidatos' }).tagName).toBe('OL');
    expect(within(result).getAllByRole('listitem')).toHaveLength(2);
  });
});
