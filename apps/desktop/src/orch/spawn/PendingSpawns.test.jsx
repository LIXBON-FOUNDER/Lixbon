import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { PendingSpawnsPanel, countdown } from './PendingSpawns';
import { integrateIntoLabel, toMs, resolvedReason } from './spawnContract';
import { approveSpawn, rejectSpawn, SPAWN_COMMANDS } from './spawnContract';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const inMin = (m) => Date.now() + m * 60000; // ms epoch, como el host
const pending = (id, policy = {}, extra = {}) => ({
  pending_id: id, parent_task: 'coord', agent: 'claude', provider: 'claude', profile: 'explorar', role: 'explorador',
  expires_at: inMin(5), policy: { argv: ['claude', '--permission-mode', 'plan', 'con espacio'], status: 'ok', warnings: [], cli_version: '2.0.0', ...policy }, ...extra,
});

function makeApi(initial = [], over = {}) {
  const h = {};
  const api = {
    list: vi.fn(async () => initial),
    approve: vi.fn(async (a) => ({ pending_id: a.pending_id, outcome: 'approved', task: 't9' })),
    reject: vi.fn(async (a) => ({ pending_id: a.pending_id, outcome: 'rejected' })),
    subscribe: vi.fn((cbs) => { Object.assign(h, cbs); return () => {}; }),
    ...over,
  };
  return { api, h };
}
const approveBtn = () => screen.getByRole('button', { name: /^(Aprobar lanzamiento|Enviando…)$/ });
const open = async (id) => fireEvent.click(await screen.findByTestId(`spawn-${id}`));

describe('PendingSpawnsPanel', () => {
  it('lista los pendientes al montar con agente, rol, padre y cuenta regresiva', async () => {
    const { api } = makeApi([pending('p1')]);
    render(<PendingSpawnsPanel api={api} tasks={{ coord: { title: 'Coordinador X' } }} />);
    const row = await screen.findByTestId('spawn-p1');
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(row.textContent).toContain('Explorador · Claude Code');
    expect(row.textContent).toContain('Coordinador X');
    expect(screen.getByTestId('spawn-countdown-p1').textContent).toMatch(/^vence en \d:\d\d$/);
  });

  it('el evento orch-spawn-pending agrega un pendiente sin duplicar', async () => {
    const { api, h } = makeApi([]);
    render(<PendingSpawnsPanel api={api} />);
    await waitFor(() => expect(h.onPending).toBeTypeOf('function'));
    act(() => { h.onPending(pending('p2')); h.onPending(pending('p2')); });
    expect(screen.getAllByTestId('spawn-p2')).toHaveLength(1);
  });

  it('aprobar envía el argv exacto que se ve y ack_unverified=false si está ok, sin re-resolver', async () => {
    const { api } = makeApi([pending('p1')]);
    render(<PendingSpawnsPanel api={api} />);
    await open('p1');
    expect(screen.getByTestId('policy-argv').textContent).toBe('claude --permission-mode plan "con espacio"');
    expect(screen.queryByText('Proveedor', { selector: 'legend' })).toBeNull();
    fireEvent.click(approveBtn());
    await screen.findByText('Lanzamiento aprobado.');
    expect(api.approve).toHaveBeenCalledWith({ pending_id: 'p1', argv: ['claude', '--permission-mode', 'plan', 'con espacio'], ack_unverified: false });
    expect(screen.queryByTestId('spawn-p1')).toBeNull();
  });

  it('unverified: solo se aprueba tras marcar la casilla y lleva ack_unverified=true', async () => {
    const { api } = makeApi([pending('p1', { status: 'unverified', reason: 'versión nueva' })]);
    render(<PendingSpawnsPanel api={api} />);
    await open('p1');
    expect(approveBtn().disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Entiendo que esta versión no está verificada'));
    fireEvent.click(approveBtn());
    await waitFor(() => expect(api.approve).toHaveBeenCalledWith(expect.objectContaining({ ack_unverified: true })));
  });

  it('blocked: no se puede aprobar', async () => {
    const { api } = makeApi([pending('p1', { status: 'blocked', reason: 'perfil no permitido' })]);
    render(<PendingSpawnsPanel api={api} />);
    await open('p1');
    expect(approveBtn().disabled).toBe(true);
    fireEvent.click(approveBtn());
    expect(api.approve).not.toHaveBeenCalled();
  });

  it('rechazar envía el motivo opcional y quita el pendiente', async () => {
    const { api } = makeApi([pending('p1')]);
    render(<PendingSpawnsPanel api={api} />);
    await open('p1');
    fireEvent.change(screen.getByLabelText('Motivo del rechazo (opcional)'), { target: { value: 'otro perfil' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rechazar' }));
    await screen.findByText(/Lanzamiento rechazado/);
    expect(api.reject).toHaveBeenCalledWith({ pending_id: 'p1', reason: 'otro perfil' });
    expect(screen.queryByTestId('spawn-p1')).toBeNull();
  });

  it('doble clic: aprueba una sola vez y deshabilita los botones mientras espera', async () => {
    let resolve;
    const { api } = makeApi([pending('p1')], { approve: vi.fn(() => new Promise((r) => { resolve = r; })) });
    render(<PendingSpawnsPanel api={api} />);
    await open('p1');
    fireEvent.click(approveBtn());
    fireEvent.click(approveBtn());
    expect(api.approve).toHaveBeenCalledTimes(1);
    expect(approveBtn().disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Rechazar' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Rechazar' }));
    expect(api.reject).not.toHaveBeenCalled();
    await act(async () => { resolve({ pending_id: 'p1', outcome: 'approved' }); });
  });

  it('expired y already_resolved muestran su aviso y quitan el pendiente', async () => {
    const { api } = makeApi([pending('p1'), pending('p2')], {
      approve: vi.fn(async (a) => ({ pending_id: a.pending_id, outcome: a.pending_id === 'p1' ? 'expired' : 'already_resolved' })),
    });
    render(<PendingSpawnsPanel api={api} />);
    await open('p1');
    fireEvent.click(approveBtn());
    expect((await screen.findByTestId('spawn-notice')).textContent).toContain('ya venció');
    expect(screen.queryByTestId('spawn-p1')).toBeNull();
    await open('p2');
    fireEvent.click(approveBtn());
    await waitFor(() => expect(screen.getByTestId('spawn-notice').textContent).toContain('ya estaba decidido'));
  });

  it('un error de uso del host se muestra tal cual y el pendiente sigue', async () => {
    const { api } = makeApi([pending('p1')], { approve: vi.fn(async () => { throw 'argv distinto del confirmado'; }) });
    render(<PendingSpawnsPanel api={api} />);
    await open('p1');
    fireEvent.click(approveBtn());
    expect((await screen.findByTestId('spawn-error')).textContent).toContain('argv distinto del confirmado');
    expect(screen.getByTestId('spawn-error').textContent).toContain('sigue pendiente');
    expect(screen.getByTestId('spawn-p1')).toBeTruthy();
    expect(approveBtn().disabled).toBe(false); // se puede volver a intentar a mano
  });

  it('muestra integrate_into del pendiente si el host lo manda', async () => {
    const { api } = makeApi([pending('p1', {}, { integrate_into: { dir: 'C:/repo/coord', branch: 'master' } }), pending('p2')]);
    render(<PendingSpawnsPanel api={api} />);
    await open('p1');
    expect(screen.getByTestId('spawn-integrate-into').textContent).toContain('master');
    await open('p2');
    expect(screen.queryByTestId('spawn-integrate-into')).toBeNull();
  });

  it('el evento orch-spawn-resolved quita el pendiente', async () => {
    const { api, h } = makeApi([pending('p1')]);
    render(<PendingSpawnsPanel api={api} />);
    await screen.findByTestId('spawn-p1');
    act(() => h.onResolved({ pending_id: 'p1', outcome: 'expired' }));
    expect(screen.queryByTestId('spawn-p1')).toBeNull();
  });
});

describe('casos del host b2aa870', () => {
  it('launch_failed: muestra el error, distinto de un rechazo, quita el pendiente y no reintenta', async () => {
    const { api } = makeApi([pending('p1')], {
      approve: vi.fn(async (a) => ({ pending_id: a.pending_id, outcome: 'launch_failed', reason: 'Aprobado, pero no se pudo lanzar: worktree ocupado', decision: null })),
    });
    render(<PendingSpawnsPanel api={api} />);
    await open('p1');
    fireEvent.click(approveBtn());
    const n = await screen.findByTestId('spawn-notice');
    expect(n.className).toContain('spawns__notice--failed');
    expect(n.textContent).toContain('no pudo lanzar');
    expect(n.textContent).toContain('worktree ocupado');
    expect(n.textContent).not.toContain('rechazado');
    expect(screen.queryByTestId('spawn-p1')).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(api.approve).toHaveBeenCalledTimes(1);
  });

  it('launch_failed por evento (otra ventana) también avisa; lee launch_error de la decisión', async () => {
    const { api, h } = makeApi([pending('p1')]);
    render(<PendingSpawnsPanel api={api} />);
    await screen.findByTestId('spawn-p1');
    act(() => h.onResolved({ pending_id: 'p1', outcome: 'launch_failed', decision: { kind: 'spawn', detail: { outcome: 'approved', launch_error: 'sin codex' } } }));
    expect(screen.queryByTestId('spawn-p1')).toBeNull();
    expect(screen.getByTestId('spawn-notice').textContent).toContain('sin codex');
  });

  it('expired por evento (run borrado, sin decisión) quita el pendiente y lo explica', async () => {
    const { api, h } = makeApi([pending('p1')]);
    render(<PendingSpawnsPanel api={api} />);
    await open('p1');
    act(() => h.onResolved({ pending_id: 'p1', outcome: 'expired', decision: null }));
    expect(screen.queryByTestId('spawn-p1')).toBeNull();
    expect(screen.queryByLabelText('Detalle del lanzamiento pendiente')).toBeNull();
    expect(screen.getByTestId('spawn-notice').textContent).toContain('run borrado');
  });

  it('expired de un id que no está en la lista no muestra aviso', async () => {
    const { api, h } = makeApi([]);
    render(<PendingSpawnsPanel api={api} />);
    await waitFor(() => expect(h.onResolved).toBeTypeOf('function'));
    act(() => h.onResolved({ pending_id: 'otro', outcome: 'expired', decision: null }));
    expect(screen.queryByTestId('spawn-notice')).toBeNull();
  });

  it('rechazo con motivo del host lo muestra', async () => {
    const { api } = makeApi([pending('p1')], { reject: vi.fn(async (a) => ({ pending_id: a.pending_id, outcome: 'rejected', reason: 'Rechazado por la persona' })) });
    render(<PendingSpawnsPanel api={api} />);
    await open('p1');
    fireEvent.click(screen.getByRole('button', { name: 'Rechazar' }));
    expect((await screen.findByTestId('spawn-notice')).textContent).toContain('Motivo: Rechazado por la persona');
  });

  it('muestra cwd (worktree nuevo o carpeta compartida)', async () => {
    const { api } = makeApi([pending('p1', {}, { cwd: 'C:/wt/run-sp1-x', shared: false }), pending('p2', {}, { cwd: 'C:/coord', shared: true })]);
    render(<PendingSpawnsPanel api={api} />);
    await open('p1');
    expect(screen.getByTestId('spawn-cwd').textContent).toContain('worktree nuevo');
    expect(screen.getByTestId('spawn-cwd').textContent).toContain('C:/wt/run-sp1-x');
    await open('p2');
    expect(screen.getByTestId('spawn-cwd').textContent).toContain('carpeta del coordinador');
  });

  it('helpers del contrato', () => {
    expect(toMs(65000)).toBe(65000);
    expect(toMs('65000')).toBe(65000);
    expect(toMs(new Date(65000).toISOString())).toBe(65000);
    expect(integrateIntoLabel({ dir: 'C:/x', branch: 'main' })).toBe('main');
    expect(integrateIntoLabel({ dir: 'C:/x', branch: null })).toBe('C:/x');
    expect(integrateIntoLabel(null)).toBe(null);
    expect(resolvedReason({ reason: 'r' })).toBe('r');
    expect(resolvedReason({ decision: { detail: { launch_error: 'e' } } })).toBe('e');
  });
});

describe('spawnContract', () => {
  it('approveSpawn y rejectSpawn llaman a los comandos con confirm: true y snake_case', async () => {
    invoke.mockResolvedValue({ outcome: 'approved' });
    await approveSpawn({ pending_id: 'p1', argv: ['a', 'b'], ack_unverified: true });
    expect(invoke).toHaveBeenCalledWith(SPAWN_COMMANDS.approve, { pending_id: 'p1', confirm: true, argv: ['a', 'b'], ack_unverified: true });
    await rejectSpawn({ pending_id: 'p1', reason: '  ' });
    expect(invoke).toHaveBeenLastCalledWith(SPAWN_COMMANDS.reject, { pending_id: 'p1', confirm: true });
    await rejectSpawn({ pending_id: 'p1', reason: 'no' });
    expect(invoke).toHaveBeenLastCalledWith(SPAWN_COMMANDS.reject, { pending_id: 'p1', confirm: true, reason: 'no' });
  });

  it('countdown', () => {
    expect(countdown(new Date(65000).toISOString(), 0)).toBe('vence en 1:05');
    expect(countdown(new Date(0).toISOString(), 1000)).toBe('vencido');
    expect(countdown(65000, 0)).toBe('vence en 1:05'); // ms epoch del host
  });
});

describe('entorno del worktree en la aprobación', () => {
  it('antes de aprobar se ve qué se enlazará y qué se copiará', async () => {
    const { api } = makeApi([pending('pe', {}, { env: { shared: ['node_modules'], copy: ['.env'], skipped: [] } })]);
    render(<PendingSpawnsPanel api={api} tasks={{}} />);
    await open('pe');
    expect(screen.getByTestId('worktree-env-shared').textContent).toMatch(/Se enlazará.*node_modules/);
    expect(screen.getByTestId('worktree-env-copy').textContent).toMatch(/Se copiará.*\.env/);
  });

  it('sin reglas en el repo no aparece la sección', async () => {
    const { api } = makeApi([pending('pn', {}, { env: { shared: [], copy: [], skipped: [] } })]);
    render(<PendingSpawnsPanel api={api} tasks={{}} />);
    await open('pn');
    expect(screen.queryByTestId('worktree-env')).toBeNull();
  });
});
