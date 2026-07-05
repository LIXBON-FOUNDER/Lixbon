// planColors.js — color de identidad de cada plan (nombre y badge).
export const PLAN_COLORS = {
  free: '#676767',
  pro: '#CE7F25',
  advance: '#98A61F',
};

export const planColor = (id) => PLAN_COLORS[id] || PLAN_COLORS.free;
