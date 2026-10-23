// observe/useAttentionList.js — carga de la bandeja de Attention (LXO-109) por el relé (`core_attention`).
// La primera página se vuelve a pedir cuando cambia la snapshot (llegaron Events nuevos) o los filtros; con un
// IDE anterior o sin conexión se muestran las más urgentes de la snapshot, marcadas como parciales.
import { useCallback, useEffect, useReducer, useRef } from 'react';

import { STATUS } from './bootstrap';
import { initialList, listReducer, queryOf } from './attention';

export const ATTENTION_CAPABILITY = 'core_attention';

export function useAttentionList(obs, { active = true } = {}) {
  const [state, dispatch] = useReducer(listReducer, initialList);
  const ref = useRef(state);
  ref.current = state;
  const capability = Array.isArray(obs.capabilities) ? obs.capabilities.includes(ATTENTION_CAPABILITY) : false;
  const status = obs.core?.status;
  const reachable = obs.link === 'open' && obs.hostConnected && status !== STATUS.UNAUTHORIZED && status !== STATUS.VERSION_MISMATCH;
  const snapshot = obs.core?.snapshot;
  const cursor = snapshot?.cursor?.events ?? null;

  // Las más urgentes de la snapshot (caché incluida) mientras no haya lista propia.
  useEffect(() => {
    if (snapshot) dispatch({ type: 'snapshot', items: snapshot.attention?.items || [] });
  }, [snapshot, state.gen]);

  const load = useCallback(
    async (append) => {
      const cur = ref.current;
      if (!capability || !reachable || (append && !cur.cursor)) return;
      const gen = cur.gen;
      dispatch({ type: 'request' });
      const res = await obs.request('core_attention', queryOf(cur.filters, append ? cur.cursor : null));
      if (res.ok) {
        dispatch({ type: 'page', gen, append, items: res.data.items, cursor: res.data.next_cursor, hasMore: res.data.has_more, at: Date.now() });
      } else {
        // Un fallo conserva lo que se veía; con el cursor caducado, «Actualizar» vuelve a la primera página.
        dispatch({ type: 'fail', gen, code: res.code || res.transport });
      }
    },
    [capability, reachable, obs.request],
  );

  useEffect(() => {
    if (active) load(false);
  }, [active, load, state.gen, cursor]);

  const setFilters = useCallback((filters) => dispatch({ type: 'filters', filters }), []);
  const more = useCallback(() => load(true), [load]);
  const refresh = useCallback(() => load(false), [load]);
  return { list: state, setFilters, more, refresh, capability, reachable };
}
