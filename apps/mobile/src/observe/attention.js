// observe/attention.js — bandeja de Attention de Supervisar (LXO-109). Sin dependencias de React Native.
//
// Mobile no calcula Attention: lista, en el orden del Core, lo que devuelve `attention_list` (LXO-89) por el
// relé (`core_attention`). Categoría y severidad son las del Core; abrir una fila no la resuelve ni la marca.

export const CATEGORY = Object.freeze({
  question: { label: 'Pregunta', icon: 'message' },
  approval: { label: 'Aprobación', icon: 'key' },
  review_ready: { label: 'Lista para revisar', icon: 'eye' },
  conflict: { label: 'Conflicto', icon: 'git' },
  failed: { label: 'Fallo', icon: 'warning' },
  environment_blocked: { label: 'Entorno bloqueado', icon: 'console' },
  risk: { label: 'Riesgo', icon: 'flash' },
});
export const CATEGORIES = Object.freeze(Object.keys(CATEGORY));

export const SEVERITY = Object.freeze({
  critical: { label: 'Crítica', tone: 'error' },
  high: { label: 'Alta', tone: 'warn' },
  medium: { label: 'Media', tone: 'muted' },
  low: { label: 'Baja', tone: 'muted' },
});
export const SEVERITIES = Object.freeze(Object.keys(SEVERITY));

const TARGET = {
  task: 'Tarea',
  project: 'Proyecto',
  run: 'Run',
  spawn_request: 'Lanzamiento pendiente',
  attempt: 'Intento',
  worktree: 'Worktree',
  review: 'Revisión',
  integration: 'Integración',
  agent: 'Agente',
  decision: 'Decisión',
  policy: 'Política',
  thread: 'Conversación',
  artifact: 'Artefacto',
};

/** Una categoría que el Core añada después se ve con su código, sin romper la lista. */
export const categoryOf = (code) => CATEGORY[code] || { label: String(code || 'desconocida'), icon: 'bell' };
export const severityOf = (code) => SEVERITY[code] || { label: String(code || '—'), tone: 'muted' };

/** Adónde lleva una fila. Solo las Tasks tienen pantalla en F2; lo demás se describe sin navegar. */
export function attentionTarget(item) {
  const kind = item?.target_kind;
  if (kind === 'task' && item.target_id) {
    return { navigable: true, label: TARGET.task, route: { name: 'task', taskId: item.target_id, projectId: item.project_id || null } };
  }
  // LXO-126: la Attention de ejecución apunta al intento exacto, y se abre ese intento (no «el último» de su tarea).
  if (kind === 'attempt' && item.target_id) {
    return { navigable: true, label: TARGET.attempt, route: { name: 'attempt', attemptId: item.target_id, projectId: item.project_id || null } };
  }
  return { navigable: false, label: TARGET[kind] || 'Destino', route: null };
}

export function ageText(createdAt, now) {
  if (!Number.isFinite(createdAt)) return '';
  const min = Math.max(0, Math.round((now - createdAt) / 60000));
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'hace 1 día' : `hace ${d} días`;
}

/** Nombres de Project desde la snapshot (por `project_id`, nunca por ruta). */
export function projectNames(snapshot) {
  const out = {};
  for (const p of snapshot?.projects?.items || []) if (p?.id) out[p.id] = p.name;
  return out;
}

export const projectLabel = (id, names) => (id ? names[id] || `Proyecto ${String(id).slice(0, 8)}` : 'Sin proyecto');

/** Agrupación compacta por Project que conserva el orden del Core dentro y entre grupos. */
export function groupByProject(items, names) {
  const groups = [];
  const index = new Map();
  for (const item of items) {
    const key = item.project_id || null;
    if (!index.has(key)) {
      index.set(key, groups.length);
      groups.push({ projectId: key, name: projectLabel(key, names), items: [] });
    }
    groups[index.get(key)].items.push(item);
  }
  return groups;
}

/** Texto para el lector de pantalla de una fila. */
export function attentionA11y(item, names, now) {
  const target = attentionTarget(item);
  return [
    categoryOf(item.category).label,
    `severidad ${severityOf(item.severity).label.toLowerCase()}`,
    `${target.label} en ${projectLabel(item.project_id, names)}`,
    ageText(item.created_at, now),
    target.navigable ? 'abre la tarea' : null,
  ]
    .filter(Boolean)
    .join(', ');
}

// ── Estado de la lista ────────────────────────────────────────────────────────

export const EMPTY_FILTERS = Object.freeze({ project_id: null, category: null, severity: null });

export const initialList = {
  filters: EMPTY_FILTERS,
  items: [],
  cursor: null,
  hasMore: false,
  loading: false,
  // De dónde salen los items: 'list' (attention_list), 'snapshot' (las más urgentes de la snapshot) o null.
  source: null,
  fetchedAt: null,
  error: null,
  // Generación de la consulta: una respuesta de una consulta vieja (otros filtros) se descarta.
  gen: 0,
};

const sameFilters = (a, b) => a.project_id === b.project_id && a.category === b.category && a.severity === b.severity;

/** Args de `core_attention` para unos filtros y, si se pide más, el cursor. */
export function queryOf(filters, cursor = null) {
  const args = {};
  for (const k of ['project_id', 'category', 'severity']) if (filters[k]) args[k] = filters[k];
  if (cursor) args.cursor = cursor;
  return args;
}

export function listReducer(state, action) {
  switch (action.type) {
    case 'filters': {
      const filters = { ...state.filters, ...action.filters };
      if (sameFilters(filters, state.filters)) return state;
      return { ...state, filters, items: [], cursor: null, hasMore: false, source: null, error: null, gen: state.gen + 1 };
    }
    case 'request':
      return { ...state, loading: true, error: null };
    case 'page': {
      if (action.gen !== state.gen) return state;
      // Más páginas se añaden sin repetir ids (el Core no repite, pero un reintento sí podría).
      const base = action.append ? state.items : [];
      const seen = new Set(base.map((i) => i.id));
      const fresh = (action.items || []).filter((i) => i && i.id && !seen.has(i.id));
      return { ...state, loading: false, items: [...base, ...fresh], cursor: action.cursor || null, hasMore: !!action.hasMore && !!action.cursor, source: 'list', fetchedAt: action.at, error: null };
    }
    case 'fail':
      if (action.gen !== state.gen) return state;
      // Un fallo no vacía lo que ya se veía: se marca como no actualizado.
      return { ...state, loading: false, error: action.code || 'offline' };
    case 'snapshot':
      // Sin lista propia (IDE anterior, o todavía sin conexión): las más urgentes de la snapshot, filtradas
      // igual, y marcadas como parciales. Nunca sustituye a una lista ya cargada.
      if (state.source === 'list') return state;
      return {
        ...state,
        items: (action.items || []).filter(
          (i) => (!state.filters.project_id || i.project_id === state.filters.project_id) && (!state.filters.category || i.category === state.filters.category) && (!state.filters.severity || i.severity === state.filters.severity),
        ),
        source: 'snapshot',
        hasMore: false,
        cursor: null,
      };
    default:
      return state;
  }
}

/** Qué decir encima de la lista: parcial, desactualizada o al día. */
export function listNotice(state, { capability, online, snapshotTotal }) {
  if (state.source === 'snapshot') {
    const partial = Number.isFinite(snapshotTotal) && snapshotTotal > state.items.length;
    if (!capability) return { tone: 'warn', text: `Tu Lixbon de escritorio solo envía las más urgentes${partial ? ` (${state.items.length} de ${snapshotTotal})` : ''}: actualízalo para ver la bandeja completa.` };
    return partial ? { tone: 'muted', text: `Las ${state.items.length} más urgentes de ${snapshotTotal}, guardadas en este teléfono.` } : null;
  }
  if (state.error && state.items.length) return { tone: 'warn', text: 'No se pudo actualizar la bandeja: ves la última que llegó.' };
  if (!online && state.items.length) return { tone: 'warn', text: 'Sin conexión: ves la última bandeja que llegó.' };
  return null;
}
