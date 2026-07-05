// planColors.js — color de identidad de cada plan (copia de apps/web/src/lib/planColors.js).
export const PLAN_COLORS = {
  free: '#676767',
  pro: '#CE7F25',
  advance: '#98A61F',
};

export const planColor = (id) => PLAN_COLORS[id] || PLAN_COLORS.free;
