import { useCallback, useEffect, useState } from 'react';
import { LOADING_POLL_MS, READY_POLL_MS } from './usageContract';
import { queryAdeCore } from './coreQueries';
import { useCoreQuery } from './useCoreQuery';

/**
 * LXO-206 · El uso de cada proveedor, vivo. Lee `usage_report`, que NUNCA espera a una CLI: devuelve el último informe y el Core
 * consulta en segundo plano. Mientras no hay informe o el Core está consultando, vuelve a leer cada pocos segundos; después, cada 15.
 *
 *  · `refresh()` pide un refresco MANUAL: el Core lo concede como mucho una vez cada 5 s por proveedor y, si se pide demasiado pronto,
 *    atiende con el dato guardado y lo dice (`throttled` en el proveedor);
 *  · si el Core no responde conserva el último informe y lo dice (`status: "stale"`), no inventa datos;
 *  · con un Core anterior que no conoce la query, `unsupported` es `true` y no se pinta ningún uso.
 *
 * Ninguna consulta de aquí llega a un proveedor: todo pasa por el Core.
 */
export function useUsageReport({ enabled = true } = {}) {
  const [settled, setSettled] = useState(false);
  const [manual, setManual] = useState('idle');
  const state = useCoreQuery('usage_report', {}, { enabled, pollMs: settled ? READY_POLL_MS : LOADING_POLL_MS });
  const response = state.data ?? null;
  const live = response ? `${response.status}:${response.refreshing}` : 'none';
  useEffect(() => {
    setSettled(response?.status === 'ready' && response.refreshing === false);
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps
  const { retry } = state;
  const refresh = useCallback(async () => {
    setManual('pending');
    try {
      await queryAdeCore('usage_report', { refresh: true });
      setSettled(false); // mientras el Core consulta, se vuelve a leer a menudo
      retry();
      setManual('idle');
    } catch {
      setManual('error');
    }
  }, [retry]);
  const code = typeof state.error === 'string' ? state.error : state.error?.message ?? '';
  return {
    response,
    report: response?.report ?? null,
    loading: response?.status === 'loading',
    refreshing: response?.refreshing === true,
    status: state.status,
    error: state.error,
    unsupported: /^(Comando desconocido|ade_query_forbidden|orch_query_forbidden)/.test(code) || code.includes('ForbiddenAction'),
    refresh,
    manual,
    retry,
  };
}
