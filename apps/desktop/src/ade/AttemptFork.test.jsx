import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AttemptDetail } from './AttemptDetail';
import { validateAttemptLineage } from './forkContract';
import { resetOutstandingQueries } from './coreQueryPolicy';
import { coreModelFromState } from './useCoreModel';
import { CANONICAL, attemptDetail } from './testFixtures/coreModelFixtures';
import { attemptActivityPage } from './testFixtures/attemptActivityFixtures';
import { CANONICAL_INVALID, validVariant } from './testFixtures/contextPreviewFixtures';
import { live, liveWith, provider } from './testFixtures/providerCapabilitiesFixtures';

// LXO-153 · Fork de un intento: crear una ejecución nueva sin tocar la original, y ver de dónde salió cada intento.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const V1 = coreModelFromState({ data: CANONICAL['core_model.v1.json'], error: null });
const tick = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
const flush = async () => { for (let i = 0; i < 4; i += 1) await tick(); };
afterEach(() => { cleanup(); invoke.mockReset(); resetOutstandingQueries(); });

const noLineage = () => ({ v: 1, attempt_id: 't3-a1', forked_from: null, forks: [] });
const FORKED = { v: 1, attempt_id: 't3-a1', forked_from: { attempt_id: 't2-a2', task_id: 't2', n: 2, strategy: 'context_package', package_id: `sha256:${'a'.repeat(64)}`, overrides: ['provider'] }, forks: [] };
const WITH_FORKS = {
  v: 1,
  attempt_id: 't3-a1',
  forked_from: null,
  forks: [
    { attempt_id: 't9-a1', task_id: 't9', strategy: 'clean', provider: 'fake-completo', model: null, status: 'running', created_at: 1_792_000_000_000 },
    { attempt_id: 't10-a1', task_id: 't10', strategy: 'context_package', provider: 'otro', model: 'm', status: 'pending_approval', created_at: 1_792_000_001_000 },
  ],
};

/** El paquete que revisó la persona: válido y de t3-a1 (o del origen que se diga). */
const reviewed = (source = {}) => validVariant((r) => { Object.assign(r.package.source, { task_id: 't3', attempt_id: 't3-a1', ...source }); });

/** Un Core de pruebas. `decide` responde a `attempt_fork`; `lineage` a `attempt_lineage`; `preview` a `context_package_preview`. */
function mountCore({
  status = 'done', caps = live(), lineage = noLineage, preview = () => reviewed(), decide = () => ({ status: 'Requested', source_attempt_id: 't3-a1', run_id: 'r9', task_id: 't9', attempt_id: 't9-a1', strategy: 'clean', package_id: null }),
} = {}) {
  const calls = [];
  invoke.mockImplementation(async (command, payload) => {
    calls.push({ command, payload });
    if (command === 'orch_call') return decide(payload);
    if (payload.query === 'provider_capabilities') return caps;
    if (payload.query === 'activity_list') return attemptActivityPage([]);
    if (payload.query === 'attempts_by_task') return { ...CANONICAL['attempts_by_task.v1.json'], task_id: 't3', items: [] };
    if (payload.query === 'pending_queue') return { v: 1, attempt_id: 't3-a1', task_id: 't3', items: [], finished: [], finished_limit: 20 };
    if (payload.query === 'attempt_lineage') return typeof lineage === 'function' ? lineage() : lineage;
    if (payload.query === 'context_package_preview') return typeof preview === 'function' ? preview(payload) : preview;
    return attemptDetail({ id: 't3-a1', task_id: 't3', n: 1, status, provider: 'fake-completo' });
  });
  return calls;
}
const open = vi.fn();
const mount = () => render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} onOpenAttempt={open} />);
const sent = (calls) => calls.filter((c) => c.command === 'orch_call').map((c) => c.payload);
const byId = (id) => screen.getByTestId(id);
const openForm = async () => { fireEvent.click(byId('attempt-fork-open')); await flush(); };
afterEach(() => open.mockReset());

describe('Bifurcar un intento (LXO-153)', () => {
  it('se ofrece en cualquier estado salvo mientras espera su aprobación, y el formulario dice qué hará el Core antes de confirmar', async () => {
    for (const status of ['running', 'done', 'failed', 'stopped', 'waiting']) {
      mountCore({ status });
      const { unmount } = mount();
      await flush();
      expect(screen.getByTestId('attempt-fork-open'), status).toBeTruthy();
      unmount();
    }
    mountCore({ status: 'pending_approval' });
    const pending = mount();
    await flush();
    expect(screen.queryByTestId('attempt-fork'), 'pending_approval').toBeNull();
    pending.unmount();

    mountCore();
    mount();
    await flush();
    await openForm();
    expect(byId('attempt-fork-source').textContent).toMatch(/Crea un intento nuevo a partir de t3-a1.*Este intento no se modifica y puede seguir corriendo/);
    expect(byId('attempt-fork-worktree').textContent).toMatch(/worktree nuevo e independiente.*Compartir el del intento original no está disponible/);
    expect(byId('attempt-fork-approval').textContent).toMatch(/pendiente de tu aprobación: no se ejecuta hasta que la des/);
    expect(byId('attempt-fork-ctx-clean').checked).toBe(true);
    expect(byId('attempt-fork-inherit').textContent).toMatch(/hereda el modelo y el esfuerzo.*rol y el perfil de permisos se heredan siempre/);
    expect(screen.queryByTestId('attempt-fork-package')).toBeNull();
  });

  it('solo ofrece los proveedores que el Core dice que pueden arrancar', async () => {
    mountCore({ caps: liveWith([provider('fake-completo'), provider('sin-start', { start: 'unsupported' }), provider('otro')]) });
    mount();
    await flush();
    await openForm();
    const options = [...byId('attempt-fork-provider').querySelectorAll('option')].map((o) => o.value);
    expect(options).toEqual(['fake-completo', 'otro']);
    expect(byId('attempt-fork-provider').value).toBe('fake-completo');
  });

  it('un Fork limpio manda attempt_fork con el origen y lo elegido, avisa de que espera aprobación y NO roba el foco', async () => {
    const calls = mountCore();
    mount();
    await flush();
    await openForm();
    fireEvent.change(byId('attempt-fork-model'), { target: { value: '  opus  ' } });
    fireEvent.change(byId('attempt-fork-title'), { target: { value: 'Probar otro enfoque' } });
    fireEvent.click(byId('attempt-fork-submit'));
    await flush();

    const [call] = sent(calls);
    expect(call.cmd).toBe('attempt_fork');
    expect(call.args).toMatchObject({ source_attempt_id: 't3-a1', provider: 'fake-completo', model: 'opus', title: 'Probar otro enfoque' });
    expect(call.args.request_id).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
    expect(call.args).not.toHaveProperty('package');
    for (const forbidden of ['profile', 'worktree', 'host', 'external']) expect(call.args, forbidden).not.toHaveProperty(forbidden);
    expect(byId('attempt-fork-outcome').textContent).toMatch(/Fork pedido: queda pendiente de tu aprobación y no se ejecuta hasta entonces\. Intento nuevo: t9-a1/);
    // Crear el Fork no abre el intento nuevo: abrirlo es un botón explícito.
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(byId('attempt-fork-go'));
    expect(open).toHaveBeenCalledWith({ taskId: 't9', attemptId: 't9-a1' });
  });

  it('con otro proveedor dice que el modelo y el esfuerzo no se arrastran, y manda ese proveedor', async () => {
    const calls = mountCore({ caps: liveWith([provider('fake-completo'), provider('otro')]) });
    mount();
    await flush();
    await openForm();
    fireEvent.change(byId('attempt-fork-provider'), { target: { value: 'otro' } });
    expect(byId('attempt-fork-inherit').textContent).toMatch(/Es otro proveedor: el modelo y el esfuerzo de este intento no se arrastran/);
    fireEvent.click(byId('attempt-fork-submit'));
    await flush();
    expect(sent(calls)[0].args.provider).toBe('otro');
  });

  it('con paquete: no deja bifurcar hasta revisarlo, y revisarlo muestra su identidad y que sale de este intento', async () => {
    const calls = mountCore();
    mount();
    await flush();
    await openForm();
    fireEvent.click(byId('attempt-fork-ctx-package'));
    expect(byId('attempt-fork-submit').disabled).toBe(true);
    expect(byId('attempt-fork-package-pending').textContent).toMatch(/Revisa el paquete antes de bifurcar/);
    fireEvent.change(byId('attempt-fork-package-text'), { target: { value: '{"paquete":"x"}' } });
    expect(byId('attempt-fork-submit').disabled).toBe(true);

    fireEvent.click(byId('attempt-fork-package-review'));
    await flush();
    expect(calls.find((c) => c.payload?.query === 'context_package_preview').payload.args.package).toBe('{"paquete":"x"}');
    expect(byId('attempt-fork-package-valid').dataset.fromAttempt).toBe('true');
    expect(byId('attempt-fork-package-origin').textContent).toMatch(/Sale de este intento/);
    expect(byId('attempt-fork-package-valid').textContent).toMatch(/Identidad verificada: sha256:/);
    expect(byId('attempt-fork-submit').disabled).toBe(false);

    fireEvent.click(byId('attempt-fork-submit'));
    await flush();
    // Se manda EXACTAMENTE el texto que se revisó.
    expect(sent(calls)[0].args.package).toBe('{"paquete":"x"}');
  });

  it('un paquete de otro intento, uno inválido o uno editado después de revisarlo no permiten bifurcar', async () => {
    mountCore({ preview: () => reviewed({ attempt_id: 't3-a7' }) });
    mount();
    await flush();
    await openForm();
    fireEvent.click(byId('attempt-fork-ctx-package'));
    fireEvent.change(byId('attempt-fork-package-text'), { target: { value: '{"a":1}' } });
    fireEvent.click(byId('attempt-fork-package-review'));
    await flush();
    expect(byId('attempt-fork-package-foreign').textContent).toMatch(/sale de t3-a7, no de este intento: el Core lo rechazaría/);
    expect(byId('attempt-fork-submit').disabled).toBe(true);
    cleanup();

    mountCore({ preview: () => CANONICAL_INVALID });
    mount();
    await flush();
    await openForm();
    fireEvent.click(byId('attempt-fork-ctx-package'));
    fireEvent.change(byId('attempt-fork-package-text'), { target: { value: '{"a":1}' } });
    fireEvent.click(byId('attempt-fork-package-review'));
    await flush();
    expect(byId('attempt-fork-package-invalid').textContent).toMatch(/no pasa la verificación del Core: no se puede usar para bifurcar/);
    expect(byId('attempt-fork-submit').disabled).toBe(true);
    cleanup();

    mountCore();
    mount();
    await flush();
    await openForm();
    fireEvent.click(byId('attempt-fork-ctx-package'));
    fireEvent.change(byId('attempt-fork-package-text'), { target: { value: '{"a":1}' } });
    fireEvent.click(byId('attempt-fork-package-review'));
    await flush();
    expect(byId('attempt-fork-submit').disabled).toBe(false);
    fireEvent.change(byId('attempt-fork-package-text'), { target: { value: '{"a":2}' } });
    expect(byId('attempt-fork-submit').disabled, 'editar el paquete borra la revisión').toBe(true);
  });

  it('un fallo del Core se dice en llano con su detalle técnico, y reintentar sin cambiar nada conserva la clave', async () => {
    let step = 0;
    const calls = mountCore({
      decide: () => {
        step += 1;
        if (step === 1) throw new Error('provider_start_unavailable: fake-completo no puede lanzar ahora (sin sesión)');
        return { status: step === 2 ? 'Requested' : 'Replayed', task_id: 't9', attempt_id: 't9-a1' };
      },
    });
    mount();
    await flush();
    await openForm();
    fireEvent.click(byId('attempt-fork-submit'));
    await flush();
    expect(byId('attempt-fork-error').textContent).toMatch(/Ese proveedor no puede arrancar un intento ahora mismo/);
    expect(byId('attempt-fork-error').textContent).toMatch(/provider_start_unavailable/);
    expect(screen.queryByTestId('attempt-fork-outcome')).toBeNull();

    // Sin cambiar nada: la misma clave (si el primer intento sí llegó, el Core lo reconoce).
    fireEvent.click(byId('attempt-fork-submit'));
    await flush();
    const keys = sent(calls).map((c) => c.args.request_id);
    expect(keys[0]).toBe(keys[1]);
    expect(byId('attempt-fork-outcome').textContent).toMatch(/Fork pedido/);
  });

  it('cambiar lo que se pide cambia la clave: una clave vieja nunca atiende otra cosa', async () => {
    const calls = mountCore({ decide: () => { throw new Error('fallo de red'); } });
    mount();
    await flush();
    await openForm();
    fireEvent.click(byId('attempt-fork-submit'));
    await flush();
    fireEvent.change(byId('attempt-fork-title'), { target: { value: 'Otro título' } });
    fireEvent.click(byId('attempt-fork-submit'));
    await flush();
    const keys = sent(calls).map((c) => c.args.request_id);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('un Fork repetido se dice como tal', async () => {
    mountCore({ decide: () => ({ status: 'Replayed', task_id: 't9', attempt_id: 't9-a1' }) });
    mount();
    await flush();
    await openForm();
    fireEvent.click(byId('attempt-fork-submit'));
    await flush();
    expect(byId('attempt-fork-outcome').textContent).toMatch(/Este Fork ya estaba pedido/);
  });
});

describe('Procedencia de un intento (LXO-153)', () => {
  it('un intento que no salió de un Fork ni tiene Forks no pinta procedencia, pero ofrece bifurcar', async () => {
    mountCore();
    mount();
    await flush();
    expect(screen.queryByTestId('attempt-lineage-origin')).toBeNull();
    expect(screen.queryByTestId('attempt-lineage-forks')).toBeNull();
    expect(byId('attempt-fork-open')).toBeTruthy();
  });

  it('muestra de dónde salió, con qué contexto y qué cambió, y abrir el origen es una elección explícita', async () => {
    mountCore({ lineage: FORKED });
    mount();
    await flush();
    expect(byId('attempt-lineage-origin').textContent).toMatch(/Bifurcado del intento t2-a2 · con un paquete de contexto · otro proveedor · paquete sha256:/);
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(byId('attempt-lineage-origin-open'));
    expect(open).toHaveBeenCalledWith({ taskId: 't2', attemptId: 't2-a2' });
  });

  it('lista los Forks del intento con su estado de ahora y permite abrir cada uno', async () => {
    mountCore({ lineage: WITH_FORKS });
    mount();
    await flush();
    const forks = byId('attempt-lineage-forks');
    expect([...forks.querySelectorAll('li')].map((li) => li.dataset.fork)).toEqual(['t9-a1', 't10-a1']);
    expect(forks.textContent).toMatch(/t9-a1 · fake-completo · solo con el encargo/);
    expect(forks.textContent).toMatch(/t10-a1 · otro · m · con un paquete de contexto/);
    fireEvent.click(forks.querySelector('li[data-fork="t10-a1"] button'));
    expect(open).toHaveBeenCalledWith({ taskId: 't10', attemptId: 't10-a1' });
  });

  it('si la lectura de la procedencia falla no se inventa nada y bifurcar sigue disponible', async () => {
    mountCore({ lineage: () => { throw new Error('model_unavailable'); } });
    mount();
    await flush();
    expect(screen.queryByTestId('attempt-lineage-origin')).toBeNull();
    expect(byId('attempt-fork-open')).toBeTruthy();
  });

  it('el contrato rechaza una procedencia que no cuadra: otro Attempt, estrategia desconocida, paquete sin estrategia', () => {
    const args = { attempt_id: 't3-a1' };
    expect(validateAttemptLineage(FORKED, args)).toBe(FORKED);
    expect(validateAttemptLineage(WITH_FORKS, args)).toBe(WITH_FORKS);
    const bad = (response) => expect(() => validateAttemptLineage(response, args)).toThrow(/ade_query_invalid_response: attempt_lineage/);
    bad(null);
    bad({ ...FORKED, v: 2 });
    bad({ ...FORKED, attempt_id: 'otro-a1' });
    bad({ ...FORKED, forks: undefined });
    bad({ ...FORKED, forked_from: { ...FORKED.forked_from, strategy: 'magia' } });
    bad({ ...FORKED, forked_from: { ...FORKED.forked_from, package_id: null } });
    bad({ ...FORKED, forked_from: { ...FORKED.forked_from, strategy: 'clean' } });
    bad({ ...FORKED, forked_from: { ...FORKED.forked_from, overrides: ['profile'] } });
    bad({ ...WITH_FORKS, forks: [{ ...WITH_FORKS.forks[0], status: '' }] });
    bad({ ...WITH_FORKS, forks: [{ ...WITH_FORKS.forks[0], created_at: -1 }] });
  });
});
