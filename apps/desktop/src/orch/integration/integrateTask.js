// integrateTask.js — adaptador de la integración humana de una tarea del orquestador.
// Llama al comando Tauri propio `orch_integrate` (no pasa por orch_call ni por server.rs,
// así que un agente no puede invocarlo por HTTP ni con lxo).
// El mock de ./mockIntegrateTask.js solo se carga si:
//   - modo desarrollo (import.meta.env.DEV), y
//   - VITE_ORCH_MOCK vale '1' (PowerShell: `$env:VITE_ORCH_MOCK='1'; npm run dev`).
// En el build de producción DEV es la constante false y el bloque del mock se elimina.
// Tipos: ./integrateTypes.d.ts

import { invoke } from '@tauri-apps/api/core';

/** @typedef {import('./integrateTypes').IntegrateArgs} IntegrateArgs */
/** @typedef {import('./integrateTypes').IntegrateResult} IntegrateResult */

/** Nombre del comando del host. */
export const INTEGRATE_COMMAND = 'orch_integrate';

/** Parámetro para integrar contra una rama destino que se movió; lleva el found_commit visto por la persona. */
export const ACCEPT_MOVED_TARGET_PARAM = 'accept_moved_target';

/** Valores de `outcome` del contrato, en un solo lugar. */
export const OUTCOMES = Object.freeze({
  merged: 'merged',
  conflict: 'conflict',
  targetMoved: 'target_moved',
  error: 'error',
  alreadyMerged: 'already_merged',
});

/** Nombres de campos de la respuesta, en un solo lugar (si el host los cambia, se renombran aquí). */
export const FIELDS = Object.freeze({
  outcome: 'outcome',
  into: 'into',
  message: 'message',
  hint: 'hint',
  baseCommit: 'base_commit',
  resultCommit: 'result_commit',
  conflicts: 'conflicts',
  expectedCommit: 'expected_commit',
  foundCommit: 'found_commit',
});

/** Lee un campo del resultado por su nombre lógico. */
export function field(result, key) {
  return result ? result[FIELDS[key]] : undefined;
}

export function shortSha(sha) {
  return String(sha ?? '').slice(0, 7);
}

/** Comando real del host. @param {IntegrateArgs} args @returns {Promise<IntegrateResult>} */
export function invokeIntegrateTask(args) {
  const payload = { task: args.task, confirm: args.confirm === true };
  if (args.squash !== undefined) payload.squash = !!args.squash;
  const accept = args[ACCEPT_MOVED_TARGET_PARAM];
  if (typeof accept === 'string' && accept !== '') payload[ACCEPT_MOVED_TARGET_PARAM] = accept;
  return invoke(INTEGRATE_COMMAND, payload);
}

/** Adaptador por defecto del diálogo. @param {IntegrateArgs} args @returns {Promise<IntegrateResult>} */
export async function integrateTask(args) {
  if (import.meta.env.DEV && import.meta.env.VITE_ORCH_MOCK === '1') {
    // Rama eliminada en el build de producción (DEV es la constante false).
    const { mockIntegrateTask } = await import('./mockIntegrateTask.js');
    return mockIntegrateTask(args);
  }
  return invokeIntegrateTask(args);
}

/** Convierte cualquier rechazo (error de uso) en el texto tal cual. */
export function errorText(err) {
  if (typeof err === 'string') return err;
  if (err && typeof err.message === 'string') return err.message;
  return String(err);
}
