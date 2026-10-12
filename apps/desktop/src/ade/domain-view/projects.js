// projects.js — selectores puros de proyectos, tasks e intentos. Leen ids y grupos del vocabulario canónico.
// No derivan estado de dominio: el estado derivado de la Task y el del Attempt los entrega el cliente.
import { VISUAL_GROUPS, attemptStateInfo, isFinalState } from '../vocab/vocabulario';

export const attemptsByTaskId = (attempts) => {
  const m = {};
  for (const a of attempts) (m[a.taskId] ||= []).push(a);
  for (const k of Object.keys(m)) m[k].sort((x, y) => x.ordinal - y.ordinal);
  return m;
};

/** Último intento de una task (el de mayor ordinal), o null. */
export function latestAttempt(task, attemptsOfTask = []) {
  if (!attemptsOfTask.length) return null;
  return attemptsOfTask.reduce((mejor, a) => (a.ordinal > mejor.ordinal ? a : mejor));
}

/** Tasks agrupadas por proyecto, en el orden de `projects`. Las huérfanas van a un grupo sin proyecto. */
export function groupTasksByProject(tasks, projects) {
  const grupos = projects.map((project) => ({ project, tasks: [] }));
  const idx = new Map(grupos.map((g) => [g.project.id, g]));
  const huerfanas = [];
  for (const t of tasks) (idx.get(t.projectId)?.tasks ?? huerfanas).push(t);
  for (const g of grupos) g.tasks.sort((a, b) => b.updatedAt - a.updatedAt);
  return huerfanas.length ? [...grupos, { project: null, tasks: huerfanas }] : grupos;
}

const CERRADAS = ['integrated', 'discarded'];

/**
 * Resumen de un proyecto. Cuenta, por grupo visual, el ÚLTIMO intento de cada task abierta
 * (una task integrada o descartada ya no está «en juego»).
 */
export function summarizeProject(project, { tasks = [], attempts = [], attention = [], activity = [] } = {}) {
  const propias = tasks.filter((t) => t.projectId === project.id);
  const porTarea = attemptsByTaskId(attempts.filter((a) => a.projectId === project.id));
  const grupos = Object.fromEntries(VISUAL_GROUPS.map((g) => [g, 0]));
  const derivados = {};
  let activos = 0;
  for (const t of propias) {
    derivados[t.derivedState] = (derivados[t.derivedState] || 0) + 1;
    if (CERRADAS.includes(t.derivedState)) continue;
    const ult = latestAttempt(t, porTarea[t.id]);
    const g = ult ? attemptStateInfo(ult.state).group : null;
    if (g && g in grupos) grupos[g] += 1;
    if (ult && !isFinalState(ult.state)) activos += 1;
  }
  const delProyecto = attention.filter((i) => i.projectId === project.id);
  const ultimoEvento = activity.filter((e) => e.projectId === project.id).reduce((m, e) => Math.max(m, e.ts), 0) || null;
  const ubicacion = project.locations?.find((l) => l.primary) || project.locations?.[0] || null;
  return {
    projectId: project.id,
    taskCount: propias.length,
    openTaskCount: propias.filter((t) => !CERRADAS.includes(t.derivedState)).length,
    byGroup: grupos,
    byDerivedState: derivados,
    activeAttempts: activos,
    attentionCount: delProyecto.length,
    lastEventAt: ultimoEvento,
    primaryLocation: ubicacion,
    locationMissing: ubicacion?.state === 'missing',
  };
}

/** «Calor» para ordenar: primero lo que pide atención, luego lo que está en marcha, luego lo reciente. */
export function sortProjectsByHeat(projects, summaries) {
  const s = (p) => summaries[p.id] || { attentionCount: 0, activeAttempts: 0, lastEventAt: 0 };
  return [...projects].sort((a, b) => (a.state === 'archived') - (b.state === 'archived')
    || s(b).attentionCount - s(a).attentionCount
    || s(b).activeAttempts - s(a).activeAttempts
    || (s(b).lastEventAt || 0) - (s(a).lastEventAt || 0)
    || a.name.localeCompare(b.name));
}

/** Proveedores con intentos vivos: para la pantalla de Agentes y proveedores. */
export function activeAttemptsByProvider(attempts) {
  const m = {};
  for (const a of attempts) if (!isFinalState(a.state)) m[a.agent.provider] = (m[a.agent.provider] || 0) + 1;
  return m;
}

/** Agrupa los intentos de una task por estado visual, para la línea de resumen de la fila de Task. */
export function attemptSummaryLine(attemptsOfTask) {
  const total = attemptsOfTask.length;
  const vivos = attemptsOfTask.filter((a) => !isFinalState(a.state)).length;
  return { total, vivos };
}
