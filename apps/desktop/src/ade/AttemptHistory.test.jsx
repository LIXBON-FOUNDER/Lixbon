import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AttemptHistory } from './AttemptHistory';
import { coreModelFromState, UNKNOWN_CORE_MODEL } from './useCoreModel';
import { CANONICAL, ERRORS, VARIANTS, attemptsPage, brief } from './testFixtures/coreModelFixtures';
import { attemptActivityPage } from './testFixtures/attemptActivityFixtures';

// LXO-121 · Historial de Attempts, contra fixtures y en los dos modos de core_model.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const V1 = coreModelFromState({ data: CANONICAL['core_model.v1.json'], error: null });
const LEGACY = coreModelFromState({ data: VARIANTS.coreModelLegacy, error: null });
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };

function mount(handler) {
  const calls = [];
  invoke.mockImplementation(async (command, payload) => { calls.push(payload); return handler(payload); });
  return calls;
}
afterEach(() => { cleanup(); invoke.mockReset(); });

describe('AttemptHistory (LXO-121)', () => {
  it('lista cronológica con estado en texto, proveedor/modelo, hora y duración; solo attempts_by_task', async () => {
    const items = [
      brief('t3', 3, 'running', { provider: 'codex', model: 'gpt-6.1-sol' }),
      brief('t3', 1, 'failed', { started_at: 1792000001000, ended_at: 1792000063000 }),
      brief('t3', 2, 'stopped'),
    ];
    const calls = mount((payload) => (payload.query === 'activity_list' ? attemptActivityPage([]) : attemptsPage('t3', items)));
    const onSelectAttempt = vi.fn();
    render(<AttemptHistory taskId="t3" coreModel={V1} selectedAttemptId="t3-a2" onSelectAttempt={onSelectAttempt} />);
    await flush();
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-attempt-id'))).toEqual(['t3-a1', 't3-a2', 't3-a3']);
    expect(within(rows[0]).getByText('Intento #1 · Falló').className).toContain('--');
    expect(within(rows[0]).getByText(/1 min 2 s/)).toBeTruthy();
    expect(within(rows[1]).getByText(/duración no disponible/)).toBeTruthy();
    expect(within(rows[2]).getByText(/codex · gpt-6.1-sol/)).toBeTruthy();
    expect(within(rows[1]).getByRole('button').getAttribute('aria-current')).toBe('true');
    fireEvent.click(within(rows[2]).getByRole('button'));
    expect(onSelectAttempt).toHaveBeenCalledWith('t3-a3');
    // La actividad (parcial) es solo del Attempt seleccionado: nunca attempt_detail ni una query por fila.
    expect(screen.getByText('Actividad parcial: no incluye eventos de sesión ni worktree')).toBeTruthy();
    expect(calls.map((call) => call.query).sort()).toEqual(['activity_list', 'attempts_by_task']);
    expect(calls.find((call) => call.query === 'attempts_by_task').args).toEqual({ task_id: 't3' });
    expect(calls.find((call) => call.query === 'activity_list').args).toMatchObject({ target_kind: 'attempt', target_id: 't3-a2' });
  });

  it('fixture canónica, 0 intentos neutro y estado desconocido sin estilo de error', async () => {
    mount(() => CANONICAL['attempts_by_task.v1.json']);
    render(<AttemptHistory taskId="t5" coreModel={V1} />);
    await flush();
    expect(screen.getAllByRole('listitem')).toHaveLength(CANONICAL['attempts_by_task.v1.json'].items.length);
    cleanup();
    mount(() => attemptsPage('t0', []));
    render(<AttemptHistory taskId="t0" coreModel={V1} />);
    await flush();
    expect(screen.getByText('Sin intentos todavía').className).toContain('--neutral');
    expect(document.querySelector('[role="alert"]')).toBeNull();
    cleanup();
    mount(() => attemptsPage('t9', [brief('t9', 1, 'paused_by_operator'), brief('t9', 2, 'awaiting_terminal_approval')]));
    render(<AttemptHistory taskId="t9" coreModel={V1} />);
    await flush();
    const unknown = screen.getByText(/Intento #1 · Estado no reconocido/);
    expect(unknown.className).toContain('--neutral');
    expect(unknown.querySelector('details code').textContent).toBe('paused_by_operator');
    expect(screen.getByText(/Intento #2 ·/).getAttribute('data-known')).toBe('true');
  });

  it('modo legacy o desconocido: no consulta y avisa sin reintento', async () => {
    const calls = mount(() => { throw new Error('no debería consultar'); });
    render(<AttemptHistory taskId="t3" coreModel={LEGACY} />);
    await flush();
    expect(screen.getByRole('status').firstChild.textContent).toBe('El modelo de Attempts aún no está activo en este Core');
    expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull();
    cleanup();
    render(<AttemptHistory taskId="t3" coreModel={UNKNOWN_CORE_MODEL} />);
    await flush();
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['inactive', 'El modelo de Attempts aún no está activo en este Core', null],
    ['unknownCommand', 'El modelo de Attempts aún no está activo en este Core', null],
    ['notFound', 'Esta tarea ya no existe o no es de este proyecto', 'Volver al proyecto'],
    ['unavailable', 'El Core no responde; reintentando', 'Reintentar'],
  ])('error %s por código estructurado', async (key, text, button) => {
    mount(() => { throw new Error(ERRORS[key]); });
    const onBack = vi.fn();
    render(<AttemptHistory taskId="t3" coreModel={V1} onBack={onBack} />);
    await flush();
    const notice = document.querySelector('.ade-notice');
    expect(notice.firstChild.textContent).toBe(text);
    expect(notice.querySelector('details code').textContent).toBe(ERRORS[key]);
    if (button) expect(within(notice).getByRole('button', { name: button })).toBeTruthy();
    else expect(within(notice).queryByRole('button')).toBeNull();
  });
});
