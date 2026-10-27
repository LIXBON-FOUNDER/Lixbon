import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ADE_QUERY_NAMES, queryAdeCore } from './coreQueries';
import { CORE_MODEL_QUERY_SPECS, coreErrorCode, isLegacyModelCode, validAttemptBrief, validAttemptDetail, validTaskV2 } from './coreModelContract';
import { CANONICAL, ERRORS, VARIANTS, attemptDetail } from './testFixtures/coreModelFixtures';

// LXO-120 · contrato vNext (LXO-119) en el cliente: forma, vocabulario y target, contra las fixtures del Core.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('coreModelContract', () => {
  it('las fixtures canónicas se usan byte a byte, sin copias ni ediciones locales', () => {
    for (const [name, value] of Object.entries(CANONICAL)) {
      const bytes = readFileSync(resolve(root, 'docs/core/fixtures/api', name), 'utf8');
      expect(JSON.parse(bytes)).toEqual(value);
    }
    // Construir las variantes no altera las canónicas.
    expect(attemptDetail({ id: 'x' }).attempt.id).toBe('x');
    expect(CANONICAL['attempt_detail.v1.json'].attempt.id).toBe('t3-a1');
    expect(VARIANTS.testOnly).toBe(true);
  });

  it('acepta las cinco respuestas canónicas con el target que les corresponde', () => {
    const specs = CORE_MODEL_QUERY_SPECS;
    expect(specs.core_model.validate(CANONICAL['core_model.v1.json'])).toBeTruthy();
    expect(specs.core_model.validate(VARIANTS.coreModelLegacy)).toBeTruthy();
    expect(specs.task_list_v2.validate(CANONICAL['task_list_v2.json'], { project_id: 'p-1' })).toBeTruthy();
    expect(specs.task_detail_v2.validate(CANONICAL['task_detail_v2.json'], { task_id: 't3' })).toBeTruthy();
    expect(specs.attempts_by_task.validate(CANONICAL['attempts_by_task.v1.json'], { task_id: 't5' })).toBeTruthy();
    expect(specs.attempt_detail.validate(CANONICAL['attempt_detail.v1.json'], { attempt_id: 't3-a1' })).toBeTruthy();
  });

  it('rechaza respuestas de otro target o fuera del contrato', () => {
    const specs = CORE_MODEL_QUERY_SPECS;
    expect(() => specs.task_list_v2.validate(CANONICAL['task_list_v2.json'], { project_id: 'p-2' })).toThrow(/ade_query_invalid_response/);
    expect(() => specs.attempts_by_task.validate(CANONICAL['attempts_by_task.v1.json'], { task_id: 't4' })).toThrow(/no corresponde/);
    expect(() => specs.attempts_by_task.validate({ ...CANONICAL['attempts_by_task.v1.json'], task_id: 't4' }, { task_id: 't4' })).toThrow(/otra Task/);
    expect(() => specs.attempt_detail.validate(CANONICAL['attempt_detail.v1.json'], { attempt_id: 't3-a2' })).toThrow(/no corresponde/);
    expect(() => specs.task_detail_v2.validate(CANONICAL['task_detail_v2.json'], { task_id: 't4' })).toThrow(/no corresponde/);
    expect(() => specs.core_model.validate({ core_model: 'otro', compat: [], queries: [] })).toThrow();
    expect(validTaskV2({ ...VARIANTS.one, attempt_count: 0 })).toBe(false);
    const { provider_session: _ps, ...sinSesion } = CANONICAL['attempt_detail.v1.json'].attempt;
    expect(validAttemptDetail(sinSesion)).toBe(false);
    expect(validAttemptDetail({ ...sinSesion, provider_session: null, worktree: null, artifacts: [], review: null })).toBe(true);
  });

  it('acepta las variantes locales: 0/N Attempts, cancelado, último fallido, descartada y estados no reconocidos', () => {
    for (const key of ['zero', 'one', 'many', 'cancelled', 'lastFailed', 'discarded', 'unknownStatus', 'waiting']) {
      expect(validTaskV2(VARIANTS[key]), key).toBe(true);
    }
    expect(validAttemptBrief(VARIANTS.many.current_attempt, 't3')).toBe(true);
  });

  it('pide exactamente los parámetros del contrato (sin include_discarded) y no cae a otra query', async () => {
    invoke.mockResolvedValueOnce(CANONICAL['task_list_v2.json']);
    await queryAdeCore('task_list_v2', { projectId: 'p-1' });
    expect(invoke).toHaveBeenLastCalledWith('orch_query', { query: 'task_list_v2', args: { project_id: 'p-1', limit: 100 } });
    invoke.mockResolvedValueOnce(CANONICAL['attempt_detail.v1.json']);
    await queryAdeCore('attempt_detail', { attemptId: 't3-a1' });
    expect(invoke).toHaveBeenLastCalledWith('orch_query', { query: 'attempt_detail', args: { attempt_id: 't3-a1' } });
    invoke.mockClear();
    await expect(queryAdeCore('attempt_stop', { attemptId: 't3-a1' })).rejects.toThrow(/ade_query_forbidden/);
    await expect(queryAdeCore('no_existe')).rejects.toThrow(/ade_query_forbidden/);
    expect(invoke).not.toHaveBeenCalled();
    expect(ADE_QUERY_NAMES).toEqual(expect.arrayContaining(['task_detail', 'core_model', 'task_list_v2', 'task_detail_v2', 'attempts_by_task', 'attempt_detail']));
  });

  it('clasifica los errores por su código estructurado', () => {
    expect(coreErrorCode(ERRORS.inactive)).toBe('core_model_inactive');
    expect(coreErrorCode(new Error(ERRORS.notFound))).toBe('model_not_found');
    expect(coreErrorCode(ERRORS.unavailable)).toBe('model_unavailable');
    expect(coreErrorCode(ERRORS.authRequired)).toBe('model_auth_required');
    expect(coreErrorCode(ERRORS.invalidRequest)).toBe('model_invalid_request');
    // Un Core anterior a LXO-119 no conoce la query: es modelo legacy, no un error.
    expect(coreErrorCode(ERRORS.unknownCommand)).toBe('query_unsupported');
    expect(coreErrorCode(ERRORS.forbiddenAction)).toBe('query_unsupported');
    expect(isLegacyModelCode(coreErrorCode(ERRORS.inactive))).toBe(true);
    expect(isLegacyModelCode(coreErrorCode(ERRORS.unknownCommand))).toBe(true);
    expect(isLegacyModelCode(coreErrorCode(ERRORS.unavailable))).toBe(false);
    // El texto suelto no cuenta: solo el prefijo de código.
    expect(coreErrorCode('fallo: dice core_model_inactive en medio')).toBe('fallo');
  });
});
