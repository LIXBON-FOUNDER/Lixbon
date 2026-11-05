/**
 * Contrato cliente de `policy_effective` (LXO-209/210, docs/core/POLICY.md): la policy de autonomía efectiva de quien pregunta, con el origen de
 * cada nivel y, si se pide, la previsualización de un cambio. El Core es la autoridad: la interfaz muestra y pide, nunca otorga. Una respuesta
 * fuera del contrato se rechaza entera: no se pinta una policy a medias.
 */
export const LEVELS = Object.freeze(['allow', 'confirm', 'elevated', 'deny']);
export const CATEGORIES = Object.freeze(['start', 'answer', 'queue', 'steer', 'stop', 'fork', 'review', 'integrate', 'cleanup', 'provider_permissions']);
export const SOURCES = Object.freeze(['baseline', 'global', 'project', 'attempt', 'floor']);
export const REASONS = Object.freeze(['baseline_default', 'baseline_actor', 'override_global', 'override_project', 'override_attempt', 'safety_floor']);
export const ACTOR_CLASSES = Object.freeze(['desktop_person', 'cli_person', 'mobile_person', 'automation', 'agent', 'core']);
export const DIRECTIONS = Object.freeze(['tighten', 'loosen', 'same', 'reset']);
export const SCOPE_KINDS = Object.freeze(['global', 'project', 'attempt']);

/** Cuánto restringe cada nivel: el orden de `LEVELS` ES el orden de restricción. */
export const restriction = (level) => LEVELS.indexOf(level);

const invalid = (detail) => new Error(`ade_query_invalid_response: policy_effective: ${detail}`);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isLevel = (v) => LEVELS.includes(v);
const levelOrNull = (v) => v === null || isLevel(v);
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;

function category(c, i, where) {
  if (!isObject(c) || c.category !== CATEGORIES[i]) throw invalid(`${where}: las categorías deben venir las diez, en orden`);
  if (!isLevel(c.level) || !SOURCES.includes(c.source) || !REASONS.includes(c.reason)) throw invalid(`${where}.${c.category}: nivel, origen o motivo fuera del contrato`);
  const l = c.layers;
  if (!isObject(l) || !isLevel(l.baseline) || !levelOrNull(l.global) || !levelOrNull(l.project) || !levelOrNull(l.attempt)) throw invalid(`${where}.${c.category}: capas inválidas`);
  if (c.floor !== null && !isLevel(c.floor)) throw invalid(`${where}.${c.category}: piso inválido`);
  if (typeof c.enforced !== 'boolean') throw invalid(`${where}.${c.category}: falta si se aplica`);
  const top = Math.max(...[l.baseline, l.global, l.project, l.attempt].filter(Boolean).map(restriction));
  const floor = c.floor === null ? 0 : restriction(c.floor);
  // El nivel efectivo es el más restrictivo de las capas y nunca baja del piso: otra cosa es una policy que el Core no calculó.
  if (restriction(c.level) !== Math.max(top, floor)) throw invalid(`${where}.${c.category}: el nivel efectivo no es el más restrictivo de sus capas ni el piso`);
  if ((c.source === 'floor') !== (floor > top)) throw invalid(`${where}.${c.category}: el origen «floor» solo vale cuando el piso supera a las capas`);
}

function categories(list, where) {
  if (!Array.isArray(list) || list.length !== CATEGORIES.length) throw invalid(`${where}: faltan categorías`);
  list.forEach((c, i) => category(c, i, where));
}

function preview(p) {
  if (!isObject(p) || typeof p.valid !== 'boolean') throw invalid('preview inválida');
  if (!p.valid) {
    if (typeof p.code !== 'string' || !p.code.startsWith('policy_') || typeof p.message !== 'string') throw invalid('preview rechazada sin código');
    return;
  }
  if (!DIRECTIONS.includes(p.direction) || typeof p.needs_confirm !== 'boolean' || !isLevel(p.before) || !isLevel(p.after)) throw invalid('preview: dirección o niveles fuera del contrato');
  // Aflojar es exactamente lo que exige confirmación: una preview que lo calla no se pinta.
  if (p.needs_confirm !== (restriction(p.after) < restriction(p.before))) throw invalid('preview: la confirmación no corresponde a si baja la restricción');
  categories(p.categories, 'preview.categories');
}

export function validatePolicyEffective(response, args) {
  if (!isObject(response)) throw invalid('la respuesta no es un objeto');
  if (response.v !== 1) throw invalid('versión de contrato desconocida');
  if (!Number.isSafeInteger(response.revision) || response.revision < 0) throw invalid('revisión inválida');
  const a = response.actor;
  if (!isObject(a) || !ACTOR_CLASSES.includes(a.class) || typeof a.can_edit !== 'boolean') throw invalid('actor inválido');
  // Solo una Person de Desktop edita: una respuesta que lo concede a otro no se pinta.
  if (a.can_edit && a.class !== 'desktop_person') throw invalid('se concede editar a quien no es una Person de Desktop');
  const s = response.scope;
  if (!isObject(s) || (s.project_id !== null && !isId(s.project_id)) || (s.attempt_id !== null && !isId(s.attempt_id))) throw invalid('ámbito inválido');
  if (args.attempt_id != null && s.attempt_id !== args.attempt_id) throw invalid('la policy no corresponde al Attempt solicitado');
  if (args.project_id != null && s.project_id !== args.project_id) throw invalid('la policy no corresponde al Project solicitado');
  if (!Array.isArray(response.levels) || response.levels.join() !== LEVELS.join()) throw invalid('niveles fuera del contrato');
  categories(response.categories, 'categories');
  if (!Array.isArray(response.overrides)) throw invalid('overrides inválidos');
  for (const o of response.overrides) {
    if (!isObject(o) || !isObject(o.scope) || !SCOPE_KINDS.includes(o.scope.kind) || !CATEGORIES.includes(o.category) || !isLevel(o.level)) throw invalid('override fuera del contrato');
    if ((o.scope.kind === 'global') !== (o.scope.id === null)) throw invalid('override: solo el global va sin id');
  }
  if (!isObject(response.baseline_matrix) || !ACTOR_CLASSES.every((c) => isObject(response.baseline_matrix[c]) && CATEGORIES.every((k) => isLevel(response.baseline_matrix[c][k])))) {
    throw invalid('matriz base incompleta');
  }
  if (response.preview !== undefined) preview(response.preview);
  return response;
}

/** Petición y validación de la query. Se fusionan en la tabla de `coreQueries.js`. */
export const AUTONOMY_QUERY_SPECS = Object.freeze({
  policy_effective: {
    request: (input = {}) => {
      const out = {};
      for (const [from, to] of [['projectId', 'project_id'], ['attemptId', 'attempt_id']]) {
        if (input[from] == null) continue;
        if (typeof input[from] !== 'string' || !input[from].trim()) throw new Error(`ade_query_invalid_request: policy_effective ${to} inválido`);
        out[to] = input[from].trim();
      }
      if (input.preview != null) out.preview = input.preview;
      return out;
    },
    validate: validatePolicyEffective,
  },
});
