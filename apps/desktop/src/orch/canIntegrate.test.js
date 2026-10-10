import { describe, it, expect } from 'vitest';
import { canIntegrate, isMerged, mergedCommitShort, integrationTarget, INTEGRATE_INTO_FALLBACK } from './canIntegrate';

const t = (o = {}) => ({ id: 't1', parent: 'coord', status: 'done', branch: 'lxo/t1', ...o });
const snap = (o = {}) => ({ tasks: { coord: { id: 'coord', branch: 'lxo/coord' } }, ...o });

describe('canIntegrate', () => {
  it('done, hija, con rama y sin integrar: sí', () => expect(canIntegrate(t(), snap())).toBe(true));
  it('failed, stopped, exited, running: no', () => {
    for (const status of ['failed', 'stopped', 'exited', 'running']) expect(canIntegrate(t({ status }), snap())).toBe(false);
  });
  it('coordinador (sin padre): no', () => expect(canIntegrate(t({ parent: null }), snap())).toBe(false));
  it('sin rama: no', () => expect(canIntegrate(t({ branch: '' }), snap())).toBe(false));
  const li = (outcome, result_commit = null) => ({ outcome, result_commit, at: '2026-10-09T12:00:00Z' });
  it('ya integrada por last_integration merged: no', () =>
    expect(canIntegrate(t({ last_integration: li('merged', 'abcdef1234567') }), snap())).toBe(false));
  it('last_integration conflict o error no la bloquea', () => {
    for (const o of ['conflict', 'error']) expect(canIntegrate(t({ last_integration: li(o) }), snap())).toBe(true);
  });
  it('last_integration null y sin merged: sí', () => expect(canIntegrate(t({ last_integration: null }), snap())).toBe(true));
  it('last_integration null manda sobre merged del respaldo', () =>
    expect(canIntegrate(t({ last_integration: null, merged: true }), snap())).toBe(true));
  it('sin last_integration (undefined): respaldo en task.merged', () => {
    expect(canIntegrate(t({ merged: true }), snap())).toBe(false);
    expect(canIntegrate(t({ merged: false }), snap())).toBe(true);
  });
  it('last_integration conflict manda sobre merged del respaldo', () =>
    expect(canIntegrate(t({ last_integration: li('conflict'), merged: true }), snap())).toBe(true));
  it('ignora decisions aunque vengan en la snapshot', () => {
    const decisions = [{ task: 't1', kind: 'merge', detail_json: JSON.stringify({ outcome: 'merged' }) }];
    expect(canIntegrate(t({ last_integration: null }), snap({ decisions }))).toBe(true);
  });
});

describe('mergedCommitShort', () => {
  it('hash corto si merged', () =>
    expect(mergedCommitShort(t({ last_integration: { outcome: 'merged', result_commit: 'abcdef1234567', at: 'x' } }))).toBe('abcdef1'));
  it('null en conflicto, sin commit o sin campo', () => {
    expect(mergedCommitShort(t({ last_integration: { outcome: 'conflict', result_commit: null, at: 'x' } }))).toBe(null);
    expect(mergedCommitShort(t({ last_integration: { outcome: 'merged', result_commit: null, at: 'x' } }))).toBe(null);
    expect(mergedCommitShort(t({ merged: true }))).toBe(null);
  });
  it('isMerged sigue la misma regla', () => {
    expect(isMerged(t({ last_integration: null, merged: true }))).toBe(false);
    expect(isMerged(t({ merged: true }))).toBe(true);
  });
});

describe('integrationTarget', () => {
  it('usa integrate_into del host', () => expect(integrationTarget(t({ integrate_into: 'master' }), snap())).toBe('master'));
  it('sin integrate_into: rama del padre', () => expect(integrationTarget(t(), snap())).toBe('lxo/coord'));
  it('sin nada: texto genérico', () => expect(integrationTarget(t(), { tasks: {} })).toBe(INTEGRATE_INTO_FALLBACK));
});
