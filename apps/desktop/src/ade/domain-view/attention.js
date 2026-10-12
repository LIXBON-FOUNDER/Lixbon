// attention.js — selectores puros sobre Attention. NO calculan Attention: la entrega el cliente (Core, slice G).
// Solo ordenan, agrupan, cuentan y unen con las entidades que la tarjeta necesita.
import { attentionKindInfo, attentionPriority } from '../vocab/vocabulario';

/**
 * Orden de la bandeja: prioridad del kind (posición en el vocabulario; NO hay severidad), luego lo que
 * caduca antes, luego lo más antiguo. Igual que src/orch/attention.js (kind y luego `created` ascendente).
 */
export function sortAttention(items) {
  return [...items].sort((a, b) => attentionPriority(a.kind) - attentionPriority(b.kind)
    || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity)
    || a.createdAt - b.createdAt
    || a.id.localeCompare(b.id));
}

/** Estado por persona y dispositivo: lo pospuesto no estorba hasta que vence el aplazamiento. */
export const visibleAttention = (items, now) => items.filter((i) => !(i.person?.snoozedUntil && i.person.snoozedUntil > now));

/** Grupos en orden de prioridad; los kinds sin elementos no aparecen. */
export function groupAttentionByKind(items) {
  const porKind = new Map();
  for (const i of sortAttention(items)) {
    if (!porKind.has(i.kind)) porKind.set(i.kind, []);
    porKind.get(i.kind).push(i);
  }
  return [...porKind.entries()]
    .sort(([a], [b]) => attentionPriority(a) - attentionPriority(b))
    .map(([kind, lista]) => ({ kind, info: attentionKindInfo(kind), items: lista }));
}

export function countAttention(items) {
  const byKind = {};
  for (const i of items) byKind[i.kind] = (byKind[i.kind] || 0) + 1;
  return { total: items.length, unseen: items.filter((i) => !i.person?.seen).length, byKind };
}

export function attentionByProject(items) {
  const m = {};
  for (const i of items) (m[i.projectId] ||= []).push(i);
  return m;
}

/** Une cada elemento con el proyecto, la task y el intento que la tarjeta muestra. Lo que falte queda en null. */
export function buildAttentionViews(items, { projects = [], tasks = [], attempts = [] } = {}) {
  const proy = new Map(projects.map((p) => [p.id, p]));
  const tar = new Map(tasks.map((t) => [t.id, t]));
  const int = new Map(attempts.map((a) => [a.id, a]));
  return sortAttention(items).map((item) => ({
    item,
    kindInfo: attentionKindInfo(item.kind),
    project: proy.get(item.projectId) || null,
    task: tar.get(item.taskId) || null,
    attempt: int.get(item.attemptId) || null,
  }));
}
