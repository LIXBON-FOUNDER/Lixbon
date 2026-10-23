import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AttemptActivity } from './AttemptActivity';
import { coreModelFromState } from './useCoreModel';
import { CANONICAL } from './testFixtures/coreModelFixtures';
import { attemptActivityPage, attemptEvent } from './testFixtures/attemptActivityFixtures';

// LXO-121 · Solo se simula el transporte (invoke): la página pasa por la validación real de
// coreQueries.js. has_more=true sin next_cursor es una respuesta inválida del Core.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const V1 = coreModelFromState({ data: CANONICAL['core_model.v1.json'], error: null });
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
afterEach(() => { cleanup(); invoke.mockReset(); });

describe('AttemptActivity: has_more sin next_cursor (LXO-121)', () => {
  it('muestra el estado de error y no el aviso de corte', async () => {
    const { ATTEMPT_ACTIVITY_LIMIT } = await import('./attemptActivityLimit');
    const events = Array.from({ length: ATTEMPT_ACTIVITY_LIMIT }, (_, k) => attemptEvent(ATTEMPT_ACTIVITY_LIMIT + 1 - k, 't3-a2', 'attempt.started', { task: 't3', n: 2 }));
    invoke.mockImplementation(async () => ({ ...attemptActivityPage(events), has_more: true, next_cursor: null }));
    render(<AttemptActivity attemptId="t3-a2" coreModel={V1} />);
    await flush();
    const notice = screen.getByRole('alert');
    expect(notice.querySelector('code').textContent).toContain('ade_query_invalid_response: activity_list');
    expect(screen.queryByRole('listitem')).toBeNull();
    expect(screen.queryByTestId('attempt-activity-truncated')).toBeNull();
  });
});