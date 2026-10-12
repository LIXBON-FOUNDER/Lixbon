// routes.js — rutas del ADE (puras). Una ruta es un objeto serializable; se escribe como `#/attempt/att_x`
// para poder enlazarla desde el CLI y desde las notificaciones del móvil: usan los mismos ids semánticos.

export const SCREENS = Object.freeze(['home', 'projects', 'project', 'task', 'attempt', 'thread', 'review', 'integration', 'activity', 'agents', 'settings']);

/** Parámetro de cada pantalla con detalle. */
const PARAM = Object.freeze({
  project: 'projectId', task: 'taskId', attempt: 'attemptId', thread: 'threadId', review: 'attemptId', integration: 'attemptId',
});

export const routes = Object.freeze({
  home: () => ({ screen: 'home' }),
  projects: () => ({ screen: 'projects' }),
  project: (projectId) => ({ screen: 'project', projectId }),
  task: (taskId) => ({ screen: 'task', taskId }),
  attempt: (attemptId) => ({ screen: 'attempt', attemptId }),
  thread: (threadId) => ({ screen: 'thread', threadId }),
  review: (attemptId) => ({ screen: 'review', attemptId }),
  integration: (attemptId) => ({ screen: 'integration', attemptId }),
  activity: () => ({ screen: 'activity' }),
  agents: () => ({ screen: 'agents' }),
  settings: () => ({ screen: 'settings' }),
});

export function formatRoute(r) {
  const p = PARAM[r?.screen];
  if (r?.screen === 'home' || !r?.screen) return '#/';
  return p ? `#/${r.screen}/${encodeURIComponent(r[p] ?? '')}` : `#/${r.screen}`;
}

export function parseRoute(hash) {
  const limpio = String(hash || '').replace(/^#\/?/, '');
  const [screen, id] = limpio.split('/');
  if (!screen || !SCREENS.includes(screen)) return routes.home();
  const p = PARAM[screen];
  if (!p) return { screen };
  return id ? { screen, [p]: decodeURIComponent(id) } : routes.home();
}

export function sameRoute(a, b) {
  return formatRoute(a) === formatRoute(b);
}

/** Navegación principal (nivel superior). `icon` es un nombre que resuelve components/AdeIcon. */
export const NAV_ITEMS = Object.freeze([
  { screen: 'home', label: 'Inicio', icon: 'attention' },
  { screen: 'projects', label: 'Proyectos', icon: 'folder' },
  { screen: 'activity', label: 'Actividad', icon: 'history' },
  { screen: 'agents', label: 'Agentes', icon: 'cpu' },
  { screen: 'settings', label: 'Ajustes', icon: 'gear' },
]);

/** Sección de la navegación principal a la que pertenece una ruta (para marcarla activa). */
export function navSectionOf(r) {
  switch (r?.screen) {
    case 'project': case 'task': case 'attempt': case 'thread': case 'review': case 'integration': return 'projects';
    default: return r?.screen || 'home';
  }
}

/**
 * Ruta a la que lleva una tarjeta de Attention: va DIRECTO al nivel útil, pero la cadena completa
 * (proyecto → task → intento) sigue disponible en las migas. Es presentación: el Core solo da la entidad.
 */
export function routeForAttention(item) {
  const a = item?.attemptId;
  switch (item?.kind) {
    case 'review': return a ? routes.review(a) : routes.home();
    case 'integrate': return a ? routes.integration(a) : routes.home();
    default: return a ? routes.attempt(a) : item?.taskId ? routes.task(item.taskId) : routes.project(item?.projectId);
  }
}

/** Ruta de la entidad a la que se refiere un evento de la Actividad. */
export function routeForEntity(entity, ids = {}) {
  const nivel = ids.attemptId ? routes.attempt(ids.attemptId) : ids.taskId ? routes.task(ids.taskId) : null;
  switch (entity?.kind) {
    case 'project': return routes.project(entity.id);
    case 'task': return routes.task(entity.id);
    case 'thread': return routes.thread(entity.id);
    case 'review': return routes.review(entity.id);
    case 'integration': return routes.integration(entity.id);
    default: return nivel;
  }
}

/**
 * Migas de pan: Inicio › Proyecto › Task › Intento (› Hilo/Revisión/Integración).
 * Recibe las entidades ya resueltas; si falta alguna, la miga muestra un texto neutro.
 */
export function breadcrumbTrail(r, { project, task, attempt, thread } = {}) {
  const inicio = { label: 'Inicio', route: routes.home() };
  const proy = (p) => ({ label: p?.name || 'Proyecto', route: routes.project(p?.id) });
  const tar = (t) => ({ label: t?.title || 'Tarea', route: routes.task(t?.id) });
  const int = (a) => ({ label: a ? `Intento ${a.ordinal}` : 'Intento', route: routes.attempt(a?.id) });
  switch (r?.screen) {
    case 'projects': return [inicio, { label: 'Proyectos', route: routes.projects() }];
    case 'project': return [inicio, proy(project)];
    case 'task': return [inicio, proy(project), tar(task)];
    case 'attempt': return [inicio, proy(project), tar(task), int(attempt)];
    case 'thread': return [inicio, proy(project), tar(task), { label: thread?.title || 'Hilo', route: r }];
    case 'review': return [inicio, proy(project), tar(task), int(attempt), { label: 'Revisión', route: r }];
    case 'integration': return [inicio, proy(project), tar(task), int(attempt), { label: 'Integración', route: r }];
    case 'activity': return [inicio, { label: 'Actividad', route: r }];
    case 'agents': return [inicio, { label: 'Agentes y proveedores', route: r }];
    case 'settings': return [inicio, { label: 'Ajustes', route: r }];
    default: return [inicio];
  }
}
