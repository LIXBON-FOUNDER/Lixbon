// remoteSocket.js — conexión WebSocket de la app con una sesión /remote: recibe
// los eventos del host y manda comandos con acuse. Se mantiene abierta en
// segundo plano unos minutos (Android congela la app, pero el socket sigue
// vivo y al volver lo pendiente llega de golpe); solo se cierra si la app pasa
// BACKGROUND_KEEP_MS fuera o si deja de responder estando delante.

const PING_MS = 20000;
const IDLE_MS = 45000;
const RESUME_PROBE_MS = 5000;
const BACKGROUND_KEEP_MS = 5 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 20000;
const ATTEMPTS_BEFORE_UNSUPPORTED = 2;

let ridSeq = 0;
const newRid = () => `m${Date.now().toString(36)}${(++ridSeq).toString(36)}`;

export function openRemoteSocket({ base, token, sessionId, getSeq, onEvent, onStatus, onEnded, onUnsupported, appState }) {
  let socket = null;
  let link = null;
  let stopped = false;
  let everOpened = false;
  let failed = 0;
  let backoff = 1000;
  let retryTimer = null;
  let backgroundTimer = null;
  let foreground = !appState || appState.currentState !== 'background';
  let lastIn = Date.now();
  const pending = new Map(); // rid → { command, resolve, timer }

  const status = (s) => onStatus?.(s);
  const isOpen = () => link?.open && !link.dead;

  const sendRaw = (obj) => {
    if (!isOpen()) return false;
    try {
      socket.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  };

  const drop = (code = 1006) => {
    if (!link || link.dead) return;
    link.dead = true;
    clearInterval(link.ping);
    clearTimeout(link.probe);
    try {
      socket.close();
    } catch {
      // ya cerrado
    }
    afterClose(code);
  };

  function afterClose(code) {
    if (stopped) return;
    if (code === 4404 || code === 4410) {
      stopped = true;
      flushPending('La sesión remota ya terminó');
      onEnded?.();
      return;
    }
    if (!everOpened && ++failed >= ATTEMPTS_BEFORE_UNSUPPORTED && onUnsupported) {
      stopped = true;
      flushPending(null);
      onUnsupported();
      return;
    }
    if (!foreground && code === 1000) return; // cierre voluntario en segundo plano
    status('reconnecting');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15000);
  }

  function flushPending(detail) {
    for (const [rid, p] of pending) {
      clearTimeout(p.timer);
      p.resolve(detail === null ? { ok: false, retry: true } : { ok: false, detail });
      pending.delete(rid);
    }
  }

  function connect() {
    if (stopped) return;
    clearTimeout(retryTimer);
    const url = `${base.replace(/^http/, 'ws')}/api/remote/sessions/${sessionId}/ws?from_seq=${getSeq()}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      afterClose(1006);
      return;
    }
    socket = ws;
    const me = { open: false, dead: false, ping: null, probe: null };
    link = me;
    status(everOpened ? 'reconnecting' : 'connecting');

    ws.onopen = () => {
      if (me.dead) return;
      ws.send(JSON.stringify({ op: 'auth', token }));
      me.open = true;
      everOpened = true;
      failed = 0;
      backoff = 1000;
      lastIn = Date.now();
      status('open');
      // Lo que no llegó a confirmarse se reenvía con su rid: el gateway
      // descarta los repetidos.
      for (const [rid, p] of pending) sendRaw({ op: 'cmd', rid, command: p.command });
      me.ping = setInterval(() => {
        if (!foreground) return;
        if (Date.now() - lastIn > IDLE_MS) {
          drop(4008);
          return;
        }
        sendRaw({ op: 'ping' });
      }, PING_MS);
    };
    ws.onmessage = (e) => {
      if (me.dead) return;
      lastIn = Date.now();
      clearTimeout(me.probe);
      let ev;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!ev || typeof ev !== 'object' || ev.type === 'ping' || ev.type === 'pong') return;
      if (ev.type === 'ack') {
        const p = pending.get(ev.rid);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(ev.rid);
        p.resolve(ev.ok ? { ok: true } : { ok: false, status: ev.status, detail: ev.detail });
        return;
      }
      onEvent(ev);
    };
    ws.onerror = () => {};
    ws.onclose = (e) => {
      if (me.dead) return;
      me.dead = true;
      clearInterval(me.ping);
      clearTimeout(me.probe);
      afterClose(e?.code ?? 1006);
    };
  }

  const onAppState = (next) => {
    if (stopped) return;
    if (next === 'background') {
      foreground = false;
      clearTimeout(backgroundTimer);
      backgroundTimer = setTimeout(() => {
        if (link && !link.dead) {
          link.dead = true;
          clearInterval(link.ping);
          try {
            socket.close(1000);
          } catch {
            // ya cerrado
          }
        }
        clearTimeout(retryTimer);
      }, BACKGROUND_KEEP_MS);
    } else if (next === 'active' && !foreground) {
      foreground = true;
      clearTimeout(backgroundTimer);
      lastIn = Date.now();
      if (isOpen()) {
        // El socket sobrevivió: un ping confirma que sigue vivo de verdad.
        sendRaw({ op: 'ping' });
        clearTimeout(link.probe);
        const me = link;
        me.probe = setTimeout(() => {
          if (link === me) drop(4008);
        }, RESUME_PROBE_MS);
      } else {
        backoff = 1000;
        connect();
      }
    }
  };
  const sub = appState?.addEventListener('change', onAppState);
  connect();

  return {
    send(command) {
      return new Promise((resolve) => {
        if (stopped) {
          resolve({ ok: false, detail: 'La sesión remota ya terminó' });
          return;
        }
        const rid = newRid();
        const timer = setTimeout(() => {
          pending.delete(rid);
          resolve({ ok: false, detail: 'Sin conexión con el servidor' });
        }, COMMAND_TIMEOUT_MS);
        pending.set(rid, { command, resolve, timer });
        sendRaw({ op: 'cmd', rid, command });
      });
    },
    close() {
      stopped = true;
      sub?.remove();
      clearTimeout(retryTimer);
      clearTimeout(backgroundTimer);
      flushPending('Sesión cerrada');
      if (link && !link.dead) {
        link.dead = true;
        clearInterval(link.ping);
        clearTimeout(link.probe);
        try {
          socket.close(1000);
        } catch {
          // ya cerrado
        }
      }
    },
  };
}
