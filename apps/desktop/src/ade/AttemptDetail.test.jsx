import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AttemptDetail } from './AttemptDetail';
import { coreModelFromState } from './useCoreModel';
import { CANONICAL, ERRORS, VARIANTS, attemptDetail } from './testFixtures/coreModelFixtures';
import { attemptActivityPage, attemptEvent } from './testFixtures/attemptActivityFixtures';
import { live } from './testFixtures/providerCapabilitiesFixtures';

// LXO-122 · Detalle de Attempt contra la fixture canónica y variantes locales de prueba.
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

describe('AttemptDetail (LXO-122)', () => {
  it('fixture canónica: identidad, ciclo de vida, sesión opaca, worktree, artefactos como texto y revisión', async () => {
    const calls = mount((payload) => {
      if (payload.query === 'provider_capabilities') return live();
      return payload.query === 'activity_list'
        ? attemptActivityPage([attemptEvent(1, 't3-a1', 'attempt.completed', { task: 't3', n: 1, has_summary: true }, 'success')])
        : CANONICAL['attempt_detail.v1.json'];
    });
    const onSelectTask = vi.fn();
    render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} onSelectTask={onSelectTask} />);
    await flush();
    const root = screen.getByTestId('attempt-detail');
    expect(calls[0]).toEqual({ query: 'attempt_detail', args: { attempt_id: 't3-a1' } });
    expect(within(root).getByText('t3-a1')).toBeTruthy();
    expect(within(root).getByText('Terminado', { selector: '.ade-status' })).toBeTruthy();
    expect(within(root).getByText('codex · gpt-6.1-sol')).toBeTruthy();
    expect(within(root).getByText('implementador / implementar / high')).toBeTruthy();
    // ended_at nulo (Attempts migrados en el cutover): sin hora de fin ni duración inventada.
    expect(within(root).getByText('duración no disponible')).toBeTruthy();
    expect(within(root).getByText('Integrado').nextSibling.textContent).toBe('sí');
    fireEvent.click(within(root).getByRole('button', { name: 't3' }));
    expect(onSelectTask).toHaveBeenCalledWith('t3');

    const session = screen.getByTestId('attempt-session');
    expect(within(session).getByText('ps-t3-a1')).toBeTruthy();
    expect(within(session).getByText('Reanudable').nextSibling.textContent).toBe('sí');

    const worktree = screen.getByTestId('attempt-worktree');
    const shown = within(worktree).getByText('t3-api-de-sesiones');
    expect(shown.getAttribute('title')).toBe('/home/ana/app.lixbon-wt/t3-api-de-sesiones');
    expect(within(worktree).getByText(/Host: no disponible/)).toBeTruthy();
    expect(within(worktree).getByRole('button', { name: /Copiar ruta/ })).toBeTruthy();

    const artifacts = screen.getByTestId('attempt-artifacts');
    expect(within(artifacts).getByText('.lixbon/out/t3/last.txt').getAttribute('title')).toContain('/home/ana/app.lixbon-wt/');
    expect(within(artifacts).getByText('t3.md')).toBeTruthy();
    // Ninguna ruta ni URI se vuelve enlace.
    expect(root.querySelectorAll('a')).toHaveLength(0);

    const review = screen.getByTestId('attempt-review');
    expect(within(review).getByText('accepted')).toBeTruthy();
    expect(within(review).getByText('Vigente para este head')).toBeTruthy();
    const activity = screen.getByTestId('attempt-activity');
    expect(within(activity).getByText('Actividad parcial: no incluye eventos de sesión ni worktree')).toBeTruthy();
    expect(within(activity).getByRole('listitem').textContent).toContain('Completado');
    // Además de las dos lecturas del Attempt, el bloque de capacidades lee lo que ofrece el proveedor (LXO-135).
    expect(calls.map((call) => call.query).filter((query) => query !== 'provider_capabilities')).toEqual(['attempt_detail', 'activity_list']);
    expect(calls.filter((call) => call.query === 'provider_capabilities').every((call) => Object.keys(call.args).length === 0)).toBe(true);
    expect(calls.find((call) => call.query === 'activity_list').args).toMatchObject({ target_kind: 'attempt', target_id: 't3-a1' });
  });

  it('variantes: host de worktree.machine, duración con fin, revisión stale/desconocida, sin worktree ni artefactos, estado desconocido', async () => {
    mount(() => attemptDetail({ ended_at: 1792000110000, status: 'paused_by_operator', worktree: { ...CANONICAL['attempt_detail.v1.json'].attempt.worktree, machine: 'pc-ana' }, review: { ...CANONICAL['attempt_detail.v1.json'].attempt.review, status: 'stale' } }));
    render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
    await flush();
    expect(screen.getByText('pc-ana')).toBeTruthy();
    expect(screen.getByText('1 min 0 s')).toBeTruthy();
    expect(screen.getByText(/Desactualizada/)).toBeTruthy();
    const unknown = screen.getByText(/Estado no reconocido/);
    expect(unknown.className).toContain('--neutral');
    expect(unknown.querySelector('details code').textContent).toBe('paused_by_operator');
    cleanup();
    mount(() => attemptDetail({ worktree: null, artifacts: [], review: { ...CANONICAL['attempt_detail.v1.json'].attempt.review, status: 'algo_nuevo' } }));
    render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
    await flush();
    expect(screen.getByText('Sin worktree registrado')).toBeTruthy();
    expect(screen.getByText('Sin artefactos')).toBeTruthy();
    expect(screen.getByText(/Frescura desconocida/).className).toContain('--neutral');
  });

  it('un Attempt de otra Task lo dice con su propio texto, con vuelta al proyecto y a su tarea', async () => {
    mount(() => CANONICAL['attempt_detail.v1.json']);
    const onBack = vi.fn();
    const onSelectTask = vi.fn();
    render(<AttemptDetail attemptId="t3-a1" taskId="t4" coreModel={V1} onBack={onBack} onSelectTask={onSelectTask} />);
    await flush();
    expect(screen.getByText('Este intento no pertenece a esta tarea')).toBeTruthy();
    expect(screen.queryByText('Esta tarea ya no existe o no es de este proyecto')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Volver al proyecto' }));
    expect(onBack).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Ir a su tarea' }));
    expect(onSelectTask).toHaveBeenCalledWith('t3');
  });

  it('Copiar ruta confirma «Ruta copiada» y avisa si el portapapeles falla', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      mount((payload) => (payload.query === 'activity_list' ? attemptActivityPage([]) : CANONICAL['attempt_detail.v1.json']));
      render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
      await flush();
      const worktree = screen.getByTestId('attempt-worktree');
      const feedback = within(worktree).getByTestId('path-copy-feedback');
      expect(feedback.getAttribute('aria-live')).toBe('polite');
      expect(feedback.textContent).toBe('');
      await act(async () => { fireEvent.click(within(worktree).getByRole('button', { name: /Copiar ruta/ })); });
      expect(writeText).toHaveBeenCalledWith('/home/ana/app.lixbon-wt/t3-api-de-sesiones');
      expect(feedback.textContent).toBe('Ruta copiada');
      writeText.mockRejectedValueOnce(new Error('denegado'));
      await act(async () => { fireEvent.click(within(worktree).getByRole('button', { name: /Copiar ruta/ })); });
      expect(feedback.textContent).toBe('No se pudo copiar la ruta');
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else delete navigator.clipboard;
    }
  });

  it('legacy: no consulta; errores por código con su copia', async () => {
    const calls = mount(() => { throw new Error(ERRORS.unavailable); });
    render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={LEGACY} />);
    await flush();
    expect(calls).toHaveLength(0);
    expect(screen.getByText('El modelo de Attempts aún no está activo en este Core')).toBeTruthy();
    cleanup();
    render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
    await flush();
    expect(screen.getByText('El Core no responde')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeTruthy();
  });
});
