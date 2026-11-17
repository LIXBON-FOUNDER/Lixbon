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
  // El Core canónico anuncia `attempt_detail_v2` (LXO-244): la misma ejecución con `v: 2` (las fixtures v1 de aquí no traen PR que redactar).
  invoke.mockImplementation(async (command, payload) => {
    calls.push(payload);
    const response = await handler(payload);
    return payload?.query === 'attempt_detail_v2' && response?.v === 1 ? { ...response, v: 2 } : response;
  });
  return calls;
}
afterEach(() => { cleanup(); invoke.mockReset(); });

describe('AttemptDetail (LXO-122)', () => {
  it('un Attempt adoptado dice que es trabajo externo y no muestra inicio, fin ni duración (LXO-149)', async () => {
    const base = CANONICAL['attempt_detail.v1.json'];
    mount((payload) => {
      if (payload.query === 'provider_capabilities') return live();
      if (payload.query === 'activity_list') return attemptActivityPage([]);
      return { ...base, attempt: { ...base.attempt, adopted: true, adopted_at: 1_700_000_000_000, started_at: null, ended_at: null } };
    });
    render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} onSelectTask={vi.fn()} />);
    await flush();
    const root = screen.getByTestId('attempt-detail');
    expect(within(root).getByTestId('attempt-adopted').textContent).toMatch(/Trabajo externo adoptado/);
    expect(within(root).getByTestId('attempt-adopted').textContent).toMatch(/no hay inicio, fin ni duración/);
    expect(within(root).queryByText('Iniciado')).toBeNull();
    expect(within(root).queryByText('Duración')).toBeNull();
  });

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
    expect(calls[0]).toEqual({ query: 'attempt_detail_v2', args: { attempt_id: 't3-a1' } });
    expect(within(root).getByText('t3-a1')).toBeTruthy();
    expect(within(root).getByText('Terminado', { selector: '.ade-status' })).toBeTruthy();
    expect(within(root).getByText('Proveedor').nextSibling.textContent).toBe('codex · gpt-6.1-sol');
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
    // Además de las dos lecturas del Attempt, el bloque de capacidades lee lo que ofrece el proveedor (LXO-135) y, con una sesión que se
    // puede reanudar, «Continuar» lee el historial de la Task para saber si este es el último intento, la cola de instrucciones lee la suya y la procedencia (Forks, LXO-145/153) lee `attempt_lineage` y el Proof Pack (LXO-147/155) lee `attempt_proof_pack`.
    expect(calls.map((call) => call.query).filter((query) => !['provider_capabilities', 'attempts_by_task', 'pending_queue', 'attempt_lineage', 'attempt_proof_pack', 'attempt_integration_preview'].includes(query))).toEqual(['attempt_detail_v2', 'activity_list']);
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
  // LXO-244 · `attempt_detail_v2` solo si el Core la anuncia; la URL del PR nunca se pinta, con o sin v2.
  describe('attempt_detail_v2 (LXO-244)', () => {
    const PR_URL = 'https://github.com/ana/app/pull/42';
    const withPr = (uri, v) => {
      const base = CANONICAL['attempt_detail.v1.json'];
      return { ...base, v, attempt: { ...base.attempt, artifacts: [...base.attempt.artifacts, { id: 't3-a1-pr', kind: 'pull_request', uri, sha256: null, bytes: null }] } };
    };
    const announcing = (queries) => coreModelFromState({ data: { ...CANONICAL['core_model.v1.json'], queries }, error: null });
    const respond = (detail) => (payload) => {
      if (payload.query === 'provider_capabilities') return live();
      if (payload.query === 'activity_list') return attemptActivityPage([]);
      return detail;
    };

    it('con el Core que la anuncia pide solo v2 y dice «URL oculta» sin pintar ninguna URL ni avisar', async () => {
      const calls = mount(respond(withPr(null, 2)));
      render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={announcing(['task_list_v2', 'attempt_detail', 'attempt_detail_v2'])} />);
      await flush();
      const root = screen.getByTestId('attempt-detail');
      expect(calls.filter((c) => c.query === 'attempt_detail_v2')).toHaveLength(1);
      expect(calls.some((c) => c.query === 'attempt_detail'), 'sin lecturas legacy adicionales').toBe(false);
      expect(within(root).getByTestId('attempt-pr-url-hidden').textContent).toBe('URL del pull request oculta por seguridad');
      expect(root.textContent).not.toContain('github.com');
      expect(within(root).queryByText(/attempt_detail_v2/)).toBeNull();
      expect(root.querySelector('[data-code="attempt_detail_v2_unsupported"]')).toBeNull();
    });

    it('con un Core anterior lee attempt_detail, AVISA y tampoco pinta la URL del PR', async () => {
      const calls = mount(respond(withPr(PR_URL, 1)));
      render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={announcing(['task_list_v2', 'attempt_detail'])} />);
      await flush();
      const root = screen.getByTestId('attempt-detail');
      expect(calls.some((c) => c.query === 'attempt_detail')).toBe(true);
      expect(calls.some((c) => c.query === 'attempt_detail_v2')).toBe(false);
      const notice = root.querySelector('[data-code="attempt_detail_v2_unsupported"]');
      expect(notice?.textContent).toMatch(/Este Core es anterior/);
      expect(within(root).getByTestId('attempt-pr-url-hidden')).toBeTruthy();
      expect(root.textContent).not.toContain('github.com');
      // El resto del detalle sigue ahí: el aviso no rompe nada.
      expect(within(root).getByText('t3-a1')).toBeTruthy();
    });

    it('con v2 y `uri: null` en un artefacto que no es el PR, el detalle es un error de contrato y no se pinta', async () => {
      const base = CANONICAL['attempt_detail.v1.json'];
      mount(respond({ ...base, v: 2, attempt: { ...base.attempt, artifacts: [{ ...base.attempt.artifacts[0], uri: null }] } }));
      render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={announcing(['attempt_detail_v2'])} />);
      await flush();
      expect(screen.queryByTestId('attempt-artifacts')).toBeNull();
      expect(screen.getByRole('button', { name: 'Reintentar' })).toBeTruthy();
    });
  });
});
