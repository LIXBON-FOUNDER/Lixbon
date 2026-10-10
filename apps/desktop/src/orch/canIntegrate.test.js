import { describe, it, expect } from 'vitest';
import { canIntegrate, integrationTarget, INTEGRATE_INTO_FALLBACK } from './canIntegrate';

const t = (o = {}) => ({ id: 't1', parent: 'coord', status: 'done', branch: 'lxo/t1', ...o });
const snap = (o = {}) => ({ tasks: { coord: { id: 'coord', branch: 'lxo/coord' } }, ...o });

describe('canIntegrate', () => {
  it('done, hija, con rama y sin integrar: sí', () => expect(canIntegrate(t(), snap())).toBe(true));
  it('failed, stopped, exited, running: no', () => {
    for (const status of ['failed', 'stopped', 'exited', 'running']) expect(canIntegrate(t({ status }), snap())).toBe(false);
  });
  it('coordinador (sin padre): no', () => expect(canIntegrate(t({ parent: null }), snap())).toBe(false));
  it('sin rama: no', () => expect(canIntegrate(t({ branch: '' }), snap())).toBe(false));
  it('ya integrada por campo merged: no', () => expect(canIntegrate(t({ merged: true }), snap())).toBe(false));
  it('ya integrada por decisión merge/merged en snap.decisions: no', () => {
    const decisions = [{ id: 1, task: 't1', kind: 'merge', actor: 'human', detail_json: JSON.stringify({ outcome: 'merged' }) }];
    expect(canIntegrate(t(), snap({ decisions }))).toBe(false);
  });
  it('una decisión merge con conflicto u otra tarea no la bloquea', () => {
    const decisions = [
      { id: 1, task: 't1', kind: 'merge', detail_json: JSON.stringify({ outcome: 'conflict' }) },
      { id: 2, task: 'otra', kind: 'merge', detail_json: JSON.stringify({ outcome: 'merged' }) },
    ];
    expect(canIntegrate(t(), snap({ decisions }))).toBe(true);
  });
});

describe('integrationTarget', () => {
  it('usa integrate_into del host', () => expect(integrationTarget(t({ integrate_into: 'master' }), snap())).toBe('master'));
  it('sin integrate_into: rama del padre', () => expect(integrationTarget(t(), snap())).toBe('lxo/coord'));
  it('sin nada: texto genérico', () => expect(integrationTarget(t(), { tasks: {} })).toBe(INTEGRATE_INTO_FALLBACK));
});
