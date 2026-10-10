import { describe, it, expect } from 'vitest';
import { computePtySize, ORCH_PTY_MIN_COLS } from './orchTermSize';

describe('computePtySize', () => {
  it('el mínimo es 200 columnas', () => expect(ORCH_PTY_MIN_COLS).toBe(200));
  for (const n of [40, 60, 76, 250]) {
    it(`panel de ${n} columnas manda max(200, ${n})`, () => {
      expect(computePtySize(n, 30)).toEqual({ cols: Math.max(200, n), rows: 30 });
    });
  }
  it('las filas siguen al panel', () => expect(computePtySize(40, 12).rows).toBe(12));
  it('valores inválidos no bajan del mínimo', () => {
    expect(computePtySize(NaN, NaN)).toEqual({ cols: 200, rows: 1 });
    expect(computePtySize(undefined, 0)).toEqual({ cols: 200, rows: 1 });
  });
});
