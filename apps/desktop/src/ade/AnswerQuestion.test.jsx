import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { TaskWorkspaceView } from './TaskWorkspace';

// `answer` · la persona responde desde el ADE a la pregunta abierta de un agente (RPC `reply`).
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
afterEach(() => { cleanup(); invoke.mockReset(); });

const TASK = {
  id: 't3', project_id: 'p1', title: 'Hija', status: 'waiting', run_id: 'r1', parent_id: 't1', root_id: 't1', provider: 'claude', model: 'haiku',
  created_at: 1_000, updated_at: 2_000, child_ids: [], phase: null, cwd: '/w', branch: 'lx/r1/t3', worktree: '/w', merged: false, review: null, integration: null, failure_reason: null,
  messages: [
    { id: 7, kind: 'question', from: 't3', to: 't1', body: '¿qué rama uso?' },
    { id: 8, kind: 'question', from: 't3', to: 't1', body: '¿y las pruebas?' },
    { id: 9, kind: 'reply', from: 't1', to: 't3', body: 'main', reply_to: 8 },
  ],
};
const mount = (retry = vi.fn()) => {
  render(<TaskWorkspaceView projectId="p1" taskId="t3" detail={{ status: 'ready', data: { task: TASK }, error: null, retry }} />);
  return retry;
};

describe('AnswerQuestion', () => {
  it('solo las preguntas sin respuesta ofrecen responder', () => {
    mount();
    expect(screen.getAllByTestId('answer-open')).toHaveLength(1);
    expect(screen.getByTestId('answer-7')).toBeTruthy();
    expect(screen.queryByTestId('answer-8')).toBeNull();
  });

  it('dice en nombre de quién responde y no manda nada hasta enviar', () => {
    mount();
    fireEvent.click(screen.getByTestId('answer-open'));
    expect(screen.getByTestId('answer-7').textContent).toMatch(/Respondes como t1: le llega a t3/);
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.getByTestId('answer-send').disabled).toBe(true);
  });

  it('envía reply con el id numérico de la pregunta y vuelve a leer el detalle', async () => {
    invoke.mockResolvedValue({ reply: 10 });
    const retry = mount();
    fireEvent.click(screen.getByTestId('answer-open'));
    fireEvent.change(screen.getByTestId('answer-text'), { target: { value: '  usa main  ' } });
    fireEvent.click(screen.getByTestId('answer-send'));
    await flush();
    expect(invoke).toHaveBeenCalledWith('orch_call', { cmd: 'reply', args: { question: 7, answer: 'usa main' } });
    expect(screen.getByTestId('answer-sent').textContent).toBe('Respuesta enviada.');
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('un rechazo del Core se dice en llano y deja reintentar', async () => {
    invoke.mockRejectedValue(new Error('La pregunta 7 ya tiene respuesta'));
    const retry = mount();
    fireEvent.click(screen.getByTestId('answer-open'));
    fireEvent.change(screen.getByTestId('answer-text'), { target: { value: 'main' } });
    fireEvent.click(screen.getByTestId('answer-send'));
    await flush();
    expect(screen.getByTestId('answer-error').textContent).toContain('Esta pregunta ya tiene respuesta.');
    expect(screen.getByTestId('answer-send').disabled).toBe(false);
    expect(retry).not.toHaveBeenCalled();
  });

  it('cancelar cierra el formulario sin enviar', () => {
    mount();
    fireEvent.click(screen.getByTestId('answer-open'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.getByTestId('answer-open')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });
});
