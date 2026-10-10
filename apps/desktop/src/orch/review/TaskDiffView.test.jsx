import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { TaskDiffView } from './TaskDiffView';
import { invokeReviewTask, invokeTaskDiff, subscribeTaskReviewed } from './taskReview';
import { REVIEW_COMMANDS, REVIEW_EVENTS, reviewArgs, isNotFound } from './reviewContract';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const HEAD = '1234567890abcdef1234567890abcdef12345678';
const diff = (o = {}) => ({
  base_commit: 'aaaa111bbbb222', base_source: 'recorded', head_commit: HEAD, truncated: false,
  files: [
    { path: 'src/a.js', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1,1 +1,2 @@\n-x\n+y\n+z\n' },
    { path: 'b.md', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+hola\n' },
  ], ...o,
});
const makeApi = (over = {}) => ({
  fetchDiff: vi.fn(async () => diff()),
  review: vi.fn(async (a) => ({ ok: true, decision: a.decision, head_commit: a.head_commit, at: 'x' })),
  ...over,
});

describe('TaskDiffView', () => {
  it('muestra carga, luego archivos con conteos, patch y hashes cortos', async () => {
    const api = makeApi();
    render(<TaskDiffView taskId="t1" api={api} />);
    expect(screen.getByRole('status').textContent).toContain('Cargando');
    expect((await screen.findByTestId('tdv-base')).textContent).toBe('aaaa111');
    expect(screen.getByTestId('tdv-head').textContent).toBe('1234567');
    expect(api.fetchDiff).toHaveBeenCalledWith('t1');
    expect(screen.getByText('2 archivos', { exact: false })).toBeTruthy();
    expect(screen.getByTestId('tdv-file-src/a.js').textContent).toContain('+z');
    expect(screen.queryByTestId('tdv-truncated')).toBeNull();
    expect(screen.queryByTestId('tdv-merge-base')).toBeNull();
  });

  it('aviso de truncado y de base aproximada por merge-base', async () => {
    render(<TaskDiffView taskId="t1" api={makeApi({ fetchDiff: vi.fn(async () => diff({ truncated: true, base_source: 'merge_base' })) })} />);
    expect((await screen.findByTestId('tdv-truncated')).textContent).toContain('truncado');
    expect(screen.getByTestId('tdv-merge-base').textContent).toContain('merge-base');
  });

  it('diff vacío', async () => {
    render(<TaskDiffView taskId="t1" api={makeApi({ fetchDiff: vi.fn(async () => diff({ files: [] })) })} />);
    expect(await screen.findByTestId('tdv-empty')).toBeTruthy();
  });

  it('error al cargar se muestra y Reintentar vuelve a pedir', async () => {
    const fetchDiff = vi.fn().mockRejectedValueOnce('sin git').mockResolvedValueOnce(diff());
    render(<TaskDiffView taskId="t1" api={makeApi({ fetchDiff })} />);
    expect((await screen.findByRole('alert')).textContent).toContain('sin git');
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await screen.findByTestId('tdv-head');
    expect(fetchDiff).toHaveBeenCalledTimes(2);
  });

  it('aceptar pide confirmación explícita y envía el head revisado', async () => {
    const api = makeApi(); const onDecided = vi.fn();
    render(<TaskDiffView taskId="t1" api={api} onDecided={onDecided} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Aceptar' }));
    expect(api.review).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar aceptar' }));
    expect((await screen.findByTestId('tdv-done')).textContent).toContain('Diff aceptado');
    expect(api.review).toHaveBeenCalledWith({ task_id: 't1', decision: 'accepted', head_commit: HEAD, comment: undefined });
    expect(onDecided).toHaveBeenCalledTimes(1);
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
    fireEvent.click(await screen.findByRole('button', { name: 'Aceptar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar aceptar' }));
    fireEvent.click(screen.getByRole('button', { name: /Enviando/ }));
    expect(api.review).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ ok: true, decision: 'accepted', head_commit: HEAD, at: 'x' }); });
  });

  it('head_moved muestra found_commit y pide recargar el diff', async () => {
    const fetchDiff = vi.fn().mockResolvedValueOnce(diff()).mockResolvedValueOnce(diff({ head_commit: 'fedcba0987654321' }));
    const api = makeApi({ fetchDiff, review: vi.fn(async () => ({ error: 'head_moved', found_commit: 'fedcba0987654321' })) });
    const onDecided = vi.fn();
    render(<TaskDiffView taskId="t1" api={api} onDecided={onDecided} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Aceptar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar aceptar' }));
    const n = await screen.findByTestId('tdv-head-moved');
    expect(n.textContent).toContain('fedcba0');
    expect(onDecided).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Aceptar' })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Recargar diff' }).at(-1));
    await waitFor(() => expect(screen.getByTestId('tdv-head').textContent).toBe('fedcba0'));
    expect(screen.queryByTestId('tdv-head-moved')).toBeNull();
  });

  it('not_found al cargar (rechazo de texto) se muestra como tarea inexistente', async () => {
    render(<TaskDiffView taskId="t1" api={makeApi({ fetchDiff: vi.fn(async () => { throw 'not_found: t1'; }) })} />);
    expect((await screen.findByRole('alert')).textContent).toContain('no encuentra');
  });

  it('orch-task-reviewed de esta tarea muestra la última decisión y avisa; ignora otras tareas', async () => {
    let cb; const onReviewed = vi.fn();
    const api = makeApi({ subscribe: vi.fn((f) => { cb = f; return () => {}; }) });
    render(<TaskDiffView taskId="t1" api={api} onReviewed={onReviewed} />);
    await screen.findByTestId('tdv-head');
    act(() => cb({ task_id: 'otra', decision: 'accepted', head_commit: HEAD, at: 'x' }));
    expect(screen.queryByTestId('tdv-last-review')).toBeNull();
    act(() => cb({ task_id: 't1', decision: 'rejected', head_commit: HEAD, at: 'x' }));
    expect(screen.getByTestId('tdv-last-review').textContent).toContain('rechazado en 1234567');
    expect(onReviewed).toHaveBeenCalledWith({ task_id: 't1', decision: 'rejected', head_commit: HEAD, at: 'x' });
  });

  it('not_found al decidir (rechazo de texto) se muestra', async () => {
    const api = makeApi({ review: vi.fn(async () => { throw 'not_found: t1'; }) });
    render(<TaskDiffView taskId="t1" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Aceptar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar aceptar' }));
    expect((await screen.findByRole('alert')).textContent).toContain('no encuentra');
  });
});

describe('taskReview adaptador', () => {
  it('llama a los comandos en snake_case y omite comentario vacío', async () => {
    invoke.mockResolvedValue({});
    await invokeTaskDiff('t1');
    expect(invoke).toHaveBeenCalledWith(REVIEW_COMMANDS.diff, { task_id: 't1' });
    await invokeReviewTask({ task_id: 't1', decision: 'rejected', head_commit: 'h', comment: '  ' });
    expect(invoke).toHaveBeenLastCalledWith(REVIEW_COMMANDS.review, { task_id: 't1', decision: 'rejected', head_commit: 'h' });
    expect(reviewArgs({ task_id: 't', decision: 'rejected', head_commit: 'h', comment: ' no ' }).comment).toBe('no');
  });
  it('head_moved llega como respuesta normal y not_found como rechazo de texto', async () => {
    invoke.mockResolvedValueOnce({ error: 'head_moved', found_commit: 'abc' });
    expect(await invokeReviewTask({ task_id: 't1', decision: 'accepted', head_commit: 'h' })).toEqual({ error: 'head_moved', found_commit: 'abc' });
    invoke.mockRejectedValueOnce('not_found: t1');
    await expect(invokeReviewTask({ task_id: 't1', decision: 'accepted', head_commit: 'h' })).rejects.toBe('not_found: t1');
    expect(isNotFound('not_found: t1')).toBe(true);
    expect(isNotFound('otra cosa')).toBe(false);
  });
  it('subscribeTaskReviewed escucha orch-task-reviewed y entrega el payload', async () => {
    let handler; const un = vi.fn();
    listen.mockImplementationOnce((name, h) => { handler = h; expect(name).toBe(REVIEW_EVENTS.reviewed); return Promise.resolve(un); });
    const cb = vi.fn();
    const off = subscribeTaskReviewed(cb);
    handler({ payload: { task_id: 't1', decision: 'accepted', head_commit: 'h', at: 'x' } });
    expect(cb).toHaveBeenCalledWith({ task_id: 't1', decision: 'accepted', head_commit: 'h', at: 'x' });
    await Promise.resolve(); off();
    expect(un).toHaveBeenCalled();
  });
});
