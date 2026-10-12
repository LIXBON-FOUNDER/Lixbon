// CoreAdeClient.js — ESQUELETO del cliente real. NO se conecta a nada.
//
// Fija el punto de sustitución del mock: cuando existan los slices del Core, este es el único archivo que
// habla con el transporte (Tauri / HTTP local / daemon), traduce snake_case a camelCase y, mientras no
// exista el corte Task/Attempt, fabrica el Attempt a partir de la Task vigente. Las pantallas no cambian.
//
// Cada método lanza un AdeError `core_not_implemented` que nombra el slice que lo habilitará.
import { ADE_METHODS, adeError } from './contract';
import { SLICES } from './intents';

/** Qué slice habilita cada método (ver docs/ade/ARQUITECTURA.md §7.3 y client/fieldSources.js). */
export const METHOD_SLICES = Object.freeze({
  getConnection: SLICES.F,
  getCapabilities: SLICES.F,
  listProjects: SLICES.D,
  getProject: SLICES.D,
  listTasks: SLICES.TASK_ATTEMPT,
  getTask: SLICES.TASK_ATTEMPT,
  listAttempts: SLICES.TASK_ATTEMPT,
  getAttempt: SLICES.TASK_ATTEMPT,
  listThreads: SLICES.TASK_ATTEMPT,
  getThread: SLICES.TASK_ATTEMPT,
  listWorktrees: SLICES.TASK_ATTEMPT,
  listArtifacts: SLICES.TASK_ATTEMPT,
  getReview: SLICES.TASK_ATTEMPT,
  getIntegration: SLICES.TASK_ATTEMPT,
  listAttention: SLICES.G,
  listActivity: SLICES.E,
  listAgents: 'vigente (orch_agents): mapeo pendiente',
  resolveLocation: `${SLICES.D} + ${SLICES.TASK_ATTEMPT}`,
  dispatch: `${SLICES.G} + ${SLICES.F}`,
  subscribe: SLICES.E,
});

export function createCoreAdeClient() {
  const cliente = { source: 'core' };
  for (const metodo of ADE_METHODS) {
    cliente[metodo] = () => {
      const slice = METHOD_SLICES[metodo];
      // subscribe es síncrono en la interfaz; el resto, asíncrono (promesa rechazada).
      const error = adeError('core_not_implemented', `CoreAdeClient.${metodo} no está implementado: lo habilita ${slice}.`, { slice, method: metodo });
      if (metodo === 'subscribe') throw error;
      return Promise.reject(error);
    };
  }
  return cliente;
}
