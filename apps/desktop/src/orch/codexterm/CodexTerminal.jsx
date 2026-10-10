// CodexTerminal.jsx — pestaña con la TUI de Codex en un PTY del host. Mismo enfoque que
// AgentTerminal: xterm, mínimo de 200 columnas con scroll horizontal (computePtySize).
import { useEffect, useRef } from 'react';
import { codexTerm as defaultApi } from './codexTermContract';
import { computePtySize } from '../../lib/orchTermSize';
import { useCodexTermStore } from './codexTermStore';

/** xterm real (se importa al montar para que las pruebas puedan inyectar otro). */
async function makeXterm() {
  const [{ Terminal }, { FitAddon }, { Unicode11Addon }, { FONT }, { currentXtermTheme }] = await Promise.all([
    import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/addon-unicode11'),
    import('../../editor/TerminalPanel'), import('../../editor/xtermThemes'),
  ]);
  await document.fonts?.load(`12.5px ${FONT}`).catch(() => {});
  const term = new Terminal({ theme: currentXtermTheme(), fontFamily: FONT, fontSize: 12.5, lineHeight: 1.2, cursorBlink: true, cursorStyle: 'bar', scrollback: 8000, allowProposedApi: true, customGlyphs: true });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  return { term, fit };
}

export const exitText = (code) => `\r\n\x1b[90m[Codex terminó${code === null || code === undefined ? '' : ` con código ${code}`}]\x1b[0m\r\n`;

/**
 * @param {{ tab: { term_id: string, exited?: boolean, code?: number|null }, active?: boolean,
 *   api?: typeof defaultApi, createTerminal?: () => Promise<{ term: any, fit: any }> }} props
 */
export function CodexTerminal({ tab, active = true, api = defaultApi, createTerminal = makeXterm }) {
  const hostRef = useRef(null);
  const termId = tab.term_id;

  useEffect(() => {
    let disposed = false;
    let exited = false;
    let term = null;
    const unlisten = [];
    let ro = null;
    const resize = (fit) => {
      try {
        const dims = fit.proposeDimensions();
        if (!dims) return;
        const { cols, rows } = computePtySize(dims.cols, dims.rows);
        if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
        api.resize(termId, cols, rows).catch(() => {});
      } catch { /* oculto */ }
    };
    (async () => {
      const made = await createTerminal();
      if (disposed) { made.term.dispose(); return; }
      term = made.term;
      term.open(hostRef.current);
      const offOut = await api.onOutput(termId, (text) => term.write(text));
      const offExit = await api.onExit(termId, (code) => {
        exited = true;
        term.write(exitText(code));
        useCodexTermStore.getState().markExit(termId, code);
      });
      if (disposed) { offOut(); offExit(); return; }
      unlisten.push(offOut, offExit);
      term.onData((data) => { if (!exited) api.write(termId, data).catch(() => {}); });
      resize(made.fit);
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => resize(made.fit));
        ro.observe(hostRef.current);
      }
    })();
    return () => {
      disposed = true;
      ro?.disconnect();
      unlisten.forEach((u) => u());
      term?.dispose();
      // Cerrar la pestaña o desmontar cierra el PTY de Codex.
      api.close(termId).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId]);

  return (
    <div className={`orch__term codexterm ${tab.exited ? 'is-exited' : ''}`} style={active ? undefined : { display: 'none' }} data-testid={`codex-term-${termId}`}>
      {tab.exited && <div className="codexterm__exit" role="status" data-testid={`codex-exit-${termId}`}>Codex terminó{tab.code === null || tab.code === undefined ? '' : ` con código ${tab.code}`}. La entrada está deshabilitada.</div>}
      <div className="orch__term-host" ref={hostRef} />
    </div>
  );
}
