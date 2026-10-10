import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { IntegrationDialog } from './IntegrationDialog';
import { invokeIntegrateTask, ACCEPT_MOVED_TARGET_PARAM } from './integrateTask';
import { mockIntegrateTask, MOCK_ERRORS } from './mockIntegrateTask';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const btn = () => screen.getByRole('button', { name: /^(Integrar|Integrando…)$/ });
const confirmBox = () => screen.getByLabelText('Confirmo que quiero integrar esta rama en master');
const setup = (task, integrate = vi.fn(mockIntegrateTask), extra = {}) => {
  render(<IntegrationDialog task={task} branch={`lxo/${task}`} target="master" integrate={integrate} {...extra} />);
  return integrate;
};
const go = () => { fireEvent.click(confirmBox()); fireEvent.click(btn()); };

describe('IntegrationDialog', () => {
  it('muestra tarea, rama y destino, y no llama al host al montarse', () => {
    const fn = setup('t1');
    expect(screen.getByTestId('integration-task').textContent).toBe('t1');
    expect(screen.getByTestId('integration-branch').textContent).toBe('lxo/t1');
    expect(screen.getByTestId('integration-target').textContent).toBe('master');
    expect(fn).not.toHaveBeenCalled();
  });

  it('el botón queda deshabilitado hasta confirmar', () => {
    const fn = setup('t1');
    expect(btn().disabled).toBe(true);
    fireEvent.click(btn());
    expect(fn).not.toHaveBeenCalled();
    fireEvent.click(confirmBox());
    expect(btn().disabled).toBe(false);
  });

  it('merged: envía confirm: true sin accept_moved_target y muestra commit corto, mensaje y pista', async () => {
    const fn = setup('t1');
    go();
    expect(fn).toHaveBeenCalledWith({ task: 't1', confirm: true, squash: false });
    expect((await screen.findByTestId('integration-commit')).textContent).toBe('9f8e7d6');
    const r = screen.getByTestId('integration-result').textContent;
    expect(r).toContain('Integrada en master');
    expect(r).toContain('merge hecho');
    expect(r).toContain('revisa el resultado');
    expect(btn().disabled).toBe(true);
  });

  it('squash marcado se envía', async () => {
    const fn = setup('t1');
    fireEvent.click(screen.getByLabelText(/squash/));
    go();
    expect(fn).toHaveBeenCalledWith({ task: 't1', confirm: true, squash: true });
    await screen.findByTestId('integration-result');
  });

  it('doble clic: el adaptador se llama exactamente una vez', async () => {
    let resolve;
    const fn = vi.fn(() => new Promise((r) => { resolve = r; }));
    setup('t1', fn);
    fireEvent.click(confirmBox());
    fireEvent.click(btn());
    fireEvent.click(btn());
    expect(fn).toHaveBeenCalledTimes(1);
    expect(btn().disabled).toBe(true);
    expect(btn().textContent).toBe('Integrando…');
    resolve({ task: 't1', outcome: 'already_merged', decision: 'd', branch: 'b' });
    await screen.findByTestId('integration-result');
    fireEvent.click(btn());
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('already_merged: muestra el aviso', async () => {
    setup('t-already');
    go();
    expect((await screen.findByTestId('integration-result')).textContent).toContain('ya estaba integrada');
  });

  it('conflict: nota de que no cambió el destino y lista de archivos', async () => {
    setup('t-conflict');
    go();
    const r = await screen.findByTestId('integration-result');
    expect(r.textContent).toContain('Conflicto al integrar en master');
    expect(r.textContent).toContain('No se cambió nada en la rama destino.');
    const items = [...screen.getByTestId('integration-conflicts').querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toEqual(['src/a.js', 'docs/guia.md']);
    expect(screen.queryByTestId('integration-error')).toBeNull();
    expect(btn().disabled).toBe(false);
  });

  it('error resuelto: muestra el mensaje y que no se integró nada', async () => {
    setup('t-dirty');
    go();
    const r = await screen.findByTestId('integration-result');
    expect(r.textContent).toContain('cambios sin commit');
    expect(r.textContent).toContain('No se integró nada.');
  });

  it('target_moved: commits cortos, nota y reintento solo con la segunda confirmación', async () => {
    const fn = setup('t-moved');
    go();
    await screen.findByTestId('integration-result');
    expect(screen.getByTestId('integration-expected').textContent).toBe('1111111');
    expect(screen.getByTestId('integration-found').textContent).toBe('4444444');
    expect(screen.getByTestId('integration-result').textContent).toContain('No se integró nada. Revisa la rama destino');
    const retry = screen.getByRole('button', { name: 'Integrar contra la rama actual' });
    expect(retry.disabled).toBe(true);
    fireEvent.click(retry);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).not.toHaveProperty(ACCEPT_MOVED_TARGET_PARAM);
    fireEvent.click(screen.getByLabelText('Acepto que la rama destino cambió y quiero integrar contra 4444444'));
    fireEvent.click(retry);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[1][0]).toEqual({ task: 't-moved', confirm: true, squash: false, [ACCEPT_MOVED_TARGET_PARAM]: '4444444ddddddd5555555eeeeeee6666666fffff' });
    expect((await screen.findByTestId('integration-commit')).textContent).toBe('9f8e7d6');
  });

  it('segundo target_moved: muestra commits nuevos y exige volver a marcar', async () => {
    const fn = setup('t-moved-twice');
    go();
    await screen.findByTestId('integration-found');
    fireEvent.click(screen.getByLabelText(/Acepto que la rama destino cambió y quiero integrar contra 4444444/));
    fireEvent.click(screen.getByRole('button', { name: 'Integrar contra la rama actual' }));
    expect(fn.mock.calls[1][0][ACCEPT_MOVED_TARGET_PARAM]).toBe('4444444ddddddd5555555eeeeeee6666666fffff');
    await screen.findByText(/integrar contra 7777777/);
    expect(screen.getByTestId('integration-expected').textContent).toBe('4444444');
    expect(screen.getByTestId('integration-found').textContent).toBe('7777777');
    const box = screen.getByLabelText(/integrar contra 7777777/);
    expect(box.checked).toBe(false);
    const retry = screen.getByRole('button', { name: 'Integrar contra la rama actual' });
    expect(retry.disabled).toBe(true);
    fireEvent.click(retry);
    expect(fn).toHaveBeenCalledTimes(2);
    fireEvent.click(box);
    fireEvent.click(retry);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn.mock.calls[2][0][ACCEPT_MOVED_TARGET_PARAM]).toBe('7777777aaaaaaa8888888bbbbbbb9999999ccccc');
    expect((await screen.findByTestId('integration-commit')).textContent).toBe('9f8e7d6');
  });

  it.each([
    ['root', MOCK_ERRORS.root],
    ['t-running', MOCK_ERRORS.running],
    ['t-nobranch', MOCK_ERRORS.nobranch],
  ])('rechazo de uso %s: se muestra tal cual', async (task, msg) => {
    setup(task);
    go();
    expect((await screen.findByTestId('integration-error')).textContent).toBe(msg);
    expect(btn().disabled).toBe(false);
  });

  it('rechazo como Error: muestra el message', async () => {
    setup('t1', vi.fn(() => Promise.reject(new Error('fallo del host'))));
    go();
    expect((await screen.findByTestId('integration-error')).textContent).toBe('fallo del host');
  });

  it('textos por props para reutilizarlo', () => {
    render(<IntegrationDialog task="t1" branch="b" target="origin" integrate={vi.fn()} allowSquash={false}
      labels={{ title: 'Publicar PR', action: 'Publicar', confirm: (t) => `Confirmo publicar en ${t}` }} />);
    expect(screen.getByRole('button', { name: 'Publicar' })).toBeTruthy();
    expect(screen.getByLabelText('Confirmo publicar en origin')).toBeTruthy();
    expect(screen.queryByLabelText(/squash/)).toBeNull();
  });

  it('mock sin confirm rechaza', async () => {
    await expect(mockIntegrateTask({ task: 't1' })).rejects.toBe(MOCK_ERRORS.confirm);
  });

  it('adaptador real usa orch_integrate y solo envía accept_moved_target si es un commit (texto)', async () => {
    invoke.mockResolvedValue({ outcome: 'already_merged' });
    await invokeIntegrateTask({ task: 't1', confirm: true });
    expect(invoke).toHaveBeenLastCalledWith('orch_integrate', { task: 't1', confirm: true });
    await invokeIntegrateTask({ task: 't1', confirm: true, squash: true, [ACCEPT_MOVED_TARGET_PARAM]: true });
    expect(invoke).toHaveBeenLastCalledWith('orch_integrate', { task: 't1', confirm: true, squash: true });
    await invokeIntegrateTask({ task: 't1', confirm: true, [ACCEPT_MOVED_TARGET_PARAM]: 'abc123' });
    expect(invoke).toHaveBeenLastCalledWith('orch_integrate', { task: 't1', confirm: true, accept_moved_target: 'abc123' });
  });

  it('review_required: avisa, no integra y ofrece abrir la revisión', async () => {
    const onOpenReview = vi.fn();
    setup('t-unreviewed', vi.fn(mockIntegrateTask), { onOpenReview });
    go();
    const r = await screen.findByTestId('integration-result');
    expect(r.textContent).toContain('Falta aceptar el diff');
    expect(screen.queryByTestId('integration-commit')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Revisar diff' }));
    expect(onOpenReview).toHaveBeenCalledWith('t-unreviewed');
  });

  it('review_required muestra el HEAD actual y la última revisión (o que no hay)', async () => {
    setup('t-unreviewed');
    go();
    expect((await screen.findByTestId('integration-head')).textContent).toBe('9f8e7d6');
    expect(screen.getByTestId('integration-last-review').textContent).toContain('aceptada sobre 1111111');
    cleanup();
    setup('t-never-reviewed');
    go();
    expect((await screen.findByTestId('integration-last-review')).textContent).toContain('no hay ninguna revisión');
    cleanup();
    setup('t2', vi.fn(async () => ({ task: 't2', outcome: 'review_required', branch: 'lx/t2', head_commit: null, last_review: null, message: 'x' })));
    go();
    expect((await screen.findByTestId('integration-head')).textContent).toContain('ya no existe');
  });
});
