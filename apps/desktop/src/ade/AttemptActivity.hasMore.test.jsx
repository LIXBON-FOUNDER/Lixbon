import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// El contrato de activity_list (coreQueries) siempre entrega next_cursor; aquí se aísla la
// regla de la UI: el aviso de corte depende solo de has_more, no de next_cursor.
const queryState = { current: null };
vi.mock('./useCoreQuery', () => ({ useCoreQuery: () => queryState.current }));

const { ATTEMPT_ACTIVITY_LIMIT, AttemptActivity } = await import('./AttemptActivity');
const { COPY } = await import('./adeLabels');

const V1 = { vNext: true };
const item = { event_id: 'e1', seq: '1', ts: '2026-10-23T20:00:00Z', message_key: 'activity.attempt.started', args: {} };

afterEach(() => { cleanup(); queryState.current = null; });

describe('AttemptActivity: aviso de corte por has_more (LXO-121)', () => {
  it('has_more=true sin next_cursor avisa con el número de ATTEMPT_ACTIVITY_LIMIT', () => {
    queryState.current = { data: { items: [item], has_more: true }, error: null, retry: () => {} };
    render(<AttemptActivity attemptId="t3-a2" coreModel={V1} />);
    expect(screen.getByTestId('attempt-activity-truncated').textContent)
      .toBe(COPY.attemptActivityTruncated(ATTEMPT_ACTIVITY_LIMIT));
  });

  it('has_more=false con next_cursor no avisa', () => {
    queryState.current = { data: { items: [item], has_more: false, next_cursor: '1' }, error: null, retry: () => {} };
    render(<AttemptActivity attemptId="t3-a2" coreModel={V1} />);
    expect(screen.queryByTestId('attempt-activity-truncated')).toBeNull();
  });
});
