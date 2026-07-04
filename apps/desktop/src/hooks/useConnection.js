import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';

export function useConnection() {
  const { serverUrl, connectionStatus, setConnectionStatus, setLatency } = useAppStore();
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
        if (connectionStatus === 'disconnected') {
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
