import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ATTEMPT_STATUS_LABELS, TASK_STATE_LABELS, attemptStatusInfo, taskStateInfo } from './adeLabels';
import { StatusText } from './CoreModelNotice';
import { AttentionMark, StatusMark, statusShape } from './StatusMark';

// A4 · el estado se distingue por forma, no solo por color; Attention es otro eje con su propia marca.
afterEach(cleanup);

describe('A4 · forma del estado', () => {
  it('cada estado de un Attempt tiene forma y los que se confunden por color no comparten forma', () => {
    const shapes = Object.fromEntries(Object.keys(ATTEMPT_STATUS_LABELS).map((status) => [status, statusShape(attemptStatusInfo(status))]));
    expect(shapes).toEqual({
      pending_approval: 'queued', starting: 'working', running: 'working', waiting: 'waiting', awaiting_terminal_approval: 'terminal',
      done: 'done', failed: 'failed', stopped: 'stopped', exited: 'offline',
    });
    // Terminado, fallado y cancelado suelen distinguirse solo por verde/rojo/gris: aquí tienen tres formas distintas.
    expect(new Set([shapes.done, shapes.failed, shapes.stopped]).size).toBe(3);
    // Esperar a una persona (reloj) y trabajar (arco) tampoco comparten forma.
    expect(shapes.waiting).not.toBe(shapes.running);
  });

  it('los estados derivados de la Task también tienen forma', () => {
    const shapes = Object.fromEntries(Object.keys(TASK_STATE_LABELS).map((state) => [state, statusShape(taskStateInfo(state))]));
    expect(shapes).toEqual({ open: 'queued', in_progress: 'working', in_review: 'review', integrated: 'done', discarded: 'stopped' });
  });

  it('un valor que el cliente no reconoce es un punto neutro, nunca un estado inventado', () => {
    expect(statusShape(attemptStatusInfo('inventado'))).toBe('unknown');
    expect(statusShape(attemptStatusInfo(undefined))).toBe('unknown');
    expect(statusShape(null)).toBe('unknown');
  });

  it('StatusText pone la marca delante sin cambiar el texto ni exponerla a lectores de pantalla', () => {
    render(<StatusText info={attemptStatusInfo('failed')} prefix="Intento #1 · " />);
    const status = document.querySelector('.ade-status');
    const mark = status.querySelector('.ade-mark');
    expect(mark.getAttribute('data-shape')).toBe('failed');
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    expect(status.textContent).toBe('Intento #1 · Falló');
  });

  it('lo que no es un estado de ejecución puede pedir StatusText sin marca', () => {
    render(<StatusText info={{ label: 'Vigente', tone: 'ok', known: true, raw: 'active' }} mark={false} />);
    expect(document.querySelector('.ade-mark')).toBeNull();
  });

  it('StatusMark acepta un estado ya reconocido sin texto propio', () => {
    const { container } = render(<StatusMark info={{ raw: 'done', known: true }} />);
    expect(container.querySelector('[data-shape=done]')).toBeTruthy();
  });
});

describe('A4 · Attention aparte', () => {
  it('la marca de Attention no es ninguna forma de estado y no añade texto', () => {
    const { container } = render(<span data-testid="host"><AttentionMark /></span>);
    expect(container.querySelector('.ade-attn-mark')).toBeTruthy();
    expect(container.querySelector('.ade-mark')).toBeNull();
    expect(screen.getByTestId('host').textContent).toBe('');
  });
});
