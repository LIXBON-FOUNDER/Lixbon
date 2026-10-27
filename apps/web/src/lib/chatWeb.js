import { useEffect, useState } from 'react';
import { api } from './api';

// El admin abre o pone en pausa el chat de lixbon.com (Admin › Chat web). En
// pausa, /chat muestra «Puerto tranquilo» en vez de la caja de mensaje. Una sola
// petición por carga; si falla, el chat queda en pausa como antes del interruptor.
let pendiente = null;

export function leerChatWeb() {
  pendiente ??= api.get('/api/web-chat')
    .then((r) => Boolean(r.data.web_chat?.enabled))
    .catch(() => { pendiente = null; return false; });
  return pendiente;
}

// Tras cambiarlo en el admin, la siguiente lectura vuelve a preguntar.
export function olvidarChatWeb() {
  pendiente = null;
}

// null mientras llega la respuesta; luego true (abierto) o false (en pausa).
export function useChatWebAbierto() {
  const [abierto, setAbierto] = useState(null);
  useEffect(() => {
    let vivo = true;
    leerChatWeb().then((v) => { if (vivo) setAbierto(v); });
    return () => { vivo = false; };
  }, []);
  return abierto;
}
