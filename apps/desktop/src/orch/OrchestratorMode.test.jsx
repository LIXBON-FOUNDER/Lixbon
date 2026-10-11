import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { OrchestratorMode } from './OrchestratorMode';
import { useOrchStore } from '../store/orchStore';
import { useAppStore } from '../store/appStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock('./AgentTerminal', () => ({ AgentTerminal: () => <div data-testid="agent-terminal" /> }));
vi.mock('./review/TaskDiffView', () => ({ TaskDiffView: ({ taskId }) => <div data-testid={`review-${taskId}`} /> }));

const task = (id, over = {}) => ({
  id, run: 'r1', parent: 'coord', title: id, agent: 'claude', status: 'done', branch: `lxo/${id}`, head_commit: 'aaa',
  created: 1, updated: 2, depth: 1, repo: 'C:/repo', phases: [], last_review: null, last_integration: null, ...over,
});
const snapshot = (tasks, extra = {}) => ({
  settings: { enabled: true }, lxo_exists: true, live: [], messages: [],
  runs: { r1: { id: 'r1', root: 'coord', objective: 'Objetivo', created: 1, closed: false } },
  tasks: { coord: task('coord', { parent: null, branch: null, status: 'running' }), ...Object.fromEntries(tasks.map((t) => [t.id, t])) },
  ...extra,
});
const pendingSpawn = { pending_id: 'p1', parent_task: 'coord', agent: 'claude', provider: 'claude', profile: 'explorar', role: 'explorador', expires_at: Date.now() + 300000, policy: { argv: ['claude'], status: 'ok', warnings: [] } };

function mountWith(snap, pending = []) {
  invoke.mockImplementation(async (cmd) => (cmd === 'orch_pending_spawns' || cmd === 'orch_list_pending_spawns' ? pending : snap));
  useAppStore.setState({ workspaceRoot: 'C:/repo' });
  useOrchStore.setState({ snap, selected: null, init: () => {}, refresh: async () => {} });
  return render(<OrchestratorMode />);
}

beforeEach(() => invoke.mockReset());
afterEach(cleanup);

describe('OrchestratorMode', () => {
  it('lista lo que espera una decisión y abre la revisión al elegirlo', async () => {
    mountWith(snapshot([task('t1'), task('t2', { last_review: { decision: 'accepted', head_commit: 'aaa' } })]));
    expect(screen.getByLabelText('Requiere tu atención')).toBeTruthy();
    expect(screen.getByTestId('attention-t1').textContent).toContain('Revisar diff');
    expect(screen.getByTestId('attention-t2').textContent).toContain('Lista para integrar');
    fireEvent.click(screen.getByTestId('attention-t1'));
    await waitFor(() => expect(screen.getByTestId('review-t1')).toBeTruthy());
  });

  it('sin nada pendiente de decidir no muestra la sección', () => {
    mountWith(snapshot([task('t1', { status: 'running' })]));
    expect(screen.queryByLabelText('Requiere tu atención')).toBeNull();
  });

  it('una tarea esperando aprobación en la terminal aparece con su icono de espera', () => {
    mountWith(snapshot([task('t3', { status: 'awaiting_terminal_approval' })]));
    expect(screen.getByTestId('attention-t3').textContent).toContain('Aprobar en la terminal');
    expect(document.querySelector('.orchst--waiting svg circle')).not.toBeNull();
  });
});

describe('lanzamiento pendiente', () => {
  it('con nada elegido se enseña el pendiente en lugar de la ayuda', async () => {
    const api = await import('./spawn/spawnContract');
    vi.spyOn(api.defaultSpawnApi, 'list').mockResolvedValue([pendingSpawn]);
    mountWith(snapshot([]));
    await waitFor(() => expect(screen.getByLabelText('Detalle del lanzamiento pendiente')).toBeTruthy());
    expect(screen.queryByText('Cómo se orquesta')).toBeNull();
  });
});

describe('línea de estado de cada agente', () => {
  const phased = (over) => task('p1', { phases: [{ name: 'Probando', note: 'reproduje el fallo; probando el arreglo', done: false, at: 1 }], ...over });

  it('mientras trabaja muestra la nota de su última fase', () => {
    mountWith(snapshot([phased({ status: 'running' })]));
    expect(screen.getByTestId('task-note-p1').textContent).toBe('reproduje el fallo; probando el arreglo');
  });

  it('al terminar muestra la primera línea de su resumen', () => {
    mountWith(snapshot([phased({ status: 'done', summary: '\n  Arreglé el login\nmás detalle' })]));
    expect(screen.getByTestId('task-note-p1').textContent).toBe('Arreglé el login');
  });

  it('sin nota ni resumen no ocupa una línea', () => {
    mountWith(snapshot([task('p2', { status: 'running', phases: [{ name: 'Leyendo', note: '', done: false, at: 1 }] })]));
    expect(screen.queryByTestId('task-note-p2')).toBeNull();
  });
});

describe('entorno del worktree', () => {
  it('la actividad de la tarea cuenta qué se enlazó y qué se copió', () => {
    const env = { shared: ['node_modules'], copy: ['.env'], skipped: [{ path: 'build', reason: 'git no lo ignora' }] };
    mountWith(snapshot([task('e1', { env, status: 'running' })]));
    fireEvent.click(screen.getByText('e1', { selector: '.orch__task-title' }));
    fireEvent.click(screen.getByText('Actividad'));
    expect(screen.getByTestId('worktree-env-shared').textContent).toContain('Enlazado');
    expect(screen.getByTestId('worktree-env-copy').textContent).toContain('.env');
    expect(screen.getByTestId('worktree-env-skipped').textContent).toContain('git no lo ignora');
  });

  it('una tarea sin reglas de entorno no muestra la sección', () => {
    mountWith(snapshot([task('e2', { status: 'running' })]));
    fireEvent.click(screen.getByText('e2', { selector: '.orch__task-title' }));
    fireEvent.click(screen.getByText('Actividad'));
    expect(screen.getByText('Fases')).toBeTruthy();
    expect(screen.queryByTestId('worktree-env')).toBeNull();
  });
});
