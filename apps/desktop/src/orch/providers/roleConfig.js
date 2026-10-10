// roleConfig.js — proveedor, modelo y esfuerzo de cada rol, calculados a partir de
// la lista de proveedores. No decide políticas: solo arma opciones para la UI.
import { DEFAULT_PROVIDER, EFFORT_LABELS, UNVERIFIED_LABEL, providerLabel } from './providersContract';

/** Config guardada de un rol con `provider`; las viejas (sin provider) pasan a claude. */
export function migrateRoleCfg(cfg, fallback = {}) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  return {
    provider: typeof c.provider === 'string' && c.provider ? c.provider : DEFAULT_PROVIDER,
    model: typeof c.model === 'string' ? c.model : (fallback.model || ''),
    effort: typeof c.effort === 'string' ? c.effort : (fallback.effort || ''),
  };
}

/** Todas las configs de roles migradas (no muta la entrada). */
export function migrateRoles(roles = {}) {
  return Object.fromEntries(Object.entries(roles || {}).map(([id, c]) => [id, migrateRoleCfg(c)]));
}

export const CODEX_CONFIG_MODEL_LABEL = 'Modelo de config.toml de Codex';

/** Opciones del selector de proveedor: los no disponibles salen deshabilitados con su motivo. */
export function providerOptions(providers) {
  return providers.map((p) => ({
    value: p.id,
    label: p.available ? providerLabel(p.id) : `${providerLabel(p.id)} (no disponible)`,
    disabled: !p.available,
    hint: p.available ? undefined : p.disabled_reason || 'No disponible',
  }));
}

/**
 * Opciones de modelo del proveedor. `verified: false` → "sin verificar". Un modelo
 * guardado que el proveedor no lista se conserva (no se cambia en silencio) y sale sin verificar.
 */
export function modelOptions(provider, saved) {
  const list = provider?.models || [];
  const opts = list.map((m) => ({ value: m.id, label: m.verified ? m.label : `${m.label} (${UNVERIFIED_LABEL})`, verified: m.verified }));
  if (saved && !list.some((m) => m.id === saved)) opts.unshift({ value: saved, label: `${saved} (${UNVERIFIED_LABEL})`, verified: false });
  // Codex sin modelo: el host lanza sin --model y Codex usa el de su config.toml (roles.rs, Resolved.model None).
  if (provider?.id === 'codex') opts.unshift({ value: '', label: CODEX_CONFIG_MODEL_LABEL, verified: true });
  return opts;
}

export const isModelVerified = (provider, model) => Boolean(provider?.models?.some((m) => m.id === model && m.verified));

/** Esfuerzos del proveedor; el guardado que no lista se conserva marcado sin verificar. */
export function effortOptions(provider, saved) {
  const list = provider?.efforts || [];
  const label = (e) => `Esfuerzo ${(EFFORT_LABELS[e] || e).toLowerCase()}`;
  const opts = [{ value: '', label: 'Esfuerzo por defecto' }, ...list.map((e) => ({ value: e, label: label(e) }))];
  if (saved && !list.includes(saved)) opts.push({ value: saved, label: `${label(saved)} (${UNVERIFIED_LABEL})` });
  return opts;
}

/** Perfil de permisos de un rol, igual que Profile::for_role del host. */
export const profileForRole = (readOnly) => (readOnly ? 'explorar' : 'delegar_con_revision');
