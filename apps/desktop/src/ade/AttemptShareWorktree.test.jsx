import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AttemptShareWorktree } from './AttemptShareWorktree';

// LXO-248 · Compartir el worktree de otro intento antes de aprobar.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
afterEach(() => { cleanup(); invoke.mockReset(); });

const PENDING = { id: 't4-a1', status: 'pending_approval', worktree: null };
const LIBRE = { from_attempt_id: 't3-a1', worktree_id: 'wt-t3-a1', owner_task_id: 't3', owner_task_title: 'API de sesiones', branch: 'lx/r1/t3-a1', path: '/x/t3', busy_by: null };
const OCUPADO = { from_attempt_id: 't5-a1', worktree_id: 'wt-t5-a1', owner_task_id: 't5', owner_task_title: 'UI', branch: 'lx/r1/t5-a1', path: '/x/t5', busy_by: 't5-a2' };

/** El Core de pruebas: `attempt_share_candidates` da `candidatos`; `attempt_share_worktree` responde `compartir`. */
function mountCore({ candidatos = [LIBRE, OCUPADO], compartir = { status: 'Shared', attempt_id: 't4-a1', worktree_id: 'wt-t3-a1', owner_task_id: 't3' } } = {}) {
  invoke.mockImplementation(async (command, payload) => {
    if (command === 'orch_call' && payload.cmd === 'attempt_share_candidates') return { attempt_id: 't4-a1', candidates: candidatos };
    if (command === 'orch_call' && payload.cmd === 'attempt_share_worktree') {
      if (compartir instanceof Error) throw compartir;
      return compartir;
    }
    throw new Error(`comando inesperado ${command}`);
  });
}

const abre = async () => {
  const details = screen.getByTestId('attempt-share');
  details.open = true;
  fireEvent(details, new Event('toggle'));
  await flush();
};
const llamadas = (cmd) => invoke.mock.calls.filter(([, payload]) => payload?.cmd === cmd);

describe('AttemptShareWorktree (LXO-248)', () => {
  it('solo aparece mientras el intento espera su aprobación y no tiene worktree', () => {
    const { rerender } = render(<AttemptShareWorktree attempt={PENDING} />);
    expect(screen.getByTestId('attempt-share')).toBeTruthy();
    for (const attempt of [{ ...PENDING, status: 'running' }, { ...PENDING, worktree: { id: 'wt-t3-a1' } }, null]) {
      rerender(<AttemptShareWorktree attempt={attempt} />);
      expect(screen.queryByTestId('attempt-share')).toBeNull();
    }
  });

  it('no pide nada al Core hasta que se abre, y entonces lista los candidatos con los ocupados deshabilitados', async () => {
    mountCore();
    render(<AttemptShareWorktree attempt={PENDING} />);
    expect(invoke).not.toHaveBeenCalled();
    await abre();

    expect(llamadas('attempt_share_candidates')).toEqual([['orch_call', { cmd: 'attempt_share_candidates', args: { attempt_id: 't4-a1' } }]]);
    const options = [...screen.getByTestId('attempt-share-source').querySelectorAll('option')];
    const libre = options.find((o) => o.value === 't3-a1');
    const ocupado = options.find((o) => o.value === 't5-a1');
    expect(libre.disabled).toBe(false);
    expect(libre.textContent).toMatch(/API de sesiones/);
    expect(ocupado.disabled).toBe(true);
    expect(ocupado.textContent).toMatch(/en uso por t5-a2/);
  });

  it('sin elegir no se puede compartir; compartir manda el intento elegido y la confirmación explícita', async () => {
    mountCore();
    const onShared = vi.fn();
    render(<AttemptShareWorktree attempt={PENDING} onShared={onShared} />);
    await abre();
    const send = screen.getByTestId('attempt-share-send');
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('attempt-share-source'), { target: { value: 't3-a1' } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await flush();

    expect(llamadas('attempt_share_worktree')).toEqual([['orch_call', { cmd: 'attempt_share_worktree', args: { attempt_id: 't4-a1', from_attempt_id: 't3-a1', confirm: true } }]]);
    expect(screen.getByTestId('attempt-share-outcome').textContent).toMatch(/Compartido/);
    expect(onShared).toHaveBeenCalledTimes(1);
  });

  it('sin candidatos lo dice', async () => {
    mountCore({ candidatos: [] });
    render(<AttemptShareWorktree attempt={PENDING} />);
    await abre();
    expect(screen.getByTestId('attempt-share-empty').textContent).toMatch(/No hay otro worktree/);
  });

  it('un fallo al leer los candidatos se muestra sin inventar ninguno', async () => {
    invoke.mockRejectedValue(new Error('boom'));
    render(<AttemptShareWorktree attempt={PENDING} />);
    await abre();
    expect(screen.getByTestId('attempt-share-load-error')).toBeTruthy();
    expect(screen.queryByTestId('attempt-share-source')).toBeNull();
  });

  it('un rechazo del Core se dice en llano y deja reintentar', async () => {
    mountCore({ compartir: new Error('share_conflict: el Attempt t3-a1 sigue trabajando en wt-t3-a1') });
    render(<AttemptShareWorktree attempt={PENDING} />);
    await abre();
    fireEvent.change(screen.getByTestId('attempt-share-source'), { target: { value: 't3-a1' } });
    fireEvent.click(screen.getByTestId('attempt-share-send'));
    await flush();
    expect(screen.getByTestId('attempt-share-error').textContent).toMatch(/en serie/);
    expect(screen.queryByTestId('attempt-share-outcome')).toBeNull();
    expect(screen.getByTestId('attempt-share-send').disabled).toBe(false);
  });

  it('un Project distinto se explica sin confundirlo con el conflicto en serie', async () => {
    mountCore({ compartir: new Error('share_conflict: el Attempt t3-a1 no es de la Task ni del Project del Worktree wt-t3-a1') });
    render(<AttemptShareWorktree attempt={PENDING} />);
    await abre();
    fireEvent.change(screen.getByTestId('attempt-share-source'), { target: { value: 't3-a1' } });
    fireEvent.click(screen.getByTestId('attempt-share-send'));
    await flush();
    const text = screen.getByTestId('attempt-share-error').textContent;
    expect(text).toMatch(/otro Project/);
    expect(text).not.toMatch(/en serie/);
  });
});
