import { servidorActual } from './sesion';

const LATIDO_MS = 25000;
const ESPERA_MIN = 1000;
const ESPERA_MAX = 30000;

function urlSocket(llave) {
  const base = servidorActual().replace(/^http/, 'ws');
  return `${base}/ws/team?token=${encodeURIComponent(llave)}`;
}

export function abrirSocket({ llave, cursores, alEvento, alEstado }) {
  let ws = null;
  let intentos = 0;
  let cerradoAposta = false;
  let reintento = null;
  let latido = null;

  const limpiar = () => {
    clearTimeout(reintento);
    clearInterval(latido);
    reintento = null;
    latido = null;
  };

  function espera() {
    const base = Math.min(ESPERA_MIN * 2 ** intentos, ESPERA_MAX);
    return Math.round(base * (0.75 + Math.random() * 0.5));
  }

  function conectar() {
    if (cerradoAposta) return;
    alEstado('conectando');

    try {
      ws = new WebSocket(urlSocket(llave));
    } catch {
      programarReintento();
      return;
    }

    ws.onopen = () => {
      intentos = 0;
      alEstado('conectado');
      enviar({ tipo: 'hola', cursores: cursores() });
      latido = setInterval(() => enviar({ tipo: 'ping' }), LATIDO_MS);
    };

    ws.onmessage = (e) => {
      let evento;
      try {
        evento = JSON.parse(e.data);
      } catch {
        return;
      }
      alEvento(evento);
    };

    ws.onclose = () => {
      clearInterval(latido);
      if (cerradoAposta) return;
      alEstado('sin-conexion');
      programarReintento();
    };

    ws.onerror = () => {};
  }

  function programarReintento() {
    const ms = espera();
    intentos += 1;
    clearTimeout(reintento);
    reintento = setTimeout(conectar, ms);
  }

  function enviar(marco) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(marco));
      return true;
    }
    return false;
  }

  const despertar = () => {
    if (cerradoAposta || (ws && ws.readyState === WebSocket.OPEN)) return;
    clearTimeout(reintento);
    intentos = 0;
    conectar();
  };

  window.addEventListener('online', despertar);
  window.addEventListener('focus', despertar);

  conectar();

  return {
    enviar,
    despertar,
    cerrar() {
      cerradoAposta = true;
      limpiar();
      window.removeEventListener('online', despertar);
      window.removeEventListener('focus', despertar);
      try { ws?.close(); } catch { /* ya estaba cerrado */ }
    },
  };
}
