// AgentTerminal.jsx — terminal en vivo de una tarea del orquestador. El PTY
// lo abrió Rust al lanzar el agente; aquí se reproduce lo que ya escribió y
// se sigue su salida.
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { FONT } from '../editor/TerminalPanel';
import { currentXtermTheme } from '../editor/xtermThemes';
import { watchTheme } from '../editor/themeMode';
import { computePtySize, ptyCols } from '../lib/orchTermSize';

export function AgentTerminal({ task, live, visible = true }) {
  const hostRef = useRef(null);
  const visibleRef = useRef(visible);
  const resizeRef = useRef(null);
  visibleRef.current = visible;

  useEffect(() => {
    // El canvas operativo permanece montado en ADE. Conserva el tamaño del
    // PTY mientras está oculto y lo ajusta al volver a mostrarlo.
    if (visible) resizeRef.current?.();
  }, [visible]);

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
      if (!visibleRef.current) return;
      try {
        // No fit.fit(): eso bajaría las columnas al ancho del panel. Se mide lo
        // que cabe y se aplica el mínimo; si sobra, el contenedor hace scroll.
        const dims = fit.proposeDimensions();
        if (!dims) return;
        const { cols, rows } = computePtySize(dims.cols, dims.rows);
        if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
        invoke('orch_term_resize', { task, cols, rows }).then(() => ptyCols.set(task, cols)).catch(() => {});
      } catch { /* oculto */ }
    };
    resizeRef.current = resize;

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
    const stopThemeWatch = watchTheme(() => { term.options.theme = currentXtermTheme(); });

    return () => {
      disposed = true;
      if (resizeRef.current === resize) resizeRef.current = null;
      ro.disconnect();
      stopThemeWatch();
      unlisten.forEach((u) => u());
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task]);

  return <div className="orch__term"><div className="orch__term-host" ref={hostRef} /></div>;
}
