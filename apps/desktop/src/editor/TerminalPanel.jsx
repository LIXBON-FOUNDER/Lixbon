// TerminalPanel.jsx — panel inferior de terminales integrados (xterm + PTY Rust).
// Cada sesión monta su propia Terminal de xterm; se ocultan (no se desmontan) al
// cambiar de pestaña para preservar el buffer. El PTY vive en el backend.
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { listen } from '@tauri-apps/api/event';

import { useTerminalStore } from '../store/terminalStore';
import { termOpen, termWrite, termResize, termClose } from '../lib/tauri';
import { IconX, IconPlus, IconChevronDown } from '../components/Icons';

const XTERM_THEME = {
  background: '#171717',
  foreground: '#e7e7de',
  cursor: '#d9e64a',
  cursorAccent: '#171717',
  selectionBackground: 'rgba(217, 230, 74, 0.30)',
};

const SHELLS = [
  { id: 'powershell', label: 'PowerShell' },
  { id: 'cmd', label: 'cmd' },
  { id: 'bash', label: 'bash' },
];

// Instancia individual: mantiene su xterm mientras la sesión exista.
function TerminalInstance({ session, active }) {
  const hostRef = useRef(null);
  const fitRef = useRef(null);
  const idRef = useRef(null);
  const setSessionId = useTerminalStore((s) => s.setSessionId);

  useEffect(() => {
    const term = new Terminal({
      theme: XTERM_THEME,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fitRef.current = fit;

    let disposed = false;
    let unlistenOut = null;
    let unlistenExit = null;

    (async () => {
      try {
        const id = await termOpen(session.shell);
        if (disposed) { termClose(id).catch(() => {}); return; }
        idRef.current = id;
        setSessionId(session.key, id);

        try { fit.fit(); } catch { /* aún sin tamaño */ }
        termResize(id, term.cols, term.rows).catch(() => {});

        // Si Run/Build o Git dejaron un comando encolado, ejecutarlo ya.
        const pending = useTerminalStore.getState().takePending(session.key);
        if (pending) termWrite(id, pending + '\r').catch(() => {});

        term.onData((data) => termWrite(id, data).catch(() => {}));
        unlistenOut = await listen(`term:out:${id}`, (e) => term.write(e.payload));
        unlistenExit = await listen(`term:exit:${id}`, () =>
          term.write('\r\n\x1b[90m[sesión finalizada]\x1b[0m\r\n'),
        );
      } catch (e) {
        term.write(`\r\n\x1b[31mNo se pudo abrir el terminal: ${e}\x1b[0m\r\n`);
      }
    })();

    const ro = new ResizeObserver(() => {
      if (!idRef.current) return;
      try {
        fit.fit();
        termResize(idRef.current, term.cols, term.rows).catch(() => {});
      } catch { /* oculto */ }
    });
    ro.observe(hostRef.current);

    return () => {
      disposed = true;
      ro.disconnect();
      if (unlistenOut) unlistenOut();
      if (unlistenExit) unlistenExit();
      term.dispose();
    };
    // Solo al montar/desmontar la sesión.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.key]);

  // Al volver a estar visible hay que reajustar (un div oculto no se puede medir).
  useEffect(() => {
    if (!active || !fitRef.current || !idRef.current) return;
    const t = setTimeout(() => {
      try {
        fitRef.current.fit();
        const dims = fitRef.current.proposeDimensions();
        if (dims) termResize(idRef.current, dims.cols, dims.rows).catch(() => {});
      } catch { /* noop */ }
    }, 0);
    return () => clearTimeout(t);
  }, [active]);

  return (
    <div
      className="terminal-instance"
      style={{ display: active ? 'block' : 'none' }}
      ref={hostRef}
    />
  );
}

export function TerminalPanel() {
  const { sessions, activeKey, addSession, closeSession, setActive } = useTerminalStore();
  const pickerRef = useRef(null);

  // Abre una sesión por defecto la primera vez que se muestra el panel.
  useEffect(() => {
    if (sessions.length === 0) addSession('powershell');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPick = (e) => {
    const shell = e.target.value;
    if (shell) { addSession(shell); e.target.value = ''; }
  };

  return (
    <div className="terminal-panel">
      <div className="terminal-tabs">
        {sessions.map((s) => (
          <button
            key={s.key}
            className={`terminal-tab ${s.key === activeKey ? 'is-active' : ''}`}
            onClick={() => setActive(s.key)}
          >
            <span className="terminal-tab__label">{s.title}</span>
            <span
              className="terminal-tab__close"
              onClick={(e) => { e.stopPropagation(); closeSession(s.key); }}
              title="Cerrar terminal"
            >
              <IconX size={13} />
            </span>
          </button>
        ))}

        <div className="terminal-tabs__actions">
          <button
            className="icon-btn"
            onClick={() => addSession('powershell')}
            title="Nuevo terminal"
          >
            <IconPlus size={15} />
          </button>
          <div className="terminal-shell-picker" ref={pickerRef}>
            <select onChange={onPick} defaultValue="" title="Elegir shell">
              <option value="" disabled>Shell…</option>
              {SHELLS.map((sh) => (
                <option key={sh.id} value={sh.id}>{sh.label}</option>
              ))}
            </select>
            <IconChevronDown size={13} />
          </div>
        </div>
      </div>

      <div className="terminal-body">
        {sessions.map((s) => (
          <TerminalInstance key={s.key} session={s} active={s.key === activeKey} />
        ))}
        {sessions.length === 0 && (
          <div className="terminal-empty">Sin terminales abiertos.</div>
        )}
      </div>
    </div>
  );
}
