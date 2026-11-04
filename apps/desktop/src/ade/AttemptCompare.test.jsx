import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AttemptCompare } from './AttemptCompare';
import { AttemptDetail } from './AttemptDetail';
import { AttemptHistory } from './AttemptHistory';
import { validateAttemptCompare } from './compareContract';
import { resetOutstandingQueries } from './coreQueryPolicy';
import { coreModelFromState } from './useCoreModel';
import { CANONICAL, attemptDetail, attemptsPage, brief } from './testFixtures/coreModelFixtures';
import { attemptActivityPage } from './testFixtures/attemptActivityFixtures';
import { live } from './testFixtures/providerCapabilitiesFixtures';

// LXO-154 · Comparar intentos: la evidencia del Core con la procedencia de cada dato, sin recalcular nada ni mutar.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const V1 = coreModelFromState({ data: CANONICAL['core_model.v1.json'], error: null });
const tick = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
const flush = async () => { for (let i = 0; i < 4; i += 1) await tick(); };
afterEach(() => { cleanup(); invoke.mockReset(); resetOutstandingQueries(); });

const verified = (value) => ({ value, provenance: 'verified' });
const reported = (value) => ({ value, provenance: 'agent_reported' });
const unknown = (reason) => ({ value: null, provenance: 'unknown', reason });

/** Un intento comparado, con la forma que manda el Core. */
function entry(id, over = {}) {
  const [task, n] = [id.split('-a')[0], Number(id.split('-a')[1])];
  return {
    attempt_id: id, task_id: task, n, project_id: 'p1', is_current: true, forked_from: null,
    selection: verified({ provider: 'claude', model: 'opus', effort: null, role: null, profile: 'explorar', external: false }),
    status: verified({ status: 'done', failure_reason: null }),
    timing: verified({ created_at: 1_000, started_at: 2_000, ended_at: 64_000, duration_ms: 62_000 }),
    host: verified('equipo-1'),
    worktree: verified({ id: 'w1', branch: `lx/r/${id}`, base_branch: 'main', state: 'active' }),
    revision: { source: 'live_branch', base_commit: verified('a'.repeat(40)), head_commit: verified('b'.repeat(40)) },
    changes: {
      files: verified(2), additions: verified(5), deletions: verified(1), total_files: 2, truncated: false,
      list: [{ path: 'README.md', additions: 3, deletions: 1 }, { path: 'src/a.rs', additions: 2, deletions: 0 }],
    },
    summary: reported('Arreglé el login'),
    artifacts: { provenance: 'unknown', reason: 'none_recorded', items: [] },
    tests: unknown('not_collected'),
    review: unknown('not_reviewed'),
    ...over,
  };
}
const compareResponse = (ids, over = {}, entries = {}) => ({
  v: 1,
  relation: { kind: 'fork_family', root: ids[0] },
  attempts: ids.map((id) => entry(id, entries[id] ?? {})),
  overlaps: { complete: true, total: 1, items: [{ path: 'README.md', attempt_ids: ids.slice(0, 2) }] },
  limits: { max_attempts: 4, max_files_per_attempt: 200, max_overlaps: 100 },
  ...over,
});

function mountCompare(response, { fail = null } = {}) {
  const calls = [];
  invoke.mockImplementation(async (command, payload) => {
    calls.push({ command, payload });
    if (payload?.query === 'attempt_compare') {
      if (fail) throw new Error(fail);
      return typeof response === 'function' ? response(payload.args) : response;
    }
    throw new Error(`consulta inesperada: ${payload?.query ?? command}`);
  });
  return calls;
}
const IDS = ['t1-a1', 't2-a1', 't3-a1'];

describe('Comparar intentos · contrato', () => {
  const args = { attempt_ids: ['t1-a1', 't2-a1'] };
  const ok = () => compareResponse(args.attempt_ids);
  const bad = (response, what) => expect(() => validateAttemptCompare(response, args), what).toThrow(/ade_query_invalid_response: attempt_compare/);

  it('acepta una respuesta del Core y rechaza lo que no cumple el contrato', () => {
    expect(validateAttemptCompare(ok(), args)).toBeTruthy();
    bad(null, 'no objeto');
    bad({ ...ok(), v: 2 }, 'versión');
    bad({ ...ok(), relation: { kind: 'otra', root: 'x' } }, 'relación');
    bad({ ...ok(), attempts: [entry('t1-a1')] }, 'un solo intento');
    bad({ ...ok(), attempts: [entry('t2-a1'), entry('t1-a1')] }, 'otro orden que el pedido');
    bad(compareResponse(args.attempt_ids, {}, { 't1-a1': { summary: { value: 'x', provenance: 'inventada' } } }), 'procedencia desconocida');
    bad(compareResponse(args.attempt_ids, {}, { 't1-a1': { tests: { value: 0, provenance: 'unknown', reason: 'not_collected' } } }), 'un cero no es unknown');
    bad(compareResponse(args.attempt_ids, {}, { 't1-a1': { tests: { value: null, provenance: 'unknown' } } }), 'unknown sin motivo');
    bad(compareResponse(args.attempt_ids, {}, { 't1-a1': { summary: { value: 'x', provenance: 'verified', reason: 'x' } } }), 'un dato con valor no lleva motivo');
    bad(compareResponse(args.attempt_ids, {}, { 't1-a1': { artifacts: { provenance: 'unknown', reason: 'none_recorded', items: [{ id: 'x' }] } } }), 'artefactos sin procedencia');
    bad(compareResponse(args.attempt_ids, {}, { 't1-a1': { changes: { ...entry('t1-a1').changes, files: unknown('no_worktree') } } }), 'archivos sin saber cuántos');
    bad({ ...ok(), overlaps: { complete: true, total: 1, items: [{ path: 'a', attempt_ids: ['t1-a1'] }] } }, 'un solape son dos intentos');
  });
});

describe('Comparar intentos · vista', () => {
  it('es una tabla accesible: pie, columnas por intento, filas con su nombre y región con foco para el teclado', async () => {
    mountCompare(compareResponse(IDS.slice(0, 2)));
    render(<AttemptCompare attemptIds={IDS.slice(0, 2)} />);
    await flush();
    const table = screen.getByTestId('cmp-table');
    expect(within(table).getByText(/Comparación de 2 intentos, uno por columna/)).toBeTruthy();
    const heads = within(table).getAllByRole('columnheader');
    expect(heads.map((h) => h.getAttribute('scope'))).toEqual(['col', 'col', 'col']);
    expect(heads.slice(1).map((h) => h.dataset.attempt)).toEqual(['t1-a1', 't2-a1']);
    expect(within(table).getAllByRole('rowheader').map((h) => h.textContent)).toEqual(
      ['Estado', 'Proveedor, modelo y esfuerzo', 'Host', 'Duración', 'Commit base → resultado', 'Archivos cambiados', 'Resumen', 'Pruebas', 'Revisión de la persona', 'Artefactos'],
    );
    const region = screen.getByRole('region', { name: 'Tabla de comparación' });
    expect(region.getAttribute('tabindex')).toBe('0');
  });

  it('con tres intentos hay una columna por intento y la tabla reserva ancho para cada una', async () => {
    mountCompare(compareResponse(IDS));
    render(<AttemptCompare attemptIds={IDS} />);
    await flush();
    const table = screen.getByTestId('cmp-table');
    expect(within(table).getAllByRole('columnheader')).toHaveLength(4);
    expect(table.style.getPropertyValue('--cmp-cols')).toBe('3');
    expect(screen.getByRole('heading', { name: 'Comparar 3 intentos' })).toBeTruthy();
  });

  it('verificado, del agente y sin dato nunca comparten tratamiento: texto, glifo y clase propios', async () => {
    mountCompare(compareResponse(IDS.slice(0, 2)));
    render(<AttemptCompare attemptIds={IDS.slice(0, 2)} />);
    await flush();
    const cellOf = (row, i = 0) => within(screen.getByTestId('cmp-table').querySelector(`tr[data-row="${row}"]`)).getAllByRole('cell')[i];
    const marks = {
      verified: within(cellOf('status')).getByTestId('cmp-prov'),
      agent_reported: within(cellOf('summary')).getByTestId('cmp-prov'),
      unknown: within(cellOf('tests')).getByTestId('cmp-prov'),
    };
    expect(marks.verified.textContent).toContain('✓ Verificado por el Core');
    expect(marks.agent_reported.textContent).toContain('⚠ Lo dice el agente');
    expect(marks.unknown.textContent).toContain('? Sin dato');
    const classes = Object.values(marks).map((m) => m.className);
    expect(new Set(classes).size).toBe(3);
    expect(marks.agent_reported.className).toContain('cmp-prov--agent_reported');
    // El resumen del agente se ve como suyo, junto a su texto.
    expect(cellOf('summary').textContent).toContain('Arreglé el login');
    expect(cellOf('summary').dataset.provenance).toBe('agent_reported');
  });

  it('lo que falta se dice con su motivo y NUNCA se pinta como cero ni como fallo', async () => {
    const pendiente = {
      host: unknown('no_worktree'), worktree: unknown('no_worktree'),
      revision: { source: null, base_commit: unknown('no_worktree'), head_commit: unknown('no_worktree') },
      changes: { files: unknown('no_worktree'), additions: unknown('no_worktree'), deletions: unknown('no_worktree'), list: [], truncated: false, total_files: null },
      summary: unknown('no_summary'),
      status: verified({ status: 'pending_approval', failure_reason: null }),
    };
    mountCompare(compareResponse(IDS.slice(0, 2), {}, { 't2-a1': pendiente }));
    render(<AttemptCompare attemptIds={IDS.slice(0, 2)} />);
    await flush();
    const row = (id) => screen.getByTestId('cmp-table').querySelector(`tr[data-row="${id}"]`);
    const cell = within(row('changes')).getAllByRole('cell')[1];
    expect(cell.dataset.provenance).toBe('unknown');
    expect(cell.textContent).toContain('? Sin dato — aún no tiene worktree');
    expect(cell.querySelector('.cmp-value')).toBeNull();
    expect(cell.textContent).not.toMatch(/\b0 archivos|\+0 −0/);
    expect(within(row('host')).getAllByRole('cell')[1].textContent).toContain('aún no tiene worktree');
    expect(within(row('summary')).getAllByRole('cell')[1].textContent).toContain('el agente no dejó resumen');
    expect(within(row('tests')).getAllByRole('cell')[0].textContent).toContain('el Core aún no recoge resultados de pruebas');
    expect(within(row('artifacts')).getAllByRole('cell')[0].textContent).toContain('no hay artefactos registrados');
    // El que sí tiene datos conserva los suyos.
    expect(within(row('changes')).getAllByRole('cell')[0].textContent).toContain('2 archivos +5 −1');
  });

  it('un cero calculado por el Core sigue siendo un dato verificado', async () => {
    const sinCambios = { changes: { files: verified(0), additions: verified(0), deletions: verified(0), list: [], truncated: false, total_files: 0 } };
    mountCompare(compareResponse(IDS.slice(0, 2), {}, { 't2-a1': sinCambios }));
    render(<AttemptCompare attemptIds={IDS.slice(0, 2)} />);
    await flush();
    const cell = within(screen.getByTestId('cmp-table').querySelector('tr[data-row="changes"]')).getAllByRole('cell')[1];
    expect(cell.dataset.provenance).toBe('verified');
    expect(cell.textContent).toContain('0 archivos');
  });

  it('un diff grande trae el total y avisa del recorte; sin sumas fiables no las inventa', async () => {
    const grande = {
      changes: {
        files: verified(205), additions: unknown('truncated'), deletions: unknown('truncated'), total_files: 205, truncated: true,
        list: Array.from({ length: 200 }, (_, i) => ({ path: `f${String(i).padStart(3, '0')}.txt`, additions: 1, deletions: 0 })),
      },
    };
    mountCompare(compareResponse(IDS.slice(0, 2), {}, { 't1-a1': grande }));
    render(<AttemptCompare attemptIds={IDS.slice(0, 2)} />);
    await flush();
    const cell = within(screen.getByTestId('cmp-table').querySelector('tr[data-row="changes"]')).getAllByRole('cell')[0];
    expect(cell.textContent).toContain('205 archivos');
    expect(cell.textContent).not.toMatch(/\+\d+ −\d+ *Ver archivos/);
    expect(cell.textContent).toContain('Se muestran 200 de 205 archivos.');
    expect(cell.querySelectorAll('li')).toHaveLength(200);
  });

  it('los solapes se listan, y si la lista no está completa lo dice', async () => {
    mountCompare(compareResponse(IDS.slice(0, 2), { overlaps: { complete: false, total: 1, items: [{ path: 'README.md', attempt_ids: ['t1-a1', 't2-a1'] }] } }));
    render(<AttemptCompare attemptIds={IDS.slice(0, 2)} />);
    await flush();
    const overlaps = screen.getByTestId('cmp-overlaps');
    expect(overlaps.textContent).toContain('README.md');
    expect(overlaps.textContent).toContain('Puede haber más');
  });

  it('abrir un intento desde la comparación lleva a su detalle y comparar es solo lectura', async () => {
    const calls = mountCompare(compareResponse(IDS.slice(0, 2)));
    const onOpenAttempt = vi.fn();
    render(<AttemptCompare attemptIds={IDS.slice(0, 2)} onOpenAttempt={onOpenAttempt} />);
    await flush();
    fireEvent.click(screen.getByTestId('cmp-open-t2-a1'));
    expect(onOpenAttempt).toHaveBeenCalledWith({ taskId: 't2', attemptId: 't2-a1' });
    expect(screen.getByTestId('cmp-relation').textContent).toMatch(/no cambia nada ni elige un ganador/);
    expect(calls.filter((c) => c.command === 'orch_call')).toEqual([]);
    expect(calls.every((c) => c.payload.query === 'attempt_compare')).toBe(true);
    expect(calls[0].payload.args).toEqual({ attempt_ids: ['t1-a1', 't2-a1'] });
  });

  it('un error del Core (no comparables) se muestra con su detalle técnico y deja reintentar', async () => {
    mountCompare(null, { fail: 'compare_not_comparable: solo se comparan Attempts de la misma Task o de la misma familia de Forks' });
    render(<AttemptCompare attemptIds={IDS.slice(0, 2)} />);
    await flush();
    expect(screen.queryByTestId('cmp-table')).toBeNull();
    expect(screen.getByText(/compare_not_comparable/)).toBeTruthy();
  });
});

describe('Comparar intentos · cómo se llega', () => {
  const history = (n) => attemptsPage('t3', Array.from({ length: n }, (_, i) => brief('t3', i + 1, 'done')));

  function mountHistory(count) {
    const calls = [];
    invoke.mockImplementation(async (command, payload) => {
      calls.push({ command, payload });
      if (payload.query === 'attempt_compare') return compareResponse(payload.args.attempt_ids.map((id) => id));
      if (payload.query === 'activity_list') return attemptActivityPage([]);
      return history(count);
    });
    return calls;
  }

  it('en el historial se eligen de 2 a 4 intentos y Comparar los pide al Core en el orden elegido', async () => {
    const calls = mountHistory(5);
    render(<AttemptHistory taskId="t3" coreModel={V1} />);
    await flush();
    const button = screen.getByTestId('attempt-compare-open');
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('pick-t3-a3'));
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('pick-t3-a1'));
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Comparar (2)');
    // Cuatro es el máximo: con cuatro elegidos, el quinto no se puede marcar.
    fireEvent.click(screen.getByTestId('pick-t3-a2'));
    fireEvent.click(screen.getByTestId('pick-t3-a4'));
    expect(screen.getByTestId('pick-t3-a5').disabled).toBe(true);
    expect(calls.filter((c) => c.payload?.query === 'attempt_compare')).toHaveLength(0);
    fireEvent.click(button);
    await flush();
    expect(calls.find((c) => c.payload?.query === 'attempt_compare').payload.args).toEqual({ attempt_ids: ['t3-a3', 't3-a1', 't3-a2', 't3-a4'] });
    expect(screen.getByTestId('attempt-compare')).toBeTruthy();
  });

  it('con un solo intento no hay nada que comparar y no se ofrece', async () => {
    mountHistory(1);
    render(<AttemptHistory taskId="t3" coreModel={V1} />);
    await flush();
    expect(screen.queryByTestId('attempt-compare-open')).toBeNull();
    expect(screen.queryByTestId('pick-t3-a1')).toBeNull();
  });

  it('un Fork se compara con su origen desde su procedencia, y el origen con sus bifurcaciones', async () => {
    const calls = [];
    const lineage = { v: 1, attempt_id: 't3-a1', forked_from: { attempt_id: 't2-a1', task_id: 't2', n: 1, strategy: 'clean', package_id: null, overrides: [] }, forks: [] };
    invoke.mockImplementation(async (command, payload) => {
      calls.push({ command, payload });
      if (payload.query === 'attempt_lineage') return lineage;
      if (payload.query === 'attempt_compare') return compareResponse(payload.args.attempt_ids);
      if (payload.query === 'provider_capabilities') return live();
      if (payload.query === 'activity_list') return attemptActivityPage([]);
      if (payload.query === 'attempts_by_task') return { ...CANONICAL['attempts_by_task.v1.json'], task_id: 't3', items: [] };
      if (payload.query === 'pending_queue') return { v: 1, attempt_id: 't3-a1', task_id: 't3', items: [], finished: [], finished_limit: 20 };
      return attemptDetail({ id: 't3-a1', task_id: 't3', n: 1, status: 'done', provider: 'fake-completo' });
    });
    render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
    await flush();
    fireEvent.click(screen.getByTestId('attempt-lineage-compare'));
    await flush();
    expect(screen.getByTestId('attempt-lineage-compare').textContent).toBe('Comparar con el origen');
    expect(calls.find((c) => c.payload?.query === 'attempt_compare').payload.args).toEqual({ attempt_ids: ['t2-a1', 't3-a1'] });
    expect(screen.getByTestId('attempt-compare')).toBeTruthy();
  });
});
