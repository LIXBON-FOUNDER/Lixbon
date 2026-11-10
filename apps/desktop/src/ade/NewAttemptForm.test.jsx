import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { NewAttemptForm } from './NewAttemptForm';
import { coreModelFromState } from './useCoreModel';
import { CANONICAL, VARIANTS } from './testFixtures/coreModelFixtures';
import { blocked, liveWith, provider } from './testFixtures/providerCapabilitiesFixtures';

// LXO-141 · Crear una Task con su primer Attempt desde el ADE.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const V1 = coreModelFromState({ data: CANONICAL['core_model.v1.json'], error: null });
const LEGACY = coreModelFromState({ data: VARIANTS.coreModelLegacy, error: null });
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
const PROVIDERS = liveWith([provider('claude'), blocked('codex'), provider('fake-sin-start', { start: 'unsupported' })]);

function mount({ create } = {}) {
  const calls = [];
  invoke.mockImplementation(async (command, payload) => {
    calls.push({ command, payload });
    if (command === 'orch_query' && payload.query === 'provider_capabilities') return PROVIDERS;
    if (command === 'orch_call' && payload.cmd === 'task_create') return create ? create(payload) : { status: 'Committed', run_id: 'r1', task_id: 't9', attempt_id: 't9-a1' };
    throw new Error(`inesperado: ${command}`);
  });
  return calls;
}
const creates = (calls) => calls.filter((c) => c.command === 'orch_call' && c.payload.cmd === 'task_create');
afterEach(() => { cleanup(); invoke.mockReset(); });

async function openAndFill() {
  fireEvent.click(screen.getByTestId('new-attempt-open'));
  fireEvent.change(screen.getByTestId('new-attempt-title'), { target: { value: 'Arreglar el login' } });
  fireEvent.change(screen.getByTestId('new-attempt-instructions'), { target: { value: 'Revisa el flujo de login' } });
}

describe('NewAttemptForm (LXO-141)', () => {
  it('no aparece sin el modelo Task/Attempt del Core ni sin Project', async () => {
    const calls = mount();
    const { container, rerender } = render(<NewAttemptForm projectId="p1" coreModel={LEGACY} onCreated={vi.fn()} />);
    await flush();
    expect(container.firstChild).toBeNull();
    rerender(<NewAttemptForm projectId={null} coreModel={V1} onCreated={vi.fn()} />);
    await flush();
    expect(container.firstChild).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('solo ofrece los proveedores que el Core dice que pueden arrancar', async () => {
    mount();
    render(<NewAttemptForm projectId="p1" coreModel={V1} onCreated={vi.fn()} />);
    await flush();
    fireEvent.click(screen.getByTestId('new-attempt-open'));
    const options = [...screen.getByTestId('new-attempt-provider').querySelectorAll('option')].map((o) => o.value);
    expect(options).toEqual(['claude']);
    expect([...screen.getByTestId('new-attempt-profile').querySelectorAll('option')].map((o) => o.value)).toEqual(['explorar', 'proponer', 'delegar_con_revision']);
  });

  it('crea la Task con su Attempt y avisa de los ids que devolvió el Core', async () => {
    const calls = mount();
    const onCreated = vi.fn();
    render(<NewAttemptForm projectId="p1" coreModel={V1} onCreated={onCreated} />);
    await flush();
    await openAndFill();
    fireEvent.change(screen.getByTestId('new-attempt-profile'), { target: { value: 'proponer' } });
    fireEvent.change(screen.getByTestId('new-attempt-model'), { target: { value: 'haiku' } });
    expect(screen.getByTestId('new-attempt-submit').disabled).toBe(false);
    fireEvent.click(screen.getByTestId('new-attempt-submit'));
    await flush();

    const [call] = creates(calls);
    expect(call.payload.args).toMatchObject({
      project_id: 'p1', title: 'Arreglar el login', objective: 'Arreglar el login', spec: 'Revisa el flujo de login',
      attempt: { provider: 'claude', profile: 'proponer', model: 'haiku' },
    });
    expect(call.payload.args.request_id).toMatch(/^ade-/);
    expect(onCreated).toHaveBeenCalledWith({ projectId: 'p1', taskId: 't9', attemptId: 't9-a1', status: 'Committed' });
    // El formulario se cierra y se vacía: crear no deja el intento a medio escribir.
    expect(screen.queryByTestId('new-attempt-form')).toBeNull();
  });

  it('no deja crear sin título ni instrucciones', async () => {
    mount();
    render(<NewAttemptForm projectId="p1" coreModel={V1} onCreated={vi.fn()} />);
    await flush();
    fireEvent.click(screen.getByTestId('new-attempt-open'));
    expect(screen.getByTestId('new-attempt-submit').disabled).toBe(true);
    fireEvent.change(screen.getByTestId('new-attempt-title'), { target: { value: 'solo título' } });
    expect(screen.getByTestId('new-attempt-submit').disabled).toBe(true);
  });

  it('con el Orquestador desactivado lo dice en llano y no navega', async () => {
    mount({ create: () => { throw new Error('task.create con Attempt requiere el lifecycle de lanzamiento verificado'); } });
    const onCreated = vi.fn();
    render(<NewAttemptForm projectId="p1" coreModel={V1} onCreated={onCreated} />);
    await flush();
    await openAndFill();
    fireEvent.click(screen.getByTestId('new-attempt-submit'));
    await flush();
    expect(screen.getByTestId('new-attempt-error').textContent).toMatch(/Orquestador está desactivado/);
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByTestId('new-attempt-form')).toBeTruthy();
  });

  it('reintentar tras un fallo reutiliza la misma clave: no duplica la Task', async () => {
    let fail = true;
    const calls = mount({ create: () => { if (fail) throw new Error('fallo de red'); return { status: 'Replayed', run_id: 'r1', task_id: 't9', attempt_id: 't9-a1' }; } });
    render(<NewAttemptForm projectId="p1" coreModel={V1} onCreated={vi.fn()} />);
    await flush();
    await openAndFill();
    fireEvent.click(screen.getByTestId('new-attempt-submit'));
    await flush();
    fail = false;
    fireEvent.click(screen.getByTestId('new-attempt-submit'));
    await flush();
    const ids = creates(calls).map((c) => c.payload.args.request_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });
});
