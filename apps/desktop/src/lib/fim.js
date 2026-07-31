// fim.js — cliente del autocompletado fill-in-the-middle (ghost text, B1).
// Recorta el contexto alrededor del cursor y pide la continuación al gateway
// (/api/fim), que la resuelve por el mejor nodo GPU. Efímero: no persiste.

import { useAppStore } from '../store/appStore';

const MAX_PREFIX = 3000; // chars antes del cursor
const MAX_SUFFIX = 1000; // chars después del cursor
const MAX_LINES = 8;     // no invadir con sugerencias enormes

/** Extrae prefijo/sufijo (texto antes/después del cursor) con un presupuesto. */
export function buildFimContext(state, pos) {
  const doc = state.doc.toString();
  return {
    prefix: doc.slice(Math.max(0, pos - MAX_PREFIX), pos),
    suffix: doc.slice(pos, pos + MAX_SUFFIX),
  };
}

/** Limpia la continuación del modelo (vallas accidentales, tope de líneas). */
export function cleanCompletion(text) {
  let t = String(text || '').replace(/\r\n/g, '\n');
  t = t.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '');
  const lines = t.split('\n');
  if (lines.length > MAX_LINES) t = lines.slice(0, MAX_LINES).join('\n');
  // Recorta espacios finales pero conserva la indentación inicial.
  t = t.replace(/[ \t\n]+$/, '');
  return t;
}

// El gateway responde 503 `role_model_unavailable` cuando ningún modelo declara
// la capacidad `insert` (FIM). Sin esta guarda el IDE se comería un 503 por
// pulsación de tecla, así que el autocompletado se apaga solo, una vez.
let fimDesactivadoPorGateway = false;

/** Interpreta un fallo del gateway; true si además hay que apagar el ghost text. */
async function esRolNoDisponible(res) {
  if (res.status !== 503) return false;
  try {
    const body = await res.json();
    return body?.detail?.code === 'role_model_unavailable';
  } catch {
    return false; // cuerpo no-JSON: un 503 cualquiera (nodo caído, etc.)
  }
}

/** Pide una completación FIM. Devuelve '' ante cualquier fallo (es opcional). */
export async function requestFimCompletion({ prefix, suffix, signal }) {
  const { serverUrl, apiKey, contextWindow } = useAppStore.getState();
  const model = useAppStore.getState().effectiveGhostModel();
  if (!model || !serverUrl) return '';
  try {
    const res = await fetch(`${serverUrl}/api/fim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        prefix,
        suffix,
        max_tokens: 96,
        num_ctx: contextWindow,
        stop: ['\n\n\n'],
      }),
      signal,
    });
    if (!res.ok) {
      if (!fimDesactivadoPorGateway && await esRolNoDisponible(res)) {
        fimDesactivadoPorGateway = true;
        console.warn(
          '[fim] El servidor no tiene ningún modelo con FIM (capacidad `insert`); ' +
          'se desactiva el autocompletado. Asigna uno al rol `fim` para reactivarlo.',
        );
        const store = useAppStore.getState();
        store.setGhostText(false);
        // Refrescar los roles: Ajustes debe explicar por qué está deshabilitado.
        store.loadModelRoles();
      }
      return '';
    }
    const data = await res.json();
    return cleanCompletion(data.completion || '');
  } catch {
    return ''; // red/aborto: sin sugerencia
  }
}

/** Permite reintentar tras cambiar de servidor o asignar un modelo al rol. */
export function resetFimAvailability() {
  fimDesactivadoPorGateway = false;
}
