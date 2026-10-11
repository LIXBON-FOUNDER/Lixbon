import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { TaskDiffView } from './TaskDiffView';
import { invokeReviewTask, invokeTaskDiff, subscribeTaskReviewed } from './taskReview';
import { REVIEW_COMMANDS, REVIEW_EVENTS, reviewArgs, isNotFound, isNoBranch, fileStatus, formatBytes } from './reviewContract';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const HEAD = '1234567890abcdef1234567890abcdef12345678';
const NEW = 'fedcba0987654321fedcba0987654321fedcba09';
// Forma real de orch_task_diff (review.rs): estado en letra de git, binario con conteos null.
const diff = (o = {}) => ({
  task_id: 't1', branch: 'lx/t1', base_commit: 'aaaa111bbbb222', base_source: 'recorded', head_commit: HEAD,
  truncated: false, limit_bytes: 524288,
  files: [
    { path: 'src/a.js', status: 'M', additions: 2, deletions: 1, patch: '@@ -1,1 +1,2 @@\n-x\n+y\n+z\n' },
    { path: 'b.md', status: 'A', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+hola\n' },
  ], ...o,
});
const recorded = (a) => ({ task_id: a.task_id, outcome: 'recorded', decision: a.decision, decision_id: 7, head_commit: a.head_commit,
  base_commit: 'aaaa111', base_source: 'recorded', comment: a.comment ?? null, at: 1760054400 });
const makeApi = (over = {}) => ({
  fetchDiff: vi.fn(async () => diff()),
  review: vi.fn(async (a) => recorded(a)),
  ...over,
});
const accept = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Aceptar' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar aceptar' }));
};

describe('TaskDiffView', () => {
  it('muestra carga, luego rama, archivos con estado y conteos, patch y hashes cortos', async () => {
    const api = makeApi();
    render(<TaskDiffView taskId="t1" api={api} />);
    expect(screen.getByRole('status').textContent).toContain('Cargando');
    expect((await screen.findByTestId('tdv-base')).textContent).toBe('aaaa111');
    expect(screen.getByTestId('tdv-head').textContent).toBe('1234567');
    expect(screen.getByTestId('tdv-branch').textContent).toBe('lx/t1');
    expect(api.fetchDiff).toHaveBeenCalledWith('t1');
    expect(screen.getByText('2 archivos', { exact: false })).toBeTruthy();
    expect(screen.getByTestId('tdv-file-src/a.js').textContent).toContain('Modificado');
    expect(screen.getByTestId('tdv-file-b.md').textContent).toContain('Nuevo');
    expect(screen.getByTestId('tdv-file-src/a.js').textContent).toContain('+z');
    expect(screen.queryByTestId('tdv-truncated')).toBeNull();
    expect(screen.queryByTestId('tdv-merge-base')).toBeNull();
  });

  it('truncado con limit_bytes, patch omitido y base aproximada por merge-base', async () => {
    const files = [...diff().files, { path: 'c.js', status: 'M', additions: 9, deletions: 0, patch: null }];
    render(<TaskDiffView taskId="t1" api={makeApi({ fetchDiff: vi.fn(async () => diff({ truncated: true, base_source: 'merge_base', files })) })} />);
    expect((await screen.findByTestId('tdv-truncated')).textContent).toContain('512 KB');
    expect(screen.getByTestId('tdv-file-c.js').textContent).toContain('límite');
    expect(screen.getByTestId('tdv-merge-base').textContent).toContain('merge-base');
  });

  it('binario: conteos null se muestran como binario y no se pinta el patch', async () => {
    const files = [{ path: 'logo.png', status: 'A', additions: null, deletions: null, patch: 'Binary files /dev/null and b/logo.png differ\n' }];
    render(<TaskDiffView taskId="t1" api={makeApi({ fetchDiff: vi.fn(async () => diff({ files })) })} />);
    const f = await screen.findByTestId('tdv-file-logo.png');
    expect(f.textContent).toContain('binario');
    expect(f.textContent).not.toContain('Binary files');
  });

  it('diff vacío', async () => {
    render(<TaskDiffView taskId="t1" api={makeApi({ fetchDiff: vi.fn(async () => diff({ files: [] })) })} />);
    expect(await screen.findByTestId('tdv-empty')).toBeTruthy();
  });

  it('error al cargar se muestra y Reintentar vuelve a pedir', async () => {
    const fetchDiff = vi.fn().mockRejectedValueOnce('Sin base para revisar lx/t').mockResolvedValueOnce(diff());
    render(<TaskDiffView taskId="t1" api={makeApi({ fetchDiff })} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Sin base para revisar');
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await screen.findByTestId('tdv-head');
    expect(fetchDiff).toHaveBeenCalledTimes(2);
  });

  it('no_branch: mensaje claro y sin Reintentar', async () => {
    render(<TaskDiffView taskId="t1" api={makeApi({ fetchDiff: vi.fn(async () => { throw 'no_branch: t1 no tiene rama propia'; }) })} />);
    expect((await screen.findByTestId('tdv-load-error')).textContent).toContain('no tiene rama propia');
    expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull();
  });

  it('not_found al cargar se muestra como tarea inexistente', async () => {
    render(<TaskDiffView taskId="t1" api={makeApi({ fetchDiff: vi.fn(async () => { throw 'not_found: t1'; }) })} />);
    expect((await screen.findByRole('alert')).textContent).toContain('no encuentra');
  });

  it('aceptar pide confirmación explícita, envía el head revisado y muestra recorded', async () => {
    const api = makeApi(); const onDecided = vi.fn();
    render(<TaskDiffView taskId="t1" api={api} onDecided={onDecided} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Aceptar' }));
    expect(api.review).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar aceptar' }));
    expect((await screen.findByTestId('tdv-done')).textContent).toContain('Diff aceptado en 1234567');
    expect(api.review).toHaveBeenCalledWith({ task_id: 't1', decision: 'accepted', head_commit: HEAD, comment: undefined });
    expect(onDecided).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'recorded', decision_id: 7 }));
  });

  it('cancelar la confirmación no envía nada', async () => {
    const api = makeApi();
    render(<TaskDiffView taskId="t1" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Aceptar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByTestId('tdv-confirm')).toBeNull();
    expect(api.review).not.toHaveBeenCalled();
  });

  it('rechazar con comentario opcional', async () => {
    const api = makeApi();
    render(<TaskDiffView taskId="t1" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rechazar' }));
    fireEvent.change(screen.getByLabelText('Comentario (opcional)'), { target: { value: 'falta test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar rechazo' }));
    expect((await screen.findByTestId('tdv-done')).textContent).toContain('Diff rechazado');
    expect(api.review).toHaveBeenCalledWith({ task_id: 't1', decision: 'rejected', head_commit: HEAD, comment: 'falta test' });
  });

  it('doble clic en confirmar envía una sola vez', async () => {
    let resolve;
    const api = makeApi({ review: vi.fn(() => new Promise((r) => { resolve = r; })) });
    render(<TaskDiffView taskId="t1" api={api} />);
    await accept();
    fireEvent.click(screen.getByRole('button', { name: /Enviando/ }));
    expect(api.review).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(recorded({ task_id: 't1', decision: 'accepted', head_commit: HEAD })); });
  });

  it('head_moved muestra expected_commit y found_commit, no registra y pide recargar', async () => {
    const fetchDiff = vi.fn().mockResolvedValueOnce(diff()).mockResolvedValueOnce(diff({ head_commit: NEW }));
    const api = makeApi({ fetchDiff, review: vi.fn(async (a) => ({ task_id: 't1', outcome: 'head_moved', expected_commit: a.head_commit, found_commit: NEW })) });
    const onDecided = vi.fn();
    render(<TaskDiffView taskId="t1" api={api} onDecided={onDecided} />);
    await accept();
    const n = await screen.findByTestId('tdv-head-moved');
    expect(n.textContent).toContain('revisaste 1234567');
    expect(n.textContent).toContain('ahora está en fedcba0');
    expect(onDecided).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Aceptar' })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Recargar diff' }).at(-1));
    await waitFor(() => expect(screen.getByTestId('tdv-head').textContent).toBe('fedcba0'));
    expect(screen.queryByTestId('tdv-head-moved')).toBeNull();
  });

  it('head_moved con found_commit null: la rama ya no existe', async () => {
    const api = makeApi({ review: vi.fn(async (a) => ({ task_id: 't1', outcome: 'head_moved', expected_commit: a.head_commit, found_commit: null })) });
    render(<TaskDiffView taskId="t1" api={api} />);
    await accept();
    expect((await screen.findByTestId('tdv-head-moved')).textContent).toContain('ya no existe');
  });

  it('orch-task-reviewed de esta tarea muestra la última decisión y avisa; ignora otras tareas', async () => {
    let cb; const onReviewed = vi.fn();
    const api = makeApi({ subscribe: vi.fn((f) => { cb = f; return () => {}; }) });
    render(<TaskDiffView taskId="t1" api={api} onReviewed={onReviewed} />);
    await screen.findByTestId('tdv-head');
    act(() => cb({ task_id: 'otra', decision: 'accepted', head_commit: HEAD, at: 1 }));
    expect(screen.queryByTestId('tdv-last-review')).toBeNull();
    act(() => cb({ task_id: 't1', decision: 'rejected', head_commit: HEAD, at: 1 }));
    expect(screen.getByTestId('tdv-last-review').textContent).toContain('rechazado en 1234567');
    expect(onReviewed).toHaveBeenCalledWith({ task_id: 't1', decision: 'rejected', head_commit: HEAD, at: 1 });
  });

  it('not_found y no_branch al decidir se muestran claros', async () => {
    const api = makeApi({ review: vi.fn().mockRejectedValueOnce('not_found: t1').mockRejectedValueOnce('no_branch: t1') });
    render(<TaskDiffView taskId="t1" api={api} />);
    await accept();
    expect((await screen.findByRole('alert')).textContent).toContain('no encuentra');
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar aceptar' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('no tiene rama propia'));
  });
});

describe('taskReview adaptador y contrato', () => {
  it('llama a los comandos en snake_case, con confirm: true y sin comentario vacío', async () => {
    invoke.mockResolvedValue({});
    await invokeTaskDiff('t1');
    expect(invoke).toHaveBeenCalledWith(REVIEW_COMMANDS.diff, { task_id: 't1' });
    await invokeReviewTask({ task_id: 't1', decision: 'rejected', head_commit: 'h', comment: '  ' });
    expect(invoke).toHaveBeenLastCalledWith(REVIEW_COMMANDS.review, { task_id: 't1', decision: 'rejected', head_commit: 'h', confirm: true });
    expect(reviewArgs({ task_id: 't', decision: 'rejected', head_commit: 'h', comment: ' no ' }).comment).toBe('no');
  });
  it('head_moved llega como respuesta normal y not_found/no_branch como rechazo de texto', async () => {
    invoke.mockResolvedValueOnce({ task_id: 't1', outcome: 'head_moved', expected_commit: 'h', found_commit: 'abc' });
    expect((await invokeReviewTask({ task_id: 't1', decision: 'accepted', head_commit: 'h' })).outcome).toBe('head_moved');
    invoke.mockRejectedValueOnce('not_found: t1');
    await expect(invokeReviewTask({ task_id: 't1', decision: 'accepted', head_commit: 'h' })).rejects.toBe('not_found: t1');
    expect(isNotFound('not_found: t1')).toBe(true);
    expect(isNotFound('otra cosa')).toBe(false);
    expect(isNoBranch('no_branch: t1')).toBe(true);
  });
  it('fileStatus traduce las letras de git y formatBytes el límite', () => {
    expect(['A', 'M', 'D', 'T', 'R100'].map(fileStatus)).toEqual(['added', 'modified', 'deleted', 'typechange', 'renamed']);
    expect(fileStatus('modified')).toBe('modified');
    expect(formatBytes(524288)).toBe('512 KB');
    expect(formatBytes(undefined)).toBe(null);
  });
  it('subscribeTaskReviewed escucha orch-task-reviewed y entrega el payload', async () => {
    let handler; const un = vi.fn();
    listen.mockImplementationOnce((name, h) => { handler = h; expect(name).toBe(REVIEW_EVENTS.reviewed); return Promise.resolve(un); });
    const cb = vi.fn();
    const off = subscribeTaskReviewed(cb);
    handler({ payload: { task_id: 't1', decision: 'accepted', head_commit: 'h', at: 1 } });
    expect(cb).toHaveBeenCalledWith({ task_id: 't1', decision: 'accepted', head_commit: 'h', at: 1 });
    await Promise.resolve(); off();
    expect(un).toHaveBeenCalled();
  });
});
