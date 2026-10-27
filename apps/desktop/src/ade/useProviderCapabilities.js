import { useEffect, useState } from 'react';
import { PROBING_POLL_MS, READY_POLL_MS } from './providerCapabilitiesContract';
import { useCoreQuery } from './useCoreQuery';

/**
 * LXO-135 · Lo que el Core dice que ofrece cada proveedor, vivo. Lee `provider_capabilities`:
 *
 *  · mientras el Core todavía sondea (`status: "probing"`) vuelve a leer cada pocos segundos; cuando ya sabe, cada medio minuto;
 *  · una capability que cambia (`generation`) se ve en la lectura siguiente, sin reiniciar la app;
 *  · si el Core no responde conserva la última foto y lo dice (`stale`), no inventa capabilities;
 *  · con un Core anterior que no conoce la query, `unsupported` es `true` y nada se habilita.
 */
export function useProviderCapabilities({ enabled = true } = {}) {
  const [settled, setSettled] = useState(false);
  const state = useCoreQuery('provider_capabilities', {}, { enabled, pollMs: settled ? READY_POLL_MS : PROBING_POLL_MS });
  const lastStatus = state.data?.status ?? null;
  useEffect(() => {
    setSettled(lastStatus === 'ready');
  }, [lastStatus]);
  const code = typeof state.error === 'string' ? state.error : state.error?.message ?? '';
  return {
    snapshot: state.data ?? null,
    status: state.status,
    error: state.error,
    /** El Core no sabe esta query: se muestra «sin información», no un proveedor por defecto. */
    unsupported: /^(Comando desconocido|ade_query_forbidden|orch_query_forbidden)/.test(code) || code.includes('ForbiddenAction'),
    probing: lastStatus === 'probing',
    retry: state.retry,
    updatedAt: state.updatedAt,
  };
}
