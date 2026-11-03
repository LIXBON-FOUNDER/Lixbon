import { describe, expect, it } from 'vitest';
import { groupAttemptActivity } from './attemptTimeline';
import { attemptEvent } from './testFixtures/attemptActivityFixtures';

// A7 · actividad del intento por tramos de ejecución (el Core no registra turnos del agente).
const ev = (seq, kind, ts) => attemptEvent(seq, 't3-a1', kind, {}, 'info', ts);
const desc = (...events) => [...events].reverse();
const summary = (groups) => groups.map((g) => ({ kind: g.kind, n: g.n, durationMs: g.durationMs, open: g.open, keys: g.items.map((i) => i.message_key.replace('activity.attempt.', '')) }));

describe('groupAttemptActivity', () => {
  it('separa la solicitud del tramo de ejecución y mide cuánto duró', () => {
    const items = desc(ev(1, 'attempt.requested', 1_000), ev(2, 'attempt.approved', 2_000), ev(3, 'attempt.started', 3_000), ev(4, 'attempt.completed', 63_000));
    expect(summary(groupAttemptActivity(items))).toEqual([
      { kind: 'run', n: 1, durationMs: 60_000, open: false, keys: ['completed', 'started'] },
      { kind: 'before', n: null, durationMs: null, open: false, keys: ['approved', 'requested'] },
    ]);
  });

  it('una espera cierra el tramo y reanudar abre otro; el más nuevo va primero', () => {
    const items = desc(
      ev(1, 'attempt.started', 1_000), ev(2, 'attempt.waiting', 11_000), ev(3, 'attempt.resumed', 40_000), ev(4, 'attempt.failed', 100_000),
    );
    const groups = groupAttemptActivity(items);
    expect(summary(groups)).toEqual([
      { kind: 'run', n: 2, durationMs: 60_000, open: false, keys: ['failed', 'resumed'] },
      { kind: 'run', n: 1, durationMs: 10_000, open: false, keys: ['waiting', 'started'] },
    ]);
    expect(groups[0].endKey).toBe('activity.attempt.failed');
  });

  it('un tramo sin evento de cierre sigue abierto y no inventa duración', () => {
    const groups = groupAttemptActivity(desc(ev(1, 'attempt.approved', 1_000), ev(2, 'attempt.started', 2_000)));
    expect(summary(groups)[0]).toEqual({ kind: 'run', n: 1, durationMs: null, open: true, keys: ['started'] });
  });

  it('lo que llega después de cerrarse el tramo va aparte, sin duración', () => {
    const groups = groupAttemptActivity(desc(ev(1, 'attempt.started', 1_000), ev(2, 'attempt.completed', 5_000), ev(3, 'attempt.integrated', 9_000)));
    expect(summary(groups)).toEqual([
      { kind: 'after', n: null, durationMs: null, open: false, keys: ['integrated'] },
      { kind: 'run', n: 1, durationMs: 4_000, open: false, keys: ['completed', 'started'] },
    ]);
  });

  it('un cierre tras una espera (p. ej. detener) es el cierre, no «después»', () => {
    const groups = groupAttemptActivity(desc(ev(1, 'attempt.started', 1_000), ev(2, 'attempt.waiting', 5_000), ev(3, 'attempt.stopped', 9_000)));
    expect(summary(groups)).toEqual([
      { kind: 'closing', n: null, durationMs: null, open: false, keys: ['stopped'] },
      { kind: 'run', n: 1, durationMs: 4_000, open: false, keys: ['waiting', 'started'] },
    ]);
  });

  it('con marcas de tiempo inválidas no hay duración y con una clave desconocida no se rompe', () => {
    const groups = groupAttemptActivity(desc(ev(1, 'attempt.started', null), ev(2, 'attempt.futuro', 2_000), ev(3, 'attempt.stopped', 3_000)));
    expect(groups[0].durationMs).toBeNull();
    expect(groups[0].items).toHaveLength(3);
  });

  it('sin eventos, o con algo que no es una lista, no hay grupos', () => {
    expect(groupAttemptActivity([])).toEqual([]);
    expect(groupAttemptActivity(null)).toEqual([]);
  });
});
