// taskReview.js - adaptador de la revisión de diff por tarea.
// El mock de ./mockTaskReview.js solo se carga si:
//   - modo desarrollo (import.meta.env.DEV), y
//   - VITE_ORCH_MOCK vale '1' (PowerShell: `$env:VITE_ORCH_MOCK='1'; npm run dev`).
// En el build de producción DEV es la constante false y el bloque del mock se elimina.

import { invoke } from '@tauri-apps/api/core';
import { REVIEW_COMMANDS, diffArgs, reviewArgs, structuredError } from './reviewContract.js';

export function invokeTaskDiff(taskId) {
  return invoke(REVIEW_COMMANDS.diff, diffArgs(taskId));
}

/** Si el host rechaza con un error estructurado ({error}), se devuelve como resultado. */
export async function invokeReviewTask(args) {
  try {
    return await invoke(REVIEW_COMMANDS.review, reviewArgs(args));
  } catch (e) {
    if (structuredError(e)) return e;
    throw e;
  }
}

export async function fetchTaskDiff(taskId) {
  if (import.meta.env.DEV && import.meta.env.VITE_ORCH_MOCK === '1') {
    // Rama eliminada en el build de producción.
    const { mockTaskDiff } = await import('./mockTaskReview.js');
    return mockTaskDiff(diffArgs(taskId));
  }
  return invokeTaskDiff(taskId);
}

export async function reviewTask(args) {
  if (import.meta.env.DEV && import.meta.env.VITE_ORCH_MOCK === '1') {
    const { mockReviewTask } = await import('./mockTaskReview.js');
    return mockReviewTask(reviewArgs(args));
  }
  return invokeReviewTask(args);
}

export const defaultReviewApi = Object.freeze({ fetchDiff: fetchTaskDiff, review: reviewTask });
