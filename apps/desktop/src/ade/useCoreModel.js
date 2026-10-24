import { useCoreQuery } from './useCoreQuery';
import { coreErrorCode, isLegacyModelCode } from './coreModelContract';

/**
 * ÚNICO lugar del ADE que decide entre el modelo `legacy` (lecturas F2) y `task_attempt_v1`
 * (lecturas vNext de LXO-119). Ningún componente vuelve a mirar `core_model` por su cuenta.
 *
 * · `core_model` responde siempre en un Core con LXO-119; antes del corte dice `legacy`.
 * · Un Core anterior a LXO-119 no conoce la query (`query_unsupported`): también es `legacy`, no un
 *   error. Lo mismo `core_model_inactive` si una lectura vNext lo devuelve.
 * · Mientras no hay respuesta, `mode` es `unknown`: nadie pide lecturas vNext ni presenta Attempts.
 * · Cualquier otro fallo es `error` y la UI sigue con F2 (nunca inventa Attempts).
 *
 * `modelKey` cambia cuando cambia el modelo: los cursores guardados se descartan con él.
 */
export function useCoreModel({ active = true, pollMs } = {}) {
  const state = useCoreQuery('core_model', {}, { enabled: active, ...(pollMs ? { pollMs } : {}) });
  return coreModelFromState(state);
}

/** Antes de saber nada del Core: ni vNext ni aviso de legacy. */
export const UNKNOWN_CORE_MODEL = Object.freeze({ mode: 'unknown', vNext: false, code: null, modelKey: 'unknown', retry: undefined });

export function coreModelFromState(state) {
  const model = state.data?.core_model;
  if (model === 'task_attempt_v1' || model === 'legacy') {
    // LXO-234: `storage` dice si el almacén se rechazó al abrir (p. ej. `core_cut_legacy_numbering`).
    const storage = state.data?.storage && typeof state.data.storage === 'object' ? state.data.storage : null;
    // LXO-123: `compat` decide la ventana del shim de navegación F2 (`legacy_task_v1`).
    const compat = Array.isArray(state.data?.compat) ? state.data.compat.filter((c) => typeof c === 'string') : [];
    return { mode: model, vNext: model === 'task_attempt_v1', code: null, modelKey: model, retry: state.retry, storage, compat };
  }
  if (state.error) {
    const code = coreErrorCode(state.error);
    if (isLegacyModelCode(code)) return { mode: 'legacy', vNext: false, code, modelKey: 'legacy', retry: state.retry };
    return { mode: 'error', vNext: false, code, modelKey: 'error', retry: state.retry };
  }
  return { mode: 'unknown', vNext: false, code: null, modelKey: 'unknown', retry: state.retry };
}
