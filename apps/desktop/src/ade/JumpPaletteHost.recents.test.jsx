import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { JumpPaletteHost } from './JumpPaletteHost';
import { RECENTS_STORAGE_KEY } from './jumpPaletteData';
import { queryAdeCore } from './coreQueries';

vi.mock('./coreQueries', async (importOriginal) => ({ ...(await importOriginal()), queryAdeCore: vi.fn() }));

// FIXTURES con la forma del contrato de docs/core/QUERIES.md; no son una lectura de Core real ni dogfood.

configure({ asyncUtilTimeout: 5000 });

const PROJECTS = [
  { id: 'prj-1', name: 'Alpha', state: 'active', status: 'failed', locations: [] },
  { id: 'prj-2', name: 'Beta', state: 'active', status: 'idle', locations: [] },
];
const task = (id, title, status) => ({ id, title, status, created_at: 1, updated_at: 2 });
const att = (over = {}) => ({
  id: 'att-1', category: 'question', severity: 'high', status: 'active', target_kind: 'task', target_id: 'prj-1-t1',
  project_id: 'prj-1', run_id: null, occurrence: 1, created_at: 1, resolved_at: null, resolution: null, ...over,
});

let tasksOf;
let attentionItems;
let fail;

function core() {
  queryAdeCore.mockImplementation(async (query, args) => {
    if (fail.has(query)) throw new Error(`${query}_read_failed: fixture`);
    if (query === 'projects_overview') return { v: 1, filters: { archived: args.archived }, total: PROJECTS.length, projects: PROJECTS };
    if (query === 'attention_list') return { v: 1, items: attentionItems, has_more: false, next_cursor: null, limit: 100 };
    return { v: 1, project_id: args.projectId, tasks: tasksOf[args.projectId] ?? [], has_more: false, next_cursor: null };
  });
}

function Harness({ onNavigate = () => ({ ok: true }) }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Abrir paleta</button>
      <JumpPaletteHost open={open} onClose={() => setOpen(false)} onNavigate={onNavigate} />
    </>
  );
}

const input = () => screen.getByRole('combobox', { name: 'Buscar Projects, Tasks y Attention' });
const group = (name) => screen.queryByRole('group', { name });
const labels = (name) => within(group(name)).getAllByRole('option').map((option) => option.textContent);
const stored = () => JSON.parse(localStorage.getItem(RECENTS_STORAGE_KEY) ?? '[]');
const loaded = () => waitFor(() => expect(screen.getByRole('status').textContent).not.toContain('Cargando'));

async function pick(query) {
  fireEvent.change(input(), { target: { value: query } });
  const option = await screen.findByRole('option', { name: new RegExp(query) });
  fireEvent.click(option);
}

beforeEach(() => {
  localStorage.clear();
  fail = new Set();
  tasksOf = {
    'prj-1': [task('prj-1-t1', 'Migrar esquema', 'running'), task('prj-1-t2', 'Refactor cerrado', 'done'), task('prj-1-t3', 'Intento roto', 'failed')],
    'prj-2': [task('prj-2-t1', 'Documentar', 'stopped')],
  };
  attentionItems = [att()];
  core();
});
afterEach(() => {
  cleanup();
  queryAdeCore.mockReset();
});

describe('JumpPaletteHost · Tasks finalizadas y estado del Project', () => {
  it('encuentra y abre una Task finalizada por título, ID y estado visible, sin Attempts', { timeout: 20_000 }, async () => {
    const onNavigate = vi.fn(() => ({ ok: true }));
    render(<Harness onNavigate={onNavigate} />);
    await screen.findByRole('option', { name: /Alpha/ });
    await loaded();

    expect(labels('Tasks')).toHaveLength(4);
    fireEvent.change(input(), { target: { value: 'Refactor cerrado' } });
    const option = await screen.findByRole('option');
    expect(option.textContent).toContain('Estado done');
    fireEvent.change(input(), { target: { value: 'prj-2-t1' } });
    expect((await screen.findByRole('option')).textContent).toContain('Estado stopped');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'task', projectId: 'prj-2', taskId: 'prj-2-t1' });
    expect(queryAdeCore.mock.calls.every(([, args]) => !('attemptId' in (args ?? {})))).toBe(true);
  });

  it('muestra el estado agregado del Project (`status`), no `state`', async () => {
    render(<Harness />);
    const alpha = await screen.findByRole('option', { name: /Alpha/ });
    expect(alpha.textContent).toContain('Estado failed');
    expect(alpha.textContent).not.toContain('Estado active');
    expect(screen.getByRole('option', { name: /Beta/ }).textContent).toContain('Estado idle');
  });
});

describe('JumpPaletteHost · recientes', () => {
  it('recuerda Project, Task y Attention al cerrar y reabrir, sin repetirlos en sus grupos y sin tocar Core', async () => {
    render(<Harness />);
    await screen.findByRole('option', { name: /Alpha/ });
    await loaded();
    await pick('Beta');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Abrir paleta' }));
    await screen.findByRole('option', { name: /Alpha/ });
    await loaded();
    await pick('Refactor cerrado');
    fireEvent.click(screen.getByRole('button', { name: 'Abrir paleta' }));
    await screen.findByRole('option', { name: /Alpha/ });
    await loaded();
    await pick('att-1');

    fireEvent.click(screen.getByRole('button', { name: 'Abrir paleta' }));
    await screen.findByRole('option', { name: /Alpha/ });
    await loaded();
    expect(input().value).toBe('');
    const recent = labels('Recientes');
    expect(recent).toHaveLength(3);
    expect(recent[0]).toContain('Migrar esquema'); // la Attention (título de su Task) es la más reciente
    expect(recent[1]).toContain('Refactor cerrado');
    expect(recent[2]).toContain('Beta');
    expect(labels('Projects')).toHaveLength(1);
    expect(labels('Tasks').join(' ')).not.toContain('Refactor cerrado');
    expect(document.getElementById(input().getAttribute('aria-activedescendant')).textContent).toBe(recent[0]);

    // Solo IDs durables en el cliente; Core solo recibió lecturas.
    expect(stored()).toEqual([
      { kind: 'attention', attentionId: 'att-1' },
      { kind: 'task', projectId: 'prj-1', taskId: 'prj-1-t2' },
      { kind: 'project', projectId: 'prj-2' },
    ]);
    expect(new Set(queryAdeCore.mock.calls.map(([name]) => name))).toEqual(new Set(['projects_overview', 'tasks_by_project', 'attention_list']));

    // Buscar vuelve a la lista normal.
    fireEvent.change(input(), { target: { value: 'Beta' } });
    expect(group('Recientes')).toBeNull();
    expect(labels('Projects')).toHaveLength(1);
  });

  it('restaura los recientes en un montaje nuevo (cierre de la app) y descarta los IDs obsoletos', async () => {
    localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify([
      { kind: 'task', projectId: 'prj-1', taskId: 'prj-1-t-eliminada' },
      { kind: 'project', projectId: 'prj-fantasma' },
      { kind: 'task', projectId: 'prj-fantasma', taskId: 'prj-1-t1' },
      { kind: 'attention', attentionId: 'att-resuelta' },
      { kind: 'project', projectId: 'prj-2' },
      { kind: 'task', projectId: 'prj-1', taskId: 'prj-1-t3' },
    ]));
    render(<Harness />);
    await screen.findByRole('option', { name: /Alpha/ });
    await loaded();

    const recent = labels('Recientes');
    expect(recent).toHaveLength(2);
    expect(recent[0]).toContain('Beta');
    expect(recent[1]).toContain('Intento roto');
    await waitFor(() => expect(stored()).toEqual([
      { kind: 'project', projectId: 'prj-2' },
      { kind: 'task', projectId: 'prj-1', taskId: 'prj-1-t3' },
    ]));
  });

  it('no pierde recientes cuando Core no pudo confirmarlos', async () => {
    const saved = [{ kind: 'task', projectId: 'prj-1', taskId: 'prj-1-t3' }, { kind: 'attention', attentionId: 'att-9' }];
    localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(saved));
    fail = new Set(['tasks_by_project', 'attention_list']);
    render(<Harness />);
    await screen.findByRole('option', { name: /Alpha/ });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('No se pudo'));

    expect(group('Recientes')).toBeNull(); // no hay con qué mostrarlos…
    expect(stored()).toEqual(saved); // …pero tampoco se borran
  });

  it('ignora un almacenamiento corrupto', async () => {
    localStorage.setItem(RECENTS_STORAGE_KEY, '{no es json');
    render(<Harness />);
    await screen.findByRole('option', { name: /Alpha/ });
    await loaded();
    expect(group('Recientes')).toBeNull();
    expect(labels('Projects')).toHaveLength(2);
  });

  it('un destino rechazado como obsoleto no se recuerda', async () => {
    const onNavigate = vi.fn(() => ({ ok: false, message: 'Destino no soportado' }));
    render(<Harness onNavigate={onNavigate} />);
    await screen.findByRole('option', { name: /Alpha/ });
    await loaded();
    fireEvent.change(input(), { target: { value: 'Beta' } });
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(screen.getByRole('alert').textContent).toContain('Destino no soportado');
    expect(stored()).toEqual([]);
  });
});
