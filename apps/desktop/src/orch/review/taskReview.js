// taskReview.js - adaptador de la revisión de diff por tarea.
// El mock de ./mockTaskReview.js solo se carga si:
//   - modo desarrollo (import.meta.env.DEV), y
//   - VITE_ORCH_MOCK vale '1' (PowerShell: `$env:VITE_ORCH_MOCK='1'; npm run dev`).
// En el build de producción DEV es la constante false y el bloque del mock se elimina.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { REVIEW_COMMANDS, REVIEW_EVENTS, diffArgs, reviewArgs } from './reviewContract.js';

export function invokeTaskDiff(taskId) {
  return invoke(REVIEW_COMMANDS.diff, diffArgs(taskId));
}

/** head_moved llega como respuesta normal; not_found y errores de uso, como rechazo de texto. */
export function invokeReviewTask(args) {
  return invoke(REVIEW_COMMANDS.review, reviewArgs(args));
}

/** Escucha orch-task-reviewed; devuelve la función para dejar de escuchar. */
export function subscribeTaskReviewed(cb) {
  if (import.meta.env.DEV && import.meta.env.VITE_ORCH_MOCK === '1') {
    let off = null; let dead = false;
    import('./mockTaskReview.js').then((m) => { if (!dead) off = m.onMockTaskReviewed(cb); });
    return () => { dead = true; off?.(); };
  }
  let un = null; let dead = false;
  listen(REVIEW_EVENTS.reviewed, (e) => cb(e.payload)).then((u) => { if (dead) u(); else un = u; }).catch(() => {});
  return () => { dead = true; un?.(); };
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

export const defaultReviewApi = Object.freeze({ fetchDiff: fetchTaskDiff, review: reviewTask, subscribe: subscribeTaskReviewed });
