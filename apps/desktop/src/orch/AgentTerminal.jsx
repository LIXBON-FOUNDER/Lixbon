// AgentTerminal.jsx — terminal en vivo de una tarea del orquestador. El PTY
// lo abrió Rust al lanzar el agente; aquí se reproduce lo que ya escribió y
// se sigue su salida.
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { currentXtermTheme, FONT } from '../editor/TerminalPanel';

export function AgentTerminal({ task, live }) {
  const hostRef = useRef(null);

  useEffect(() => {
    const term = new Terminal({
      theme: currentXtermTheme(),
      fontFamily: FONT,
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 8000,
      allowProposedApi: true,
      customGlyphs: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';

    let disposed = false;
    let ready = false;
    const unlisten = [];
    const resize = () => {
      try {
        fit.fit();
        invoke('orch_term_resize', { task, cols: term.cols, rows: term.rows }).catch(() => {});
      } catch { /* oculto */ }
    };

    (async () => {
      await document.fonts.load(`12.5px ${FONT}`).catch(() => {});
      if (disposed) return;
      term.open(hostRef.current);
      // Lo que llegue mientras se pide el historial ya viene dentro de él.
      unlisten.push(await listen(`orch:term:${task}`, (e) => { if (ready) term.write(e.payload); }));
      unlisten.push(await listen(`orch:term-exit:${task}`, () => term.write('\r\n\x1b[90m[el agente terminó]\x1b[0m\r\n')));
      const past = await invoke('orch_term_buffer', { task }).catch(() => '');
      if (disposed) return;
      if (past) term.write(past);
      else if (!live) term.write('\x1b[90mLa terminal de esta tarea ya no está abierta.\x1b[0m\r\n');
      ready = true;
      resize();
      term.onData((data) => invoke('orch_term_write', { task, data }).catch(() => {}));
    })();

    const ro = new ResizeObserver(resize);
    ro.observe(hostRef.current);
    const themeObserver = new MutationObserver(() => { term.options.theme = currentXtermTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      disposed = true;
      ro.disconnect();
      themeObserver.disconnect();
      unlisten.forEach((u) => u());
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task]);

  return <div className="orch__term" ref={hostRef} />;
}
