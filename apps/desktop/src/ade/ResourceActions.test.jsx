import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ResourceActions } from './ResourceActions';
import { ResourcesInventory } from './ResourcesInventory';
import { validateResourceInspect } from './resourceActionsContract';
import { resetOutstandingQueries } from './coreQueryPolicy';

// LXO-157 · Acciones sobre el worktree de una Task: limpiar lo integrado, quitar el worktree conservando la rama, con el estado de git a la vista.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const tick = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
const flush = async () => { for (let i = 0; i < 4; i += 1) await tick(); };
afterEach(() => { cleanup(); invoke.mockReset(); resetOutstandingQueries(); });

/** Un `resource_inspect` con la forma que manda el Core. */
function inspect(over = {}) {
  return {
    v: 1, task_id: 't1',
    worktree: { path: '/home/ana/app.lixbon-wt/wt', state: 'present', dirty: false },
    branch: { name: 'lx/r/t1-a1', exists: true, base: 'main', merged: 'integrated' },
    process: { running: false },
    health: { writable: true },
    actions: { clean: { ok: true }, delete_worktree: { ok: true, discards_uncommitted: false } },
    ...over,
  };
}

function mountCore({ views = [inspect()], decide = () => ({ outcome: 'cleaned', worktree_removed: true, branch_deleted: true, branch_kept: false }) } = {}) {
  const calls = [];
  let reads = 0;
  invoke.mockImplementation(async (command, payload) => {
    calls.push({ command, payload });
    if (command === 'orch_call') return decide(payload);
    if (payload.query === 'resource_inspect') { const v = views[Math.min(reads, views.length - 1)]; reads += 1; return v; }
    throw new Error(`consulta inesperada: ${payload?.query}`);
  });
  return calls;
}
const sent = (calls) => calls.filter((c) => c.command === 'orch_call').map((c) => c.payload);
const byId = (id) => screen.getByTestId(id);
const open = async (props = {}) => {
  render(<ResourceActions taskId="t1" {...props} />);
  fireEvent.click(byId('resact-open'));
  await flush();
};

describe('Acciones de recursos · contrato', () => {
  const args = { task_id: 't1' };
  const bad = (response, what) => expect(() => validateResourceInspect(response, args), what).toThrow(/ade_query_invalid_response: resource_inspect/);

  it('acepta lo del Core y rechaza ofrecer lo destructivo que el estado no permite', () => {
    expect(validateResourceInspect(inspect(), args)).toBeTruthy();
    bad({ ...inspect(), v: 2 }, 'versión');
    bad({ ...inspect(), task_id: 't2' }, 'otra Task');
    bad(inspect({ worktree: { path: null, state: 'raro', dirty: null } }), 'estado del worktree');
    bad(inspect({ worktree: { path: null, state: 'none', dirty: false } }), 'suciedad de lo que no está');
    bad(inspect({ actions: { clean: { ok: false }, delete_worktree: { ok: false, reason: 'dirty' } } }), 'sin motivo');
    bad(inspect({ actions: { clean: { ok: false, reason: 'porque_si' }, delete_worktree: { ok: false, reason: 'dirty' } } }), 'motivo fuera del contrato');
    bad(inspect({ health: { writable: false } }), 'se ofrece borrar con el Core en solo lectura');
    bad(inspect({ process: { running: true } }), 'se ofrece borrar con un proceso vivo');
    bad(inspect({ worktree: { path: 'x', state: 'unknown', dirty: null } }), 'se ofrece borrar con un estado desconocido');
    bad(inspect({ branch: { name: 'lx/r/t1-a1', exists: true, base: 'main', merged: 'not_merged' } }), 'se ofrece limpiar lo sin integrar');
    expect(() => validateResourceInspect(inspect({ branch: { name: 'x', exists: false, base: 'main', merged: 'unknown' } }), args), 'con la rama ya borrada solo se anota').not.toThrow();
  });
});

describe('Acciones de recursos · vista', () => {
  it('muestra el estado de git antes de actuar y no consulta nada hasta que se pide', async () => {
    const calls = mountCore();
    render(<ResourceActions taskId="t1" />);
    await flush();
    expect(calls).toEqual([]);
    fireEvent.click(byId('resact-open'));
    await flush();
    expect(byId('resact-worktree').textContent).toBe('en disco · limpio');
    expect(byId('resact-branch').textContent).toBe('lx/r/t1-a1 · integrada');
    expect(calls.filter((c) => c.payload?.query === 'resource_inspect')).toHaveLength(1);
  });

  it('limpiar pide confirmación con lo que va a pasar, manda la orden y vuelve a leer del Core', async () => {
    const calls = mountCore({
      views: [inspect(), inspect({ worktree: { path: null, state: 'none', dirty: null }, branch: { name: null, exists: null, base: 'main', merged: null }, actions: { clean: { ok: false, reason: 'nothing_to_do' }, delete_worktree: { ok: false, reason: 'no_worktree' } } })],
    });
    const onChanged = vi.fn();
    await open({ onChanged });
    fireEvent.click(byId('resact-clean'));
    expect(byId('resact-confirm').textContent).toMatch(/quitar el worktree \(limpio\) y a borrar su rama lx\/r\/t1-a1 con branch -d.*integrado.*no se puede deshacer/);
    expect(sent(calls)).toEqual([]);
    fireEvent.click(byId('resact-confirm-yes'));
    await flush();
    expect(sent(calls)).toEqual([{ cmd: 'resource_clean', args: { task_id: 't1', confirm: true } }]);
    expect(byId('resact-result').textContent).toBe('Limpio: se quitó el worktree y se borró su rama integrada.');
    expect(onChanged).toHaveBeenCalledTimes(1);
    // La vista se rehízo con lo que dice el Core, no con lo que la interfaz supone.
    expect(calls.filter((c) => c.payload?.query === 'resource_inspect')).toHaveLength(2);
    expect(byId('resact-worktree').textContent).toBe('sin worktree');
    expect(byId('resact-clean').disabled).toBe(true);
  });

  it('lo sucio o sin integrar sale desactivado con su motivo y no se puede ni confirmar', async () => {
    mountCore({
      views: [inspect({
        worktree: { path: 'x', state: 'present', dirty: true },
        branch: { name: 'lx/r/t1-a1', exists: true, base: 'main', merged: 'not_merged' },
        actions: { clean: { ok: false, reason: 'dirty' }, delete_worktree: { ok: true, discards_uncommitted: true } },
      })],
    });
    await open();
    expect(byId('resact-clean').disabled).toBe(true);
    expect(byId('resact-blocks').textContent).toContain('Limpiar: Tiene cambios sin commit.');
    expect(byId('resact-worktree').textContent).toBe('en disco · con cambios sin commit');
    expect(byId('resact-branch').textContent).toContain('sin integrar');
  });

  it('quitar el worktree conserva la rama, y los cambios sin commit solo se pierden si se descartan aparte', async () => {
    const calls = mountCore({
      views: [inspect({ worktree: { path: 'x', state: 'present', dirty: true }, actions: { clean: { ok: false, reason: 'dirty' }, delete_worktree: { ok: true, discards_uncommitted: true } } })],
      decide: () => ({ outcome: 'deleted', worktree_removed: true, branch_kept: true, discarded_uncommitted: true }),
    });
    await open();
    fireEvent.click(byId('resact-delete'));
    expect(byId('resact-confirm').textContent).toMatch(/La rama lx\/r\/t1-a1 se conserva con su trabajo/);
    expect(byId('resact-confirm-yes').disabled, 'sin descartar no se confirma').toBe(true);
    fireEvent.click(byId('resact-discard'));
    expect(byId('resact-confirm-yes').disabled).toBe(false);
    fireEvent.click(byId('resact-confirm-yes'));
    await flush();
    expect(sent(calls)).toEqual([{ cmd: 'resource_delete_worktree', args: { task_id: 't1', confirm: true, discard_uncommitted: true } }]);
    expect(byId('resact-result').textContent).toBe('Worktree quitado (se descartaron los cambios sin commit). La rama se conserva con su trabajo.');
  });

  it('un worktree limpio se quita sin pedir descartar nada y sin mandar discard_uncommitted', async () => {
    const calls = mountCore({ decide: () => ({ outcome: 'deleted', worktree_removed: true, branch_kept: true, discarded_uncommitted: false }) });
    await open();
    fireEvent.click(byId('resact-delete'));
    expect(screen.queryByTestId('resact-discard')).toBeNull();
    fireEvent.click(byId('resact-confirm-yes'));
    await flush();
    expect(sent(calls)[0].args).toEqual({ task_id: 't1', confirm: true });
  });

  it('con el Core en solo lectura o la tarea en marcha no hay nada que confirmar', async () => {
    mountCore({
      views: [inspect({
        health: { writable: false },
        actions: { clean: { ok: false, reason: 'degraded' }, delete_worktree: { ok: false, reason: 'degraded' } },
      })],
    });
    await open();
    expect(byId('resact-readonly').textContent).toMatch(/solo lectura.*no se borra nada/);
    expect(byId('resact-clean').disabled && byId('resact-delete').disabled).toBe(true);
    cleanup();
    mountCore({
      views: [inspect({
        process: { running: true },
        actions: { clean: { ok: false, reason: 'running' }, delete_worktree: { ok: false, reason: 'running' } },
      })],
    });
    await open();
    expect(byId('resact-blocks').textContent).toMatch(/sigue en marcha o tiene un proceso vivo/);
  });

  it('un worktree que ya no está en disco se dice y solo se anota', async () => {
    const calls = mountCore({
      views: [inspect({ worktree: { path: 'x', state: 'missing', dirty: null } })],
      decide: () => ({ outcome: 'forgotten', worktree_removed: false, branch_deleted: false, branch_kept: true }),
    });
    await open();
    expect(byId('resact-worktree').textContent).toBe('ya no está en disco');
    fireEvent.click(byId('resact-delete'));
    fireEvent.click(byId('resact-confirm-yes'));
    await flush();
    expect(byId('resact-result').textContent).toBe('El worktree ya no estaba en disco: solo se anotó. No se tocó git.');
    expect(sent(calls)).toHaveLength(1);
  });

  it('un rechazo del Core se dice en llano con su detalle y no da nada por hecho', async () => {
    mountCore({ decide: () => { throw new Error('resource_blocked: dirty: el worktree tiene cambios sin commit; descartarlos exige discard_uncommitted: true'); } });
    await open();
    fireEvent.click(byId('resact-clean'));
    fireEvent.click(byId('resact-confirm-yes'));
    await flush();
    expect(byId('resact-error').textContent).toMatch(/cambios sin commit: confírmalo aparte/);
    expect(screen.queryByTestId('resact-result')).toBeNull();
  });
});

describe('Acciones de recursos · en el inventario', () => {
  const target = (path) => ({ machine: 'm-1', project_id: 'p-1', repo: '/home/ana/app', path });
  const wt = (path, over = {}) => ({
    target: target(path), state: 'tracked', origin: 'task', physical: 'present',
    git: { registered: true, branch: 'lx/r/x', detached: false, locked: false, prunable: false },
    owner: { task_id: 't1', run_id: 'r-1', status: 'done' }, dirty: 'clean', merged: 'merged', into: 'main', needs_review: false, ...over,
  });
  const dto = (worktrees) => ({ v: 1, machine: 'm-1', filters: { project_id: null, probe: true }, repos: [], preserved_branches: [], worktrees, warnings: { branches_to_review: 0 } });

  it('solo el worktree que una Task posee ofrece acciones; un externo u huérfano no se vuelve propio', () => {
    render(<ResourcesInventory inventory={dto([
      wt('/home/ana/app.lixbon-wt/propio'),
      wt('/home/ana/app.lixbon-wt/faltante', { state: 'missing_on_disk', physical: 'missing' }),
      wt('/tmp/externo', { state: 'external', origin: 'external', owner: null }),
      wt('/home/ana/app.lixbon-wt/huerfano', { state: 'orphan_candidate', owner: null }),
    ])}
    />);
    expect(screen.getAllByTestId('resact-open')).toHaveLength(2);
    expect(screen.getAllByTestId('resinv-row')).toHaveLength(4);
  });

  it('tras actuar se vuelve a pedir el inventario al Core', async () => {
    mountCore();
    const onRetry = vi.fn();
    render(<ResourcesInventory inventory={dto([wt('/home/ana/app.lixbon-wt/propio')])} onRetry={onRetry} />);
    fireEvent.click(byId('resact-open'));
    await flush();
    fireEvent.click(byId('resact-clean'));
    fireEvent.click(byId('resact-confirm-yes'));
    await flush();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
