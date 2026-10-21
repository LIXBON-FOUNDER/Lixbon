import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { JumpPaletteHost } from './JumpPaletteHost';
import { queryAdeCore } from './coreQueries';

vi.mock('./coreQueries', async (importOriginal) => ({ ...(await importOriginal()), queryAdeCore: vi.fn() }));

// Sustituto mínimo de la paleta: expone las props que el anfitrión le entrega para poder invocar
// `onNavigate` con un destino ya mostrado aunque Core lo haya retirado después (la carrera que se prueba).
const palette = vi.hoisted(() => ({ props: null }));
vi.mock('./JumpPalette', () => ({
  JumpPalette: (props) => {
    palette.props = props;
    return (
      <div>
        <span data-testid="counts">{`${props.projects.length}/${props.tasks.length}/${props.attention.length}`}</span>
        {props.notice && (
          <div role="alert">
            <span>{props.notice.message}</span>
            {props.notice.actionLabel && <button type="button" onClick={props.notice.onAction}>{props.notice.actionLabel}</button>}
          </div>
        )}
      </div>
    );
  },
}));

configure({ asyncUtilTimeout: 5000 });

const TASK = { id: 'task-1', title: 'Task 1', status: 'running', created_at: 1, updated_at: 2 };
let tasks;
let projects;
let attention;

const core = () => queryAdeCore.mockImplementation(async (query, args) => {
  if (query === 'projects_overview') return { v: 1, projects };
  if (query === 'attention_list') return { v: 1, items: attention, has_more: false, next_cursor: null };
  return { v: 1, project_id: args.projectId, tasks, has_more: false, next_cursor: null };
});
const att = { id: 'att-1', category: 'question', severity: 'high', target_kind: 'task', target_id: 'task-1', project_id: 'prj-1' };
const counts = () => screen.getByTestId('counts').textContent;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  queryAdeCore.mockReset();
});

async function openWith(onNavigate) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  tasks = [TASK];
  projects = [{ id: 'prj-1', name: 'Alpha' }];
  attention = [att];
  core();
  render(<JumpPaletteHost open onClose={vi.fn()} onNavigate={onNavigate} />);
  await waitFor(() => expect(counts()).toBe('1/1/1'));
  const targets = {
    project: { kind: 'project', projectId: 'prj-1' },
    task: { kind: 'task', projectId: 'prj-1', taskId: 'task-1' },
    attention: { kind: 'attention', attentionId: 'att-1', targetKind: 'task', targetId: 'task-1', projectId: 'prj-1' },
  };
  return targets;
}

const refreshInBackground = async () => {
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
};

describe('JumpPaletteHost · destinos obsoletos', () => {
  it('navega cuando el destino sigue en el último conjunto autoritativo', async () => {
    const onNavigate = vi.fn(() => ({ ok: true }));
    const targets = await openWith(onNavigate);

    expect(palette.props.onNavigate(targets.task)).toBe(true);
    expect(onNavigate).toHaveBeenCalledWith(targets.task);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    ['task', () => { tasks = []; }, /La Task task-1 \(Project prj-1\) ya no está/],
    ['project', () => { projects = []; }, /El Project prj-1 ya no está/],
    ['attention', () => { attention = []; }, /La Attention att-1 ya no está/],
  ])('rechaza un %s retirado por el último refresco y ofrece un aviso recuperable', async (kind, mutate, message) => {
    const onNavigate = vi.fn(() => ({ ok: true }));
    const targets = await openWith(onNavigate);
    mutate();
    await refreshInBackground();
    await waitFor(() => expect(counts()).not.toBe('1/1/1'));

    expect(palette.props.onNavigate(targets[kind])).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(message));

    // Recuperación: «Actualizar resultados» vuelve a leer Core y retira el aviso.
    const before = queryAdeCore.mock.calls.filter(([name]) => name === 'projects_overview').length;
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar resultados' }));
    await waitFor(() => expect(queryAdeCore.mock.calls.filter(([name]) => name === 'projects_overview').length).toBe(before + 1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('no valida contra una caché de una apertura anterior: cada apertura parte de cero', async () => {
    const onNavigate = vi.fn(() => ({ ok: true }));
    const targets = await openWith(onNavigate);
    cleanup();

    tasks = [];
    render(<JumpPaletteHost open onClose={vi.fn()} onNavigate={onNavigate} />);
    await waitFor(() => expect(counts()).toBe('1/0/1'));
    expect(palette.props.onNavigate(targets.task)).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
