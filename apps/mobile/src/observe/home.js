// observe/home.js — Home de Supervisar (LXO-108). Sin dependencias de React Native.
//
// Resume, no reconstruye: todo sale de la snapshot compacta del Core (LXO-94), que a su vez sale de las mismas
// fuentes que `projects_overview`. Tareas fallidas y Attention son señales distintas y se cuentan aparte. Cada
// fila lleva a su pantalla por ids durables (`project_id`, `task_id`).
import { CATEGORIES, categoryOf } from './attention.js';
import { statusOf } from './task.js';

export const PROJECT_STATUS = Object.freeze({
  failed: { label: 'Con fallos', tone: 'error' },
  attention: { label: 'Pide atención', tone: 'warn' },
  active: { label: 'En curso', tone: 'ok' },
  idle: { label: 'En reposo', tone: 'muted' },
});
export const projectStatusOf = (code) => PROJECT_STATUS[code] || { label: String(code || '—'), tone: 'muted' };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Contadores de un Project, separados: activas, fallidas y Attention nunca se suman entre sí. */
export function projectCounts(p) {
  const parts = [plural(p.active ?? 0, 'activa', 'activas')];
  if (p.failed) parts.push(plural(p.failed, 'fallida', 'fallidas'));
  if (p.attention) parts.push(plural(p.attention, 'pide atención', 'piden atención'));
  return parts.join(' · ');
}

export function homeModel(snapshot) {
  if (!snapshot) return null;
  const projects = (snapshot.projects?.items || []).map((p) => ({
    id: p.id,
    name: p.name || `Proyecto ${String(p.id).slice(0, 8)}`,
    status: projectStatusOf(p.status),
    active: p.active ?? 0,
    failed: p.failed ?? 0,
    attention: p.attention ?? 0,
    counts: projectCounts(p),
    route: { name: 'project', projectId: p.id },
  }));
  const names = Object.fromEntries(projects.map((p) => [p.id, p.name]));
  const active = (snapshot.active_tasks?.items || []).map((t) => ({
    id: t.id,
    title: t.title || '(sin título)',
    status: statusOf(t.status),
    projectId: t.project_id || null,
    projectName: t.project_id ? names[t.project_id] || `Proyecto ${String(t.project_id).slice(0, 8)}` : 'Sin proyecto',
    // El origen solo se enseña cuando dice algo: un coordinador externo (una terminal cualquiera).
    origin: t.origin === 'external' ? 'Externo' : null,
    child: !!t.parent_id,
    updatedAt: t.updated_at ?? null,
    route: { name: 'task', taskId: t.id, projectId: t.project_id || null },
  }));
  const byCategory = snapshot.attention?.by_category || {};
  return {
    projects,
    projectsTotal: snapshot.projects?.total ?? projects.length,
    projectsHidden: Math.max(0, (snapshot.projects?.total ?? projects.length) - projects.length),
    active,
    activeTotal: snapshot.active_tasks?.total ?? active.length,
    activeHidden: Math.max(0, (snapshot.active_tasks?.total ?? active.length) - active.length),
    attention: {
      total: snapshot.attention?.total ?? 0,
      categories: CATEGORIES.filter((k) => (byCategory[k] ?? 0) > 0).map((k) => ({ key: k, label: categoryOf(k).label, icon: categoryOf(k).icon, count: byCategory[k], route: { name: 'attention', category: k } })),
      route: { name: 'attention' },
    },
    unassigned: snapshot.unassigned || { active: 0, failed: 0, attention: 0 },
    health: snapshot.core?.health === 'read_only' ? 'read_only' : 'ok',
    version: snapshot.core?.version || null,
  };
}

/** Lo que tiene en marcha un Project (pantalla de Project): sus Tasks activas de la snapshot. */
export function projectModel(snapshot, projectId) {
  const home = homeModel(snapshot);
  if (!home) return null;
  const project = home.projects.find((p) => p.id === projectId) || null;
  return {
    project,
    tasks: home.active.filter((t) => t.projectId === projectId),
    // La lista de activas puede venir recortada: entonces las de este Project pueden ser más.
    partial: home.activeHidden > 0,
    attentionRoute: { name: 'attention', projectId },
  };
}

/** Texto para el lector de pantalla de un Project y de una Task activa. */
export const projectA11y = (p) => `${p.name}, ${p.status.label}, ${p.counts}`;
export const activeA11y = (t) => [t.title, t.status.label, t.projectName, t.origin, t.child ? 'tarea hija' : null, 'abre la tarea'].filter(Boolean).join(', ');
