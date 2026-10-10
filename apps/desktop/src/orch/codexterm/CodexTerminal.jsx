// CodexTerminal.jsx — VISTA de una pestaña de Codex. El PTY y la suscripción viven en el
// store (codexTermStore): montar repinta y engancha la salida en vivo; desmontar (p. ej. al
// cambiar de modo) suelta la vista pero NO cierra el PTY. Mismo enfoque que AgentTerminal:
// xterm, mínimo de 200 columnas con scroll horizontal (computePtySize).
import { useEffect, useRef } from 'react';
import { acceptSeq } from './codexTermContract';
import { computePtySize } from '../../lib/orchTermSize';
import { useCodexTermStore, attachViewer, codexTermApi, ensureCodexTermEvents } from './codexTermStore';

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
 * Reconexión, en el orden del host: reset(); resize a cols×rows del búfer; escribir data
 * (pantalla de vt100, empieza con \x1b[0m); y solo después los eventos con seq > seq del
 * búfer. Si codex_term_buffer falta o falla, se repinta con el búfer de respaldo del store y
 * se pide UNA vez codex_term_redraw. Devuelve el seq hasta el que ya está pintado.
 */
export async function repaint(term_id, api, term, queue) {
  let host = null;
  let failed = false;
  try { host = await api.buffer(term_id); } catch { host = null; }
  try {
    term.reset();
    if (host) {
      if (host.cols && host.rows) term.resize(host.cols, host.rows);
      if (host.data) term.write(host.data);
    } else {
      failed = true;
      const fb = useCodexTermStore.getState().buffers[term_id];
      if (fb?.data) term.write(fb.data);
    }
  } catch { failed = true; }
  const floor = host ? host.seq : (useCodexTermStore.getState().buffers[term_id]?.seq ?? null);
  for (const ev of queue.splice(0)) {
    if (ev.type === 'output' && acceptSeq(ev.seq, floor)) term.write(ev.data);
  }
  if (failed) api.redraw(term_id).catch(() => {});
  return floor;
}

/**
 * @param {{ tab: { term_id: string, exited?: boolean, code?: number|null }, active?: boolean,
 *   createTerminal?: () => Promise<{ term: any, fit: any }> }} props
 */
export function CodexTerminal({ tab, active = true, createTerminal = makeXterm }) {
  const hostRef = useRef(null);
  const termId = tab.term_id;

  useEffect(() => {
    const api = codexTermApi();
    ensureCodexTermEvents();
    let disposed = false;
    let term = null;
    let ready = false;
    let floor = null;
    let exited = useCodexTermStore.getState().tabs.find((t) => t.term_id === termId)?.exited === true;
    const queue = [];
    let ro = null;
    // Se engancha antes de pedir el búfer para no perder nada entre medias.
    const detach = attachViewer(termId, (ev) => {
      if (!ready) { queue.push(ev); if (ev.type === 'exit') exited = true; return; }
      if (ev.type === 'output') {
        if (!acceptSeq(ev.seq, floor)) return;
        if (ev.seq !== null) floor = ev.seq;
        term.write(ev.data);
      } else if (ev.type === 'exit') {
        exited = true;
        term.write(exitText(ev.code));
      }
    });
    const resize = (fit) => {
      try {
        const dims = fit.proposeDimensions();
        if (!dims) return;
        const { cols, rows } = computePtySize(dims.cols, dims.rows);
        if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
        if (!exited) api.resize(termId, cols, rows).catch(() => {});
      } catch { /* oculto */ }
    };
    (async () => {
      const made = await createTerminal();
      if (disposed) { made.term.dispose(); return; }
      term = made.term;
      term.open(hostRef.current);
      floor = await repaint(termId, api, term, queue);
      if (disposed) return;
      const t = useCodexTermStore.getState().tabs.find((x) => x.term_id === termId);
      if (t?.exited) { exited = true; term.write(exitText(t.code)); }
      ready = true;
      term.onData((data) => { if (!exited) api.write(termId, data).catch(() => {}); });
      resize(made.fit);
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => resize(made.fit));
        ro.observe(hostRef.current);
      }
    })();
    return () => {
      // Solo se suelta la vista: el PTY sigue vivo (se cierra con closeTab o al salir).
      disposed = true;
      detach();
      ro?.disconnect();
      term?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId]);

  return (
    <div className={`orch__term codexterm ${tab.exited ? 'is-exited' : ''}`} style={active ? undefined : { display: 'none' }} data-testid={`codex-term-${termId}`}>
      {!tab.exited && <div className="codexterm__bar"><button type="button" className="lk" title="Pedir al host que vuelva a pintar la pantalla de Codex" onClick={() => codexTermApi().redraw(termId).catch(() => {})} data-testid={`codex-redraw-${termId}`}>Redibujar</button></div>}
      {tab.exited && <div className="codexterm__exit" role="status" data-testid={`codex-exit-${termId}`}>Codex terminó{tab.code === null || tab.code === undefined ? '' : ` con código ${tab.code}`}. La entrada está deshabilitada.</div>}
      <div className="orch__term-host" ref={hostRef} />
    </div>
  );
}
