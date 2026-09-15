const PLANES_CON_VISUALS = ['pro', 'advance'];

export const tieneVisuals = (user) => !!user && (user.role === 'admin' || PLANES_CON_VISUALS.includes(user.plan_id));
