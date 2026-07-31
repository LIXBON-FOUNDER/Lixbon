// modelRoles.js — cliente de GET /api/model-roles.
//
// El gateway decide qué modelo sirve cada rol de inferencia (chat, fim, vision,
// embed, route) según lo que los modelos declaran saber hacer (`capabilities` de
// Ollama). El IDE lo consulta en vez de adivinar por el nombre: adivinar es lo
// que hacía que el autocompletado acabara disparando un modelo de razonamiento
// de 5 GB en cada pulsación de tecla.
//
// Un gateway antiguo no tiene el endpoint ⇒ `null`, y el IDE cae a sus
// heurísticos de siempre. `null` significa "no lo sé", nunca "no hay modelo".

import { api } from './api';
import { modelId } from './vision';

/** Roles del gateway, en el orden en que se muestran en Ajustes. */
export const ROLE_ORDER = ['chat', 'fim', 'vision', 'embed', 'route'];

/** Pide el mapa rol→modelo. Devuelve null si el gateway no lo soporta o falla. */
export async function fetchModelRoles() {
  try {
    const res = await api.get('/api/model-roles');
    if (!res || typeof res.roles !== 'object' || !res.roles) return null;
    return res;
  } catch (e) {
    // 404 = gateway anterior a los roles; cualquier otro fallo se degrada igual.
    console.warn('[roles] /api/model-roles no disponible:', e?.message || e);
    return null;
  }
}

/** Modelo asignado a `role`, o '' si el rol no se puede servir / no se sabe.
    Ojo: '' con `roles` cargado significa "el gateway dice que no hay ninguno". */
export function roleModel(roles, role) {
  return (roles?.roles?.[role]?.model) || '';
}

/** Aviso del gateway para ese rol (qué instalar), o ''. */
export function roleWarning(roles, role) {
  return (roles?.roles?.[role]?.warning) || '';
}

/** Capacidad que exige un rol según el gateway ('' si no la declara). */
export function roleCapability(roles, role) {
  return (roles?.capability_by_role?.[role]) || '';
}

/** ¿`model` declara `capability`?
    Capabilities desconocidas (node_agent viejo, o modelo ausente del catálogo)
    ⇒ true: "desconocido" no es "no sirve", y no se puede descartar por ello. */
export function hasCapability(catalog, model, capability) {
  if (!capability) return true;
  const buscado = normalizeModel(model);
  for (const m of catalog || []) {
    if (normalizeModel(modelId(m)) !== buscado) continue;
    const caps = m?.capabilities;
    if (!Array.isArray(caps) || caps.length === 0) return true; // desconocidas
    return caps.includes(capability);
  }
  return true; // no está en el catálogo: no se sabe
}

/** Ids del catálogo que sirven para `capability` (los desconocidos incluidos). */
export function modelsForCapability(catalog, capability) {
  return (catalog || [])
    .map(modelId)
    .filter((id) => id && hasCapability(catalog, id, capability));
}

/** Ignora `:latest` al comparar: el env/BD dice `nomic-embed-text` y
    /api/tags devuelve `nomic-embed-text:latest`. Es el mismo modelo. */
export function normalizeModel(model) {
  const s = String(model || '').trim();
  return s.endsWith(':latest') ? s.slice(0, -':latest'.length) : s;
}
