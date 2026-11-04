import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AttemptDetail } from './AttemptDetail';
import { resetOutstandingQueries } from './coreQueryPolicy';
import { coreModelFromState } from './useCoreModel';
import { CANONICAL, attemptDetail } from './testFixtures/coreModelFixtures';
import { attemptActivityPage } from './testFixtures/attemptActivityFixtures';
import { live, liveWith, provider } from './testFixtures/providerCapabilitiesFixtures';

// LXO-151 / LXO-152 · compositor de un intento ocupado (Queue explícito) y Pending Queue Dock.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const V1 = coreModelFromState({ data: CANONICAL['core_model.v1.json'], error: null });
const tick = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
// El detalle se pinta primero y solo entonces arrancan las lecturas de la cola y de las capacidades: se espera a que todo se asiente.
const flush = async () => { for (let i = 0; i < 4; i += 1) await tick(); };
afterEach(() => { cleanup(); invoke.mockReset(); resetOutstandingQueries(); });

/** Un item con la forma que manda el Core (`pending_queue`). */
const item = (n, over = {}) => ({
  queue_id: `t3-a1-q${n}`, seq: n, author_kind: 'person', body: `instrucción ${n}`, status: 'queued', failure: null, confirmed_by: null,
  created_at: 1_792_000_000_000 + n * 1000, delivered_at: null, ended_at: null, ...over,
});
const pendingQueue = ({ items = [], finished = [] } = {}) => ({
  v: 1, attempt_id: 't3-a1', task_id: 't3',
  items: items.map((it, i) => ({ ...it, position: i + 1 })), finished, finished_limit: 20,
});

/** Un Core de pruebas. `queue` es la respuesta (o una función) de `pending_queue`; `decide` responde a las órdenes. */
function mountCore({ status = 'running', provider: attemptProvider = 'fake-completo', caps = live(), queue = pendingQueue(), decide = () => ({ status: 'Queued', attempt_id: 't3-a1', queue_id: 't3-a1-q1', position: 1 }) } = {}) {
  const calls = [];
  invoke.mockImplementation(async (command, payload) => {
    calls.push({ command, payload });
    if (command === 'orch_call') return decide(payload);
    if (payload.query === 'provider_capabilities') return caps;
    if (payload.query === 'activity_list') return attemptActivityPage([]);
    if (payload.query === 'attempts_by_task') return { ...CANONICAL['attempts_by_task.v1.json'], task_id: 't3', items: [] };
    if (payload.query === 'pending_queue') return typeof queue === 'function' ? queue() : queue;
    return attemptDetail({ id: 't3-a1', task_id: 't3', n: 1, status, provider: attemptProvider });
  });
  return calls;
}
const mount = () => render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
const sent = (calls) => calls.filter((c) => c.command === 'orch_call').map((c) => c.payload);
const queueReads = (calls) => calls.filter((c) => c.payload?.query === 'pending_queue').length;
const write = (text) => fireEvent.change(screen.getByTestId('aq-text'), { target: { value: text } });
const enter = (shiftKey = false) => fireEvent.keyDown(screen.getByTestId('aq-text'), { key: 'Enter', shiftKey });

describe('Compositor de un intento ocupado (LXO-151)', () => {
  it('solo hay compositor con el intento en ejecución; sin cola no aparece nada en otro estado', async () => {
    mountCore({ status: 'running' });
    const first = mount();
    await flush();
    expect(screen.getByTestId('aq-composer')).toBeTruthy();
    first.unmount();
    for (const status of ['pending_approval', 'done', 'failed', 'stopped', 'waiting']) {
      mountCore({ status });
      const { unmount } = mount();
      await flush();
      expect(screen.queryByTestId('aq-composer'), status).toBeNull();
      expect(screen.queryByTestId('attempt-queue'), status).toBeNull();
      unmount();
    }
  });

  it('dice qué hace Enter: Encolar activo por defecto y Steer / Detener y enviar disponibles solo si el proveedor los ofrece', async () => {
    const calls = mountCore();
    mount();
    await flush();
    expect(screen.getByTestId('aq-mode-queue').checked).toBe(true);
    for (const id of ['aq-mode-steer', 'aq-mode-stop-send']) {
      const radio = screen.getByTestId(id);
      expect(radio.disabled, id).toBe(false);
      expect(radio.checked, id).toBe(false);
    }
    expect(screen.getByTestId('aq-enter-hint').textContent).toMatch(/Enter encola.*Shift\+Enter inserta un salto de línea.*nunca en mitad de él/);
    expect(screen.getByTestId('aq-send').textContent).toBe('Encolar');
    expect(sent(calls)).toEqual([]);
  });

  it('Enter encola con el intento exacto, una clave de idempotencia y el texto sin espacios sobrantes; vacía el borrador', async () => {
    const calls = mountCore();
    mount();
    await flush();
    write('  sigue con la parte dos  ');
    enter();
    await flush();
    const [call] = sent(calls);
    expect(call.cmd).toBe('attempt_queue');
    expect(call.args).toMatchObject({ attempt_id: 't3-a1', body: 'sigue con la parte dos' });
    expect(call.args.request_id).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
    expect(screen.getByTestId('aq-sent').textContent).toMatch(/Encolada \(posición 1\).*siguiente turno/);
    expect(screen.getByTestId('aq-text').value).toBe('');
  });

  it('Shift+Enter no envía y un borrador vacío o en blanco tampoco', async () => {
    const calls = mountCore();
    mount();
    await flush();
    write('una línea');
    enter(true);
    await flush();
    write('   ');
    enter();
    expect(screen.getByTestId('aq-send').disabled).toBe(true);
    await flush();
    expect(sent(calls)).toEqual([]);
  });

  it('un rechazo conserva el borrador y reutiliza la clave mientras el texto no cambie; texto distinto, clave nueva', async () => {
    let fail = true;
    const calls = mountCore({ decide: () => { if (fail) throw new Error('queue_full: el Attempt ya tiene 50 instrucciones pendientes'); return { status: 'Queued', queue_id: 't3-a1-q1', position: 1 }; } });
    mount();
    await flush();
    write('mi instrucción');
    enter();
    await flush();
    expect(screen.getByTestId('aq-error').textContent).toContain('La cola está llena');
    expect(screen.getByTestId('aq-text').value).toBe('mi instrucción');
    // Reintento con el mismo texto: la MISMA clave (el Core devolvería el mismo item, no un duplicado).
    enter();
    await flush();
    const keys = sent(calls).map((c) => c.args.request_id);
    expect(keys[0]).toBe(keys[1]);
    // Otro texto: es otra instrucción, y reutilizar la clave sería un conflicto.
    write('otra instrucción');
    enter();
    await flush();
    expect(sent(calls)[2].args.request_id).not.toBe(keys[0]);
    // Cuando por fin entra, el borrador se vacía.
    fail = false;
    enter();
    await flush();
    expect(screen.getByTestId('aq-text').value).toBe('');
    expect(screen.queryByTestId('aq-error')).toBeNull();
  });

  it('una instrucción que ya estaba en la cola se dice como tal', async () => {
    mountCore({ decide: () => ({ status: 'Replayed', queue_id: 't3-a1-q1', position: null }) });
    mount();
    await flush();
    write('repetida');
    enter();
    await flush();
    expect(screen.getByTestId('aq-sent').textContent).toBe('Esta instrucción ya estaba en la cola.');
  });

  it('con un proveedor que no ofrece nada de esto no se puede enviar y se dice por qué', async () => {
    const calls = mountCore({ provider: 'fake-parcial' });
    mount();
    await flush();
    expect(screen.getByTestId('aq-blocked').textContent).toMatch(/fake-parcial no puede recibir instrucciones con un intento en marcha/);
    for (const id of ['aq-mode-queue', 'aq-mode-steer', 'aq-mode-stop-send']) expect(screen.getByTestId(id).disabled, id).toBe(true);
    expect(screen.getByTestId('aq-text').disabled).toBe(true);
    expect(screen.getByTestId('aq-send').disabled).toBe(true);
    expect(sent(calls)).toEqual([]);
  });

  it('un modo que el proveedor no ofrece sale desactivado con la razón del Core y NUNCA cae a otro: Enter sigue encolando', async () => {
    const calls = mountCore({ provider: 'sin-steer', caps: liveWith([provider('sin-steer', { steer: 'unsupported' })]) });
    mount();
    await flush();
    const steer = screen.getByTestId('aq-mode-steer');
    expect(steer.disabled).toBe(true);
    expect(screen.getByTestId('attempt-queue').textContent).toMatch(/sin-steer no ofrece «Dirigir en curso»/);
    expect(screen.getByTestId('aq-mode-queue').checked).toBe(true);
    expect(screen.getByTestId('aq-mode-stop-send').disabled).toBe(false);
    write('sigue');
    enter();
    await flush();
    expect(sent(calls).map((c) => c.cmd)).toEqual(['attempt_queue']);
  });

  it('si el modo elegido deja de estar disponible se pasa al primero que sí lo está y el botón lo dice', async () => {
    mountCore({ provider: 'solo-steer', caps: liveWith([provider('solo-steer', { resume: 'unsupported' })]) });
    mount();
    await flush();
    expect(screen.getByTestId('aq-mode-queue').disabled).toBe(true);
    expect(screen.getByTestId('aq-mode-stop-send').disabled).toBe(true);
    expect(screen.getByTestId('aq-mode-steer').checked).toBe(true);
    expect(screen.getByTestId('aq-send').textContent).toBe('Steer');
    expect(screen.queryByTestId('aq-blocked')).toBeNull();
  });

  it('Steer: elegirlo cambia lo que hace Enter y manda attempt_steer, no la cola, con una clave de idempotencia', async () => {
    const calls = mountCore({ decide: () => ({ status: 'Delivered', mode: 'steer', attempt_id: 't3-a1', request_id: 'x' }) });
    mount();
    await flush();
    fireEvent.click(screen.getByTestId('aq-mode-steer'));
    expect(screen.getByTestId('aq-enter-hint').textContent).toMatch(/Enter inyecta la instrucción en el turno en curso.*No pasa por la cola/);
    write('  usa la rama develop  ');
    enter();
    await flush();
    const [call] = sent(calls);
    expect(call.cmd).toBe('attempt_steer');
    expect(call.args).toMatchObject({ attempt_id: 't3-a1', body: 'usa la rama develop' });
    expect(call.args.request_id).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
    expect(sent(calls).length).toBe(1);
    expect(screen.getByTestId('aq-sent').textContent).toBe('Instrucción inyectada en el turno en curso.');
    expect(screen.getByTestId('aq-text').value).toBe('');
  });

  it('Detener y enviar interrumpe el turno: pide confirmación y no manda nada hasta confirmarla', async () => {
    const calls = mountCore({ decide: () => ({ status: 'Delivered', mode: 'stop_and_send', attempt_id: 't3-a1', request_id: 'x' }) });
    mount();
    await flush();
    fireEvent.click(screen.getByTestId('aq-mode-stop-send'));
    write('para y rehaz el informe');
    enter();
    await flush();
    expect(screen.getByTestId('aq-confirm').textContent).toMatch(/interrumpe el turno en curso.*solo enviará la instrucción cuando el proveedor confirme la parada/);
    expect(sent(calls)).toEqual([]);
    // Cancelar la confirmación no envía nada y conserva el borrador.
    fireEvent.click(screen.getByTestId('aq-confirm-no'));
    expect(screen.queryByTestId('aq-confirm')).toBeNull();
    expect(screen.getByTestId('aq-text').value).toBe('para y rehaz el informe');
    expect(sent(calls)).toEqual([]);
    enter();
    await flush();
    fireEvent.click(screen.getByTestId('aq-confirm-yes'));
    await flush();
    expect(sent(calls).map((c) => c.cmd)).toEqual(['attempt_stop_and_send']);
    expect(sent(calls)[0].args).toMatchObject({ attempt_id: 't3-a1', body: 'para y rehaz el informe' });
    expect(screen.getByTestId('aq-sent').textContent).toBe('Turno detenido e instrucción enviada como turno nuevo.');
    expect(screen.queryByTestId('aq-confirm')).toBeNull();
  });

  it('un stop que no se confirma se dice como lo que es: no se envió nada y el borrador se conserva', async () => {
    mountCore({ decide: () => { throw new Error('failed/stop_timeout: el proveedor no confirmó el stop a tiempo: no se envió nada'); } });
    mount();
    await flush();
    fireEvent.click(screen.getByTestId('aq-mode-stop-send'));
    write('rehaz');
    enter();
    await flush();
    fireEvent.click(screen.getByTestId('aq-confirm-yes'));
    await flush();
    expect(screen.getByTestId('aq-error').textContent).toContain('no se envió la instrucción y el intento sigue');
    expect(screen.queryByTestId('aq-sent')).toBeNull();
    expect(screen.getByTestId('aq-text').value).toBe('rehaz');
  });

  it('un fallo que el Core da por resuelto lleva clave nueva en el siguiente envío; una repetición se dice como tal', async () => {
    let step = 0;
    const calls = mountCore({
      decide: () => {
        step += 1;
        if (step === 1) throw new Error('failed/steer_failed: el proveedor no pudo recibirlo');
        return { status: step === 2 ? 'Delivered' : 'Replayed', mode: 'steer' };
      },
    });
    mount();
    await flush();
    fireEvent.click(screen.getByTestId('aq-mode-steer'));
    write('inténtalo');
    enter();
    await flush();
    expect(screen.getByTestId('aq-error').textContent).toContain('no aceptó la instrucción');
    enter();
    await flush();
    const keys = sent(calls).map((c) => c.args.request_id);
    expect(keys[0]).not.toBe(keys[1]);
    write('otra vez');
    enter();
    await flush();
    expect(screen.getByTestId('aq-sent').textContent).toBe('Esta instrucción ya se había enviado.');
  });
});

describe('Pending Queue Dock (LXO-152)', () => {
  it('0 / 1 / N pendientes: el contador y el orden son los del Core', async () => {
    mountCore({ queue: pendingQueue() });
    const none = mount();
    await flush();
    expect(screen.getByTestId('aq-count').textContent).toBe('0 pendientes');
    expect(screen.queryByTestId('aq-pending')).toBeNull();
    none.unmount();

    mountCore({ queue: pendingQueue({ items: [item(1)] }) });
    const one = mount();
    await flush();
    expect(screen.getByTestId('aq-count').textContent).toBe('1 pendiente');
    one.unmount();

    mountCore({ queue: pendingQueue({ items: [item(1), item(2, { status: 'delivering' }), item(3)] }) });
    mount();
    await flush();
    expect(screen.getByTestId('aq-count').textContent).toBe('3 pendientes');
    const rows = within(screen.getByTestId('aq-pending')).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual(['aq-item-t3-a1-q1', 'aq-item-t3-a1-q2', 'aq-item-t3-a1-q3']);
    expect(rows[0].textContent).toMatch(/#1.*En cola.*Tú/);
    expect(rows[1].textContent).toMatch(/#2.*Entregando/);
  });

  it('solo lo que está en cola se puede cancelar; lo que se está entregando, no', async () => {
    mountCore({ queue: pendingQueue({ items: [item(1), item(2, { status: 'delivering' })] }) });
    mount();
    await flush();
    expect(screen.getByTestId('aq-cancel-t3-a1-q1').getAttribute('aria-label')).toBe('Cancelar la instrucción 1');
    expect(screen.queryByTestId('aq-cancel-t3-a1-q2')).toBeNull();
    expect(screen.getByTestId('aq-item-t3-a1-q2').textContent).toMatch(/Se está entregando: ya no se puede cancelar/);
  });

  it('cancelar manda la orden con el item exacto y vuelve a leer la cola del Core', async () => {
    let cancelled = false;
    const calls = mountCore({
      queue: () => pendingQueue({ items: cancelled ? [] : [item(1)], finished: cancelled ? [item(1, { status: 'cancelled', ended_at: 1_792_000_005_000 })] : [] }),
      decide: () => { cancelled = true; return { status: 'Cancelled', queue_id: 't3-a1-q1' }; },
    });
    mount();
    await flush();
    const before = queueReads(calls);
    fireEvent.click(screen.getByTestId('aq-cancel-t3-a1-q1'));
    await flush();
    expect(sent(calls)).toEqual([{ cmd: 'attempt_queue_cancel', args: { queue_id: 't3-a1-q1' } }]);
    expect(queueReads(calls)).toBeGreaterThan(before);
    expect(screen.getByTestId('aq-count').textContent).toBe('0 pendientes');
    // Lo cancelado va al historial como cancelado: NUNCA como entregado.
    const row = screen.getByTestId('aq-item-t3-a1-q1');
    expect(row.getAttribute('data-status')).toBe('cancelled');
    expect(row.textContent).toContain('Cancelada');
    expect(row.textContent).not.toContain('Entregada');
  });

  it('cancelar en carrera con la entrega se dice en llano y deja la cola como la dice el Core', async () => {
    const calls = mountCore({
      queue: pendingQueue({ items: [item(1)] }),
      decide: () => { throw new Error('invalid/not_cancellable: el item t3-a1-q1 está delivering: ya no se puede cancelar'); },
    });
    mount();
    await flush();
    fireEvent.click(screen.getByTestId('aq-cancel-t3-a1-q1'));
    await flush();
    expect(screen.getByTestId('aq-cancel-error').textContent).toContain('Esa instrucción ya no se puede cancelar');
    expect(queueReads(calls)).toBeGreaterThan(1);
  });

  it('el historial muestra entregadas, canceladas y fallidas, cada una con lo que el Core dijo, y el fallo con su razón accionable', async () => {
    const reasons = ['unsupported', 'environment_blocked', 'adapter_unavailable', 'adapter_error', 'attempt_ended', 'interrupted'];
    const finished = [
      item(1, { status: 'delivered', confirmed_by: 'adapter_result', delivered_at: 1_792_000_003_000, ended_at: 1_792_000_003_000 }),
      item(2, { status: 'cancelled', ended_at: 1_792_000_004_000 }),
      ...reasons.map((failure, i) => item(3 + i, { status: 'failed', failure, ended_at: 1_792_000_005_000 + i })),
    ];
    mountCore({ status: 'done', queue: pendingQueue({ finished }) });
    mount();
    await flush();
    const history = screen.getByTestId('aq-finished');
    expect(history.querySelector('summary').textContent).toBe('Historial (8)');
    expect(screen.getByTestId('aq-item-t3-a1-q1').textContent).toContain('Entregada');
    expect(screen.getByTestId('aq-item-t3-a1-q2').textContent).toContain('Cancelada');
    expect(screen.getByTestId('aq-item-t3-a1-q2').textContent).not.toContain('Entregada');
    expect(screen.getByTestId('aq-reason-t3-a1-q3').textContent).toMatch(/no puede entregar instrucciones entre turnos/);
    expect(screen.getByTestId('aq-reason-t3-a1-q4').textContent).toMatch(/entorno del proveedor está bloqueado/);
    expect(screen.getByTestId('aq-reason-t3-a1-q5').textContent).toMatch(/No llegó al proveedor/);
    expect(screen.getByTestId('aq-reason-t3-a1-q6').textContent).toMatch(/devolvió un error/);
    expect(screen.getByTestId('aq-reason-t3-a1-q7').textContent).toMatch(/intento terminó antes de entregarla/);
    expect(screen.getByTestId('aq-reason-t3-a1-q8').textContent).toMatch(/no se sabe si llegó y no se reintenta/);
    // Un intento terminado no tiene compositor, pero su historial se sigue viendo.
    expect(screen.queryByTestId('aq-composer')).toBeNull();
  });

  it('el contenido se muestra como texto (nunca como HTML) y un cuerpo largo se recorta en la vista previa', async () => {
    const hostile = '<img src=x onerror="alert(1)"><b>negrita</b>';
    mountCore({ queue: pendingQueue({ items: [item(1, { body: hostile }), item(2, { body: 'x'.repeat(500) })] }) });
    mount();
    await flush();
    const first = screen.getByTestId('aq-item-t3-a1-q1');
    expect(first.querySelector('img')).toBeNull();
    expect(first.querySelector('b')).toBeNull();
    expect(first.textContent).toContain(hostile);
    const long = screen.getByTestId('aq-item-t3-a1-q2').querySelector('.aq__body').textContent;
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBe(281);
  });

  it('una respuesta fuera del contrato no se pinta: ni una entrega sin confirmación del adapter ni un orden distinto al del Core', async () => {
    mountCore({ queue: pendingQueue({ finished: [item(1, { status: 'delivered', confirmed_by: null })] }) });
    const bad = mount();
    await flush();
    expect(screen.queryByTestId('aq-finished')).toBeNull();
    expect(screen.getByTestId('aq-read-error')).toBeTruthy();
    bad.unmount();

    mountCore({ queue: { ...pendingQueue({ items: [item(1), item(2)] }), items: [{ ...item(1), position: 2 }, { ...item(2), position: 1 }] } });
    mount();
    await flush();
    expect(screen.queryByTestId('aq-pending')).toBeNull();
    expect(screen.getByTestId('aq-read-error')).toBeTruthy();
  });
});
