import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';

export function useConnection() {
  const { serverUrl, setConnectionStatus, setLatency } = useAppStore();
  const intervalRef = useRef(null);

  useEffect(() => {
    // Si no hay URL del servidor, desconectar inmediatamente
    if (!serverUrl) {
      setConnectionStatus('disconnected');
      return;
    }

    const checkConnection = async () => {
      const start = performance.now();
      try {
        // getState (no el closure): el valor capturado quedaba congelado en el
        // del primer render y el estado "connecting" no se mostraba nunca.
        if (useAppStore.getState().connectionStatus === 'disconnected') {
          setConnectionStatus('connecting');
        }
        await api.get('/health');
        const end = performance.now();
        setLatency(Math.round(end - start));
        setConnectionStatus('connected');
      } catch (error) {
        setConnectionStatus('disconnected');
        setLatency(0);
      }
    };

    // Ejecutar chequeo inicial
    checkConnection();

    // Configurar polling cada 15 segundos
    intervalRef.current = setInterval(checkConnection, 15000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [serverUrl, setConnectionStatus, setLatency]);
}
