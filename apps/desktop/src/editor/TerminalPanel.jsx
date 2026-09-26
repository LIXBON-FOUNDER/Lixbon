// TerminalPanel.jsx — terminales integrados (xterm + PTY Rust). Cada sesión
// monta su propia Terminal; se ocultan (no se desmontan) al cambiar de
// pestaña para preservar el buffer. El PTY vive en el backend.
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { listen } from '@tauri-apps/api/event';

import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { termOpen, termWrite, termResize, termClose } from '../lib/tauri';
import { Select } from '../components/Select';
import { IconX, IconPlus } from '../components/Icons';

const XTERM_THEMES = {
  dark: {
    background: '#111111',
    foreground: '#DCDCD6',
    cursor: '#C6D66E',
    cursorAccent: '#111111',
    selectionBackground: 'rgba(198, 214, 110, 0.25)',
    black: '#1c1c1c', brightBlack: '#6b6b66',
    red: '#e5766b', brightRed: '#f09289',
    green: '#9fc46a', brightGreen: '#c6d66e',
    yellow: '#e2b85c', brightYellow: '#f0cd7c',
    blue: '#7aa7e0', brightBlue: '#9cc0ef',
    magenta: '#c39ae0', brightMagenta: '#d6b5ee',
    cyan: '#6fc2c0', brightCyan: '#92d8d5',
    white: '#dcdcd6', brightWhite: '#f5f5f0',
  },
  light: {
    background: '#f6f7ed',
    foreground: '#171717',
    cursor: '#171717',
    cursorAccent: '#f6f7ed',
    selectionBackground: 'rgba(23, 23, 23, 0.18)',
  },
};

const currentXtermTheme = () =>
  document.documentElement.dataset.theme === 'dark' ? XTERM_THEMES.dark : XTERM_THEMES.light;

const FONT = "'JetBrains Mono Variable', 'JetBrains Mono', 'Cascadia Mono', Consolas, monospace";

const SHELLS = [
  { id: 'powershell', label: 'PowerShell' },
  { id: 'cmd', label: 'cmd' },
  { id: 'bash', label: 'bash' },
];

function TerminalInstance({ session, active }) {
  const hostRef = useRef(null);
  const fitRef = useRef(null);
  const idRef = useRef(null);
  const setSessionId = useTerminalStore((s) => s.setSessionId);

  useEffect(() => {
    const term = new Terminal({
      theme: currentXtermTheme(),
      fontFamily: FONT,
      fontSize: 12.5,
      lineHeight: 1.2,
      letterSpacing: 0,
      fontWeight: 400,
      fontWeightBold: 700,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
      // Dibuja bloques y líneas (logo de Claude Code, separadores ─) como
      // formas en vez de glifos de la fuente: con la fuente quedan huecos.
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = '11';
    fitRef.current = fit;

    let disposed = false;
    let unlistenOut = null;
    let unlistenExit = null;

    // xterm mide la celda al abrir: si la fuente aún no cargó, mide la de
    // reserva y las columnas quedan desalineadas.
    const opened = document.fonts.load(`12.5px ${FONT}`).catch(() => {}).then(() => {
      if (disposed) return;
      term.open(hostRef.current);
      // customGlyphs solo aplica con el renderer WebGL; el DOM usa la fuente.
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch { /* sin WebGL: renderer DOM */ }
    });

    const themeObserver = new MutationObserver(() => {
      term.options.theme = currentXtermTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    (async () => {
      try {
        await opened;
        if (disposed) return;
        // cwd explícito: el PTY nace con él y ya no se puede cambiar.
        const id = await termOpen(session.shell, useAppStore.getState().workspaceRoot || null);
        if (disposed) { termClose(id).catch(() => {}); return; }
        idRef.current = id;
        setSessionId(session.key, id);

        try { fit.fit(); } catch { /* aún sin tamaño */ }
        termResize(id, term.cols, term.rows).catch(() => {});

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
      themeObserver.disconnect();
      if (unlistenOut) unlistenOut();
      if (unlistenExit) unlistenExit();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.key]);

  // Un div oculto no se puede medir: al volver a mostrarse hay que reajustar.
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

  return <div className="terminal-instance" style={{ display: active ? 'block' : 'none' }} ref={hostRef} />;
}

/** Pestañas de sesión y acciones; BottomDock las coloca en su propia barra. */
export function TerminalTabs() {
  const { sessions, activeKey, addSession, closeSession, setActive } = useTerminalStore();
  return (
    <div className="terminal-tabs">
      {sessions.map((s, i) => (
        <button
          key={s.key}
          className={`terminal-tab ${s.key === activeKey ? 'is-active' : ''}`}
          onClick={() => setActive(s.key)}
        >
          <span className="terminal-tab__label">{s.title}{sessions.length > 1 && <span className="terminal-tab__n">{i + 1}</span>}</span>
          <span
            className="terminal-tab__close"
            onClick={(e) => { e.stopPropagation(); closeSession(s.key); }}
            title="Cerrar terminal"
          >
            <IconX size={12} />
          </span>
        </button>
      ))}
      <button className="ic" onClick={() => addSession()} title="Nuevo terminal (Ctrl Shift `)">
        <IconPlus size={14} />
      </button>
      <Select
        className="select--compact terminal-tabs__shell"
        up
        value=""
        placeholder="Shell"
        title="Abrir un terminal con otra shell"
        options={SHELLS.map((sh) => ({ value: sh.id, label: sh.label }))}
        onChange={(shell) => addSession(shell)}
      />
    </div>
  );
}

export function TerminalPanel() {
  const { sessions, activeKey, addSession } = useTerminalStore();
  const workspaceReady = useAppStore((s) => s.workspaceReady);
  const terminalVisible = useAppStore((s) => s.panels.terminal);

  // No antes de conocer la carpeta de trabajo: el PTY hereda el cwd al nacer.
  useEffect(() => {
    if (workspaceReady && terminalVisible && sessions.length === 0) addSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceReady, terminalVisible]);

  return (
    <div className="terminal-panel">
      <div className="terminal-body">
        {sessions.map((s) => (
          <TerminalInstance key={s.key} session={s} active={s.key === activeKey} />
        ))}
        {sessions.length === 0 && <div className="terminal-empty">Sin terminales abiertos.</div>}
      </div>
    </div>
  );
}
