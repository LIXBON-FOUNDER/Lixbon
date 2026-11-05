import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ResourceAdopt } from './ResourceAdopt';
import { ResourcesInventory } from './ResourcesInventory';
import { validateResourceAdoptPreview } from './resourceActionsContract';
import { resetOutstandingQueries } from './coreQueryPolicy';

// LXO-157 · Adoptar un worktree externo: el Core decide si se puede y a qué tarea; la interfaz elige, confirma y vuelve a leer.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const tick = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
const flush = async () => { for (let i = 0; i < 4; i += 1) await tick(); };
afterEach(() => { cleanup(); invoke.mockReset(); resetOutstandingQueries(); });

const PATH = '/home/ana/otro/wt-externo';

/** Un `resource_adopt_preview` con la forma que manda el Core. */
function preview(over = {}) {
  return {
    v: 1, project_id: 'p1', path: PATH, branch: 'feature/externo', base: 'main',
    health: { writable: true },
    tasks: [{ task_id: 't2', title: 'Revisar trabajo externo' }],
    adopt: { ok: true },
    ...over,
  };
}
const blocked = (code, over = {}) => preview({ adopt: { ok: false, code, message: 'texto del Core' }, ...over });

function mountCore({ views = [preview()], decide = () => ({ status: 'Adopted', task_id: 't2', attempt_id: 't2-a1', branch: 'feature/externo', base: 'main' }) } = {}) {
  const calls = [];
  let reads = 0;
  invoke.mockImplementation(async (command, payload) => {
    calls.push({ command, payload });
    if (command === 'orch_call') return decide(payload);
    if (payload.query === 'resource_adopt_preview') { const v = views[Math.min(reads, views.length - 1)]; reads += 1; return v; }
    throw new Error(`consulta inesperada: ${payload?.query}`);
  });
  return calls;
}
const sent = (calls) => calls.filter((c) => c.command === 'orch_call').map((c) => c.payload);
const byId = (id) => screen.getByTestId(id);
const open = async (props = {}) => {
  render(<ResourceAdopt projectId="p1" path={PATH} {...props} />);
  fireEvent.click(byId('resadopt-open'));
  await flush();
};

describe('Adoptar · contrato', () => {
  const args = { project_id: 'p1', path: PATH };
  const bad = (response, what) => expect(() => validateResourceAdoptPreview(response, args), what).toThrow(/ade_query_invalid_response: resource_adopt_preview/);

  it('acepta lo del Core y rechaza ofrecer adoptar lo que el estado no permite', () => {
    expect(validateResourceAdoptPreview(preview(), args)).toBeTruthy();
    expect(validateResourceAdoptPreview(blocked('adopt_dirty', { tasks: [] }), args)).toBeTruthy();
    expect(validateResourceAdoptPreview(blocked('adopt_no_changes', { tasks: [] }), args)).toBeTruthy();
    bad({ ...preview(), v: 2 }, 'versión');
    bad({ ...preview(), path: '/otro' }, 'otro worktree');
    bad(preview({ adopt: { ok: false, code: 'porque_si', message: 'x' } }), 'código fuera del contrato');
    bad(preview({ adopt: { ok: true, code: 'adopt_dirty' } }), 'lo posible no trae código');
    bad(preview({ branch: null }), 'adoptable sin rama');
    bad(preview({ health: { writable: false } }), 'adoptable con el Core en solo lectura');
    bad(preview({ tasks: [] }), 'adoptable sin tarea que lo reciba');
    bad(preview({ tasks: [{ task_id: '', title: 'x' }] }), 'tarea inválida');
  });
});

describe('Adoptar · vista', () => {
  it('no consulta nada hasta que se pide y muestra rama, base y que debe estar limpio', async () => {
    const calls = mountCore();
    render(<ResourceAdopt projectId="p1" path={PATH} />);
    await flush();
    expect(calls).toHaveLength(0);
    fireEvent.click(byId('resadopt-open'));
    await flush();
    expect(byId('resadopt-branch').textContent).toBe('feature/externo');
    expect(byId('resadopt-base').textContent).toBe('main');
    expect(byId('resadopt').textContent).toMatch(/limpio/i);
    expect(calls.filter((c) => c.payload.query === 'resource_adopt_preview')[0].payload.args).toEqual({ project_id: 'p1', path: PATH });
  });

  it('con una sola tarea candidata la nombra, pide confirmar y manda solo la decisión confirmada', async () => {
    const calls = mountCore({ views: [preview(), blocked('adopt_already_owned', { tasks: [] })] });
    const changed = vi.fn();
    await open({ onChanged: changed });
    expect(byId('resadopt-single').textContent).toContain('Revisar trabajo externo');
    expect(sent(calls)).toHaveLength(0);
    fireEvent.click(byId('resadopt-go'));
    await flush();
    expect(byId('resadopt-confirm').textContent).toContain('feature/externo');
    // Antes de decidir se avisa de lo que viene después: liberar la tarea quita la carpeta (y borra la rama solo si ya está fusionada).
    expect(byId('resadopt-confirm').textContent).toMatch(/quitará esta carpeta/);
    expect(byId('resadopt-confirm').textContent).toMatch(/solo si ya está fusionada/);
    expect(sent(calls)).toHaveLength(0);
    fireEvent.click(byId('resadopt-confirm-yes'));
    await flush();
    expect(sent(calls)).toEqual([{ cmd: 'resource_adopt', args: { project_id: 'p1', path: PATH, task_id: 't2', confirm: true } }]);
    expect(byId('resadopt-result').textContent).toMatch(/Adoptado como el intento 1 de la tarea t2/);
    expect(changed).toHaveBeenCalledTimes(1);
    // Se vuelve a leer del Core: ya tiene dueño, no se vuelve a ofrecer.
    expect(screen.queryByTestId('resadopt-go')).toBeNull();
  });

  it('con varias tareas la persona elige y no se adivina', async () => {
    const calls = mountCore({ views: [preview({ tasks: [{ task_id: 't2', title: 'Una' }, { task_id: 't3', title: 'Otra' }] })] });
    await open();
    expect(byId('resadopt-go').disabled).toBe(true);
    fireEvent.click(byId('resadopt-task-t3'));
    expect(byId('resadopt-go').disabled).toBe(false);
    fireEvent.click(byId('resadopt-go'));
    await flush();
    fireEvent.click(byId('resadopt-confirm-yes'));
    await flush();
    expect(sent(calls)[0].args.task_id).toBe('t3');
  });

  it('un worktree sucio no se ofrece: sale el motivo del Core y no hay con qué adoptar', async () => {
    const calls = mountCore({ views: [blocked('adopt_dirty', { tasks: [] })] });
    await open();
    expect(byId('resadopt-block').dataset.reason).toBe('adopt_dirty');
    expect(byId('resadopt-block').textContent).toMatch(/cambios sin commit/);
    expect(screen.queryByTestId('resadopt-go')).toBeNull();
    expect(sent(calls)).toHaveLength(0);
  });

  it('sin tarea que lo reciba lo dice; con el Core en solo lectura avisa y no ofrece', async () => {
    mountCore({ views: [blocked('adopt_no_task', { tasks: [] })] });
    await open();
    expect(byId('resadopt-block').textContent).toMatch(/crea una primero/);
    cleanup();
    resetOutstandingQueries();
    mountCore({ views: [blocked('adopt_degraded', { health: { writable: false } })] });
    await open();
    expect(byId('resadopt-readonly')).toBeTruthy();
    expect(screen.queryByTestId('resadopt-go')).toBeNull();
  });

  it('si el Core rechaza la adopción lo dice en claro y deja reintentar', async () => {
    mountCore({ decide: () => { throw new Error('adopt_dirty: el worktree tiene cambios sin commit'); } });
    await open();
    fireEvent.click(byId('resadopt-go'));
    await flush();
    fireEvent.click(byId('resadopt-confirm-yes'));
    await flush();
    expect(byId('resadopt-error').textContent).toMatch(/cambios sin commit/);
    expect(byId('resadopt-confirm-yes').disabled).toBe(false);
  });
});

describe('Adoptar · en el inventario', () => {
  const dto = (state, over = {}) => ({
    v: 1, machine: 'm-1', filters: { project_id: 'p1', probe: true }, repos: [], preserved_branches: [], warnings: { branches_to_review: 0, worktrees_by_state: {} },
    worktrees: [{
      target: { machine: 'm-1', project_id: 'p1', repo: '/home/ana/app', path: PATH }, state, origin: 'external', physical: 'present',
      git: { registered: true, branch: 'feature/externo', detached: false, locked: false, prunable: false }, owner: null, dirty: 'clean', merged: 'unmerged', into: 'main', needs_review: true,
      ...over,
    }],
  });

  it('un worktree externo o huérfano ofrece adoptar; uno con dueño, podable o suelto, no', () => {
    for (const [state, over, expected] of [
      ['external', {}, true],
      ['orphan_candidate', { origin: 'lixbon_dir' }, true],
      ['tracked', { origin: 'task', owner: { task_id: 't1', run_id: 'r1', status: 'running' } }, false],
      ['external', { git: { registered: true, branch: 'x', detached: false, locked: false, prunable: true } }, false],
      ['external', { git: { registered: true, branch: null, detached: true, locked: false, prunable: false } }, false],
      ['external', { physical: 'missing' }, false],
    ]) {
      render(<ResourcesInventory inventory={dto(state, over)} />);
      expect(screen.queryByTestId('resadopt-open') !== null, `${state} ${JSON.stringify(over)}`).toBe(expected);
      cleanup();
    }
  });
});
