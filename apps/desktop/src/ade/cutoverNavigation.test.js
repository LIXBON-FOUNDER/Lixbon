import { describe, expect, it } from 'vitest';
import { coreModelFromState } from './useCoreModel';
import { attemptTaskId, discardedTaskIds, legacyShimOpen, migratePersistedSelection, resolveNavTarget, selectionTarget } from './cutoverNavigation';
import {
  ACTIVITY_ATTEMPT_TARGET, ATTENTION_ATTEMPT_TARGET, CORE_MODEL_COMPAT_CLOSED, CORE_MODEL_COMPAT_OPEN, CORE_MODEL_LEGACY,
  CORE_MODEL_LEGACY_READY, CORE_MODEL_REJECTED,
  F2_SELECTION, F2_SELECTION_BROKEN, F2_SELECTION_V1, F2_TASK_ROWS, V2_OPEN_PAGE, V2_PARTIAL_PAGE,
} from './testFixtures/cutoverFixtures';

const model = (data) => coreModelFromState({ data, error: null });
const OPEN = model(CORE_MODEL_COMPAT_OPEN);
const CLOSED = model(CORE_MODEL_COMPAT_CLOSED);
const LEGACY = model(CORE_MODEL_LEGACY);
const UNKNOWN = coreModelFromState({ data: null, error: null });

describe('cutoverNavigation (LXO-123)', () => {
  it('el shim sigue core_model.compat: abierto con legacy_task_v1, cerrado sin él o en legacy', () => {
    expect(legacyShimOpen(OPEN)).toBe(true);
    expect(legacyShimOpen(CLOSED)).toBe(false);
    expect(legacyShimOpen(LEGACY)).toBe(false);
  });

  it('selección F2: migra con el shim abierto, se invalida con aviso al cerrarse, espera si el modelo no se sabe', () => {
    for (const raw of [F2_SELECTION, F2_SELECTION_V1]) {
      expect(migratePersistedSelection(raw, OPEN)).toEqual({ selection: { projectId: 'p-1', taskId: 't3' }, notice: 'migrated' });
      expect(migratePersistedSelection(raw, CLOSED)).toEqual({ selection: { projectId: null, taskId: null }, notice: 'expired' });
      expect(migratePersistedSelection(raw, LEGACY)).toEqual({ selection: { projectId: 'p-1', taskId: 't3' }, notice: null });
      expect(migratePersistedSelection(raw, UNKNOWN)).toBeNull();
    }
    expect(migratePersistedSelection(F2_SELECTION_BROKEN, OPEN)).toEqual({ selection: { projectId: null, taskId: null }, notice: 'invalid' });
    // La Task F2 nunca se reinterpreta como Attempt.
    expect(migratePersistedSelection({ projectId: 'p-1', taskId: 't3-a1' }, OPEN).selection).toEqual({ projectId: 'p-1', taskId: 't3-a1' });
  });

  it('contrato real de core_model: solo agéntico sin legacy_task_v1 retira; legacy y rechazado nunca descartan', () => {
    const legacyReady = model(CORE_MODEL_LEGACY_READY);
    const rejected = model(CORE_MODEL_REJECTED);
    const errored = coreModelFromState({ data: null, error: 'model_unavailable: caído' });
    // legacy + [] : se conserva la selección y el shim no se retira.
    expect(legacyShimOpen(legacyReady)).toBe(false);
    expect(migratePersistedSelection(F2_SELECTION, legacyReady)).toEqual({ selection: { projectId: 'p-1', taskId: 't3' }, notice: null });
    expect(migratePersistedSelection(F2_SELECTION_BROKEN, legacyReady)).toBeNull();
    // rechazado: no se decide ni se toca nada.
    expect(migratePersistedSelection(F2_SELECTION, rejected)).toBeNull();
    expect(migratePersistedSelection(F2_SELECTION_BROKEN, rejected)).toBeNull();
    // modelo desconocido o en error: tampoco.
    expect(migratePersistedSelection(F2_SELECTION, UNKNOWN)).toBeNull();
    expect(migratePersistedSelection(F2_SELECTION, errored)).toBeNull();
    // task_attempt_v1 (agéntico) + [legacy_task_v1]: migra.
    expect(OPEN.mode).toBe('task_attempt_v1');
    expect(migratePersistedSelection(F2_SELECTION, OPEN).notice).toBe('migrated');
    // task_attempt_v1 (agéntico) + []: retira.
    expect(migratePersistedSelection(F2_SELECTION, CLOSED)).toEqual({ selection: { projectId: null, taskId: null }, notice: 'expired' });
  });

  it('Attention y Activity navegan al Attempt exacto con su Task', () => {
    expect(resolveNavTarget(ATTENTION_ATTEMPT_TARGET, OPEN)).toEqual({ action: 'select', selection: { projectId: 'p-1', taskId: 't3', attemptId: 't3-a2' } });
    expect(resolveNavTarget(ACTIVITY_ATTEMPT_TARGET, CLOSED)).toEqual({ action: 'select', selection: { projectId: 'p-1', taskId: 't3', attemptId: 't3-a1' } });
    expect(attemptTaskId('t-x-a12')).toBe('t-x');
    expect(attemptTaskId('t3-a0')).toBeNull();
  });

  it('destinos stale o inválidos fallan de forma explicable', () => {
    expect(resolveNavTarget(ATTENTION_ATTEMPT_TARGET, LEGACY)).toEqual({ action: 'reject', reason: 'model_inactive' });
    expect(resolveNavTarget({ kind: 'attempt', id: 'sin-numero', projectId: 'p-1' }, OPEN)).toEqual({ action: 'reject', reason: 'invalid_attempt' });
    expect(resolveNavTarget({ kind: 'attempt', id: 't3-a1' }, OPEN)).toEqual({ action: 'reject', reason: 'no_project' });
    expect(resolveNavTarget({ kind: 'task', id: 't3' }, OPEN)).toEqual({ action: 'reject', reason: 'no_project' });
    expect(resolveNavTarget({ kind: 'run', id: 'r1' }, OPEN)).toEqual({ action: 'other' });
  });

  it('rutas legacy y actuales: resolver una selección ya resuelta no redirige (sin bucles)', () => {
    const targets = [
      { kind: 'project', id: 'p-1' },
      { kind: 'task', id: 't3', projectId: 'p-1' },
      ATTENTION_ATTEMPT_TARGET,
    ];
    for (const target of targets) {
      const first = resolveNavTarget(target, OPEN);
      expect(first.action).toBe('select');
      let current = first.selection;
      for (let i = 0; i < 5; i += 1) {
        const again = resolveNavTarget(selectionTarget(current), OPEN);
        expect(again.selection).toEqual(current);
        current = again.selection;
      }
    }
    // Migrar dos veces da lo mismo: la selección migrada ya es v2 y no vuelve a pasar por el shim.
    const once = migratePersistedSelection(F2_SELECTION, OPEN).selection;
    expect(migratePersistedSelection(once, OPEN).selection).toEqual(once);
  });

  it('las Tasks descartadas se ocultan por defecto solo con la lista vNext completa del Project', () => {
    // t11 (viva, aún no en task_list_v2) no se oculta: solo Tasks F2 en estado final.
    expect([...discardedTaskIds(F2_TASK_ROWS, V2_OPEN_PAGE, 'p-1', OPEN)]).toEqual(['t8']);
    expect(discardedTaskIds(F2_TASK_ROWS, V2_PARTIAL_PAGE, 'p-1', OPEN).size).toBe(0);
    expect(discardedTaskIds(F2_TASK_ROWS, V2_OPEN_PAGE, 'otro', OPEN).size).toBe(0);
    expect(discardedTaskIds(F2_TASK_ROWS, V2_OPEN_PAGE, 'p-1', LEGACY).size).toBe(0);
    expect(discardedTaskIds(F2_TASK_ROWS, null, 'p-1', OPEN).size).toBe(0);
  });
});
