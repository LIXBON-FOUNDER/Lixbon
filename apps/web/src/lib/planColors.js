// planColors.js — identidad de color de cada plan.
//
// La etiqueta de plan es lo único de la interfaz que lleva color de marca, así
// que cada plan trae su par completo (relleno + tinta) ya contrastado sobre el
// fondo oscuro. Los tres van en chip translúcido; el sólido queda reservado
// para el rol de administrador (ROLE_BADGE).
export const PLAN_BADGES = {
  free: { bg: 'rgba(160, 160, 157, 0.12)', ink: '#A6A6A3' },
  pro: { bg: 'rgba(206, 127, 37, 0.15)', ink: '#D89A55' },
  advance: { bg: 'rgba(140, 160, 56, 0.16)', ink: '#B4C64E' },
};

// El naranja sólido de la marca no es un plan: marca el rol de administrador,
// que es lo único que conviene distinguir de un vistazo en cualquier lista.
export const ROLE_BADGE = { bg: '#CE7F25', ink: '#0E0E0E' };

// Color del nombre del plan sobre fondo oscuro (tarjetas de /planes).
export const PLAN_COLORS = {
  free: '#A6A6A3',
  pro: '#E09A45',
  advance: '#B4C64E',
};

export const planColor = (id) => PLAN_COLORS[id] || PLAN_COLORS.free;

export const planBadge = (id) => PLAN_BADGES[id] || PLAN_BADGES.free;
