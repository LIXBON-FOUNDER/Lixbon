import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';

export function useWebSocket(endpoint) {
  const { serverUrl, connectionStatus } = useAppStore();
  const [data, setData] = useState(null);
  const [wsStatus, setWsStatus] = useState('disconnected'); // 'connecting' | 'connected' | 'disconnected'
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);

  useEffect(() => {
    if (!serverUrl || connectionStatus !== 'connected') {
      setData(null);
      setWsStatus('disconnected');
      return;
    }

    // Convertir HTTP URL a WS URL
    const wsBaseUrl = serverUrl.replace(/^http/, 'ws');
    const wsUrl = `${wsBaseUrl}${endpoint}`;

    const connect = () => {
      if (wsRef.current) {
        wsRef.current.close();
      }

      setWsStatus('connecting');
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsStatus('connected');
        reconnectAttemptsRef.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          setData(payload);
        } catch (e) {
          console.error('[websocket] Error parseando datos:', e);
        }
      };

      ws.onclose = () => {
        setWsStatus('disconnected');
        
        // Reconectar si el servidor todavía se supone que está conectado
        if (connectionStatus === 'connected' && reconnectAttemptsRef.current < 5) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 10000);
          reconnectAttemptsRef.current += 1;
          reconnectTimeoutRef.current = setTimeout(connect, delay);
        }
      };

      ws.onerror = (err) => {
        console.error('[websocket] Error:', err);
      };
    };

    connect();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [serverUrl, connectionStatus, endpoint]);

  return { data, wsStatus };
}
