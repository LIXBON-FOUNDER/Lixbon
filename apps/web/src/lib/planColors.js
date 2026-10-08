export const PLAN_BADGES = {
  free: { bg: 'rgba(160, 160, 157, 0.12)', ink: '#A6A6A3' },
  pro: { bg: 'rgba(206, 127, 37, 0.15)', ink: '#D89A55' },
  advance: { bg: 'rgba(140, 160, 56, 0.16)', ink: '#B4C64E' },
};

// El naranja sólido de la marca no es un plan: marca el rol de administrador,
// que es lo único que conviene distinguir de un vistazo en cualquier lista.
export const ROLE_BADGE = { bg: '#CE7F25', ink: '#0E0E0E' };

export const PLAN_COLORS = {
  free: '#A6A6A3',
  pro: '#E09A45',
  advance: '#B4C64E',
};

export const planColor = (id) => PLAN_COLORS[id] || PLAN_COLORS.free;

export const planBadge = (id) => PLAN_BADGES[id] || PLAN_BADGES.free;
