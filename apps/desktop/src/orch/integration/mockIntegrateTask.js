// mockIntegrateTask.js — SOLO desarrollo (import.meta.env.DEV && VITE_ORCH_MOCK==='1').
// Simula `orch_integrate` según el id de la tarea:
//   root        -> rechazo: tarea raíz          *running*  -> rechazo: tarea en curso
//   *nobranch*  -> rechazo: tarea sin rama      sin confirm -> rechazo: falta confirmación
//   *conflict*  -> outcome conflict             *moved*    -> outcome target_moved
//                                                             (accept_moved_target = found_commit -> merged)
//   *moved-twice* -> se mueve otra vez tras el primer reintento
//   *dirty*     -> outcome error                *already*  -> outcome already_merged
//   *unreviewed* -> outcome review_required (sin revisión aceptada del head actual)
//   cualquier otra -> merged

import { ACCEPT_MOVED_TARGET_PARAM } from './integrateTask.js';

export const MOCK_ERRORS = {
  confirm: 'mock-orch: falta la confirmación explícita (confirm: true)',
  root: 'mock-orch: no se puede integrar la tarea raíz',
  running: 'mock-orch: la tarea todavía está corriendo',
  nobranch: 'mock-orch: la tarea no tiene rama',
};

const BASE = '1111111aaaaaaa2222222bbbbbbb3333333ccccc';
const FOUND = '4444444ddddddd5555555eeeeeee6666666fffff';
const FOUND2 = '7777777aaaaaaa8888888bbbbbbb9999999ccccc';
const RESULT = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';

export async function mockIntegrateTask(args = {}) {
  const { task, confirm, squash } = args;
  await new Promise((r) => setTimeout(r, 10));
  const id = String(task ?? '');
  if (confirm !== true) throw MOCK_ERRORS.confirm;
  if (id === 'root') throw MOCK_ERRORS.root;
  if (id.includes('running')) throw MOCK_ERRORS.running;
  if (id.includes('nobranch')) throw MOCK_ERRORS.nobranch;
  const common = { task: id, decision: `mock-dec-${id}`, branch: `lxo/${id}` };
  if (id.includes('already')) return { ...common, outcome: 'already_merged' };
  if (id.includes('unreviewed')) {
    return { ...common, outcome: 'review_required', head_commit: RESULT,
      message: 'mock-orch: no hay revisión aceptada para el head actual' };
  }
  if (id.includes('dirty')) {
    return { ...common, outcome: 'error', into: 'master', message: 'mock-orch: la rama destino tiene cambios sin commit' };
  }
  if (id.includes('moved')) {
    // *moved*: aceptar FOUND integra. *moved-twice*: aceptar FOUND devuelve otro movimiento (FOUND2).
    const accept = args[ACCEPT_MOVED_TARGET_PARAM];
    const current = id.includes('twice') && accept !== undefined ? FOUND2 : FOUND;
    const expected = current === FOUND2 ? FOUND : BASE;
    if (accept !== current) {
      return { ...common, outcome: 'target_moved', into: 'master', expected_commit: expected, found_commit: current,
        message: 'mock-orch: la rama destino se movió fuera de orch_integrate' };
    }
  }
  if (id.includes('conflict')) {
    return { ...common, outcome: 'conflict', into: 'master', base_commit: BASE, result_commit: null,
      conflicts: ['src/a.js', 'docs/guia.md'], message: 'mock-orch: conflicto; merge abortado',
      hint: 'mock-orch: resuelve el conflicto en la rama de la tarea' };
  }
  return { ...common, outcome: 'merged', into: 'master', base_commit: BASE, result_commit: RESULT, conflicts: null,
    message: squash ? 'mock-orch: squash merge hecho' : 'mock-orch: merge hecho',
    hint: 'mock-orch: revisa el resultado antes de subir la rama' };
}
