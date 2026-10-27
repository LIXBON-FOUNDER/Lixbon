import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { attemptEvent } from './testFixtures/attemptActivityFixtures';

// LXO-121 · Con el límite simulado en 20, el aviso debe decir 20: así se detecta un número fijo.
vi.mock('./attemptActivityLimit', () => ({ ATTEMPT_ACTIVITY_LIMIT: 20 }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const { AttemptActivity } = await import('./AttemptActivity');
const { coreModelFromState } = await import('./useCoreModel');
const { CANONICAL } = await import('./testFixtures/coreModelFixtures');
const V1 = coreModelFromState({ data: CANONICAL['core_model.v1.json'], error: null });
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
afterEach(() => { cleanup(); invoke.mockReset(); });

describe('AttemptActivity: el aviso usa ATTEMPT_ACTIVITY_LIMIT (LXO-121)', () => {
  it('con límite 20 pide 20 y el aviso dice 20', async () => {
    const calls = [];
    const events = Array.from({ length: 20 }, (_, k) => attemptEvent(21 - k, 't3-a2', 'attempt.started', { task: 't3', n: 2 }));
    invoke.mockImplementation(async (command, payload) => {
      calls.push(payload);
      return { v: 1, projection: 1, order: 'desc', items: events, next_cursor: events[19].seq, has_more: true, head_seq: events[0].seq, limit: 20 };
    });
    render(<AttemptActivity attemptId="t3-a2" coreModel={V1} />);
    await flush();
    expect(calls[0].args.limit).toBe(20);
    expect(screen.getByTestId('attempt-activity-truncated').textContent).toBe('Mostrando los 20 eventos más recientes');
  });
});