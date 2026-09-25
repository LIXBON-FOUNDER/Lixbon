// BottomDock.jsx — panel inferior del editor: Terminal, Problemas (del
// comprobador del proyecto) y Salida (registro del IDE por canal). El
// terminal sigue montado al cambiar de pestaña: sus PTY viven ahí.
import { useEffect, useMemo, useRef } from 'react';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useAppStore } from '../store/appStore';
import { useFileViewStore } from '../store/fileViewStore';
import { useProblemsStore, problemCounts } from '../store/problemsStore';
import { useOutputStore, CHANNELS } from '../store/outputStore';
import { TerminalPanel } from './TerminalPanel';
import { SpinRing } from '../components/Ring';
import { Switch } from '../components/Switch';
import { IconX, IconRefresh, IconTrash } from '../components/Icons';

function Problems() {
  const { checker, problems, running, error, lastRun, auto, setAuto, run, detect } = useProblemsStore();
  const root = useAppStore((s) => s.workspaceRoot);
  useEffect(() => { detect(); }, [root, detect]);

  const byFile = useMemo(() => {
    const map = new Map();
    for (const p of problems) {
      if (!map.has(p.rel)) map.set(p.rel, []);
      map.get(p.rel).push(p);
    }
    return [...map.entries()];
  }, [problems]);

  return (
    <div className="dockpane">
      <div className="dockpane__bar">
        <span className="dockpane__meta">
          {checker ? `${checker.label} · ${checker.command}` : 'No hay comprobador para esta carpeta (tsconfig.json, Cargo.toml o pyproject.toml).'}
        </span>
        <div className="panelhead__fill" />
        {checker && (
          <>
            <span className="dockpane__meta">Al guardar</span>
            <Switch checked={auto} onChange={setAuto} label="Comprobar al guardar" />
            <button className="ic" onClick={run} disabled={running} title="Comprobar ahora">{running ? <SpinRing size={12} /> : <IconRefresh size={13} />}</button>
          </>
        )}
      </div>
      <div className="dockpane__body scroll">
        {error && <pre className="mono dockpane__error">{error}</pre>}
        {checker && !error && !problems.length && (
          <div className="dockpane__empty">{running ? 'Comprobando…' : lastRun ? 'Sin problemas.' : 'Aún no se ha comprobado. Guarda un archivo o pulsa ↻.'}</div>
        )}
        {byFile.map(([rel, list]) => (
          <section key={rel} className="prob__file">
            <div className="prob__filehead"><span className="mono">{rel}</span><span className="count">{list.length}</span></div>
            {list.map((p, i) => (
              <button key={i} className="prob__row" onClick={() => useFileViewStore.getState().revealLine(p.path, p.line)}>
                <span className={`dot dot--${p.severity === 'error' ? 'danger' : 'warn'}`} />
                <span className="prob__msg">{p.message}</span>
                {p.code && <span className="mono prob__code">{p.code}</span>}
                <span className="mono prob__pos">{p.line}:{p.col}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function Output() {
  const { logs, channel, setChannel, clear, unread } = useOutputStore();
  const lines = logs[channel] || [];
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [lines.length, channel]);
  return (
    <div className="dockpane">
      <div className="dockpane__bar">
        {CHANNELS.map((c) => (
          <button key={c} className={`dockchan ${c === channel ? 'is-active' : ''}`} onClick={() => setChannel(c)}>
            {c}{unread[c] > 0 && c !== channel && <span className="dot dot--accent" />}
          </button>
        ))}
        <div className="panelhead__fill" />
        <button className="ic" onClick={() => clear(channel)} title="Limpiar"><IconTrash size={13} /></button>
      </div>
      <div className="dockpane__body scroll mono out">
        {lines.length === 0 && <div className="dockpane__empty">Nada todavía en {channel}.</div>}
        {lines.map((l, i) => (
          <div key={i} className={`out__line ${l.text.startsWith('$ ') ? 'is-cmd' : ''}`}><span className="out__time">{l.time}</span>{l.text}</div>
        ))}
        <span ref={endRef} />
      </div>
    </div>
  );
}

export function BottomDock({ onClose }) {
  const tab = useWorkbenchStore((s) => s.dockTab);
  const setTab = useWorkbenchStore((s) => s.setDockTab);
  const { errors, warnings } = problemCounts(useProblemsStore((s) => s.problems));
  const unread = useOutputStore((s) => Object.values(s.unread).some((n) => n > 0));
  const TABS = [
    { id: 'terminal', label: 'Terminal' },
    { id: 'problems', label: 'Problemas', count: errors + warnings, tone: errors ? 'danger' : 'warn' },
    { id: 'output', label: 'Salida', dot: unread },
  ];

  return (
    <div className="dock2">
      <div className="dock2__tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`dock2__tab ${tab === t.id ? 'is-active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
            {t.count > 0 && <span className={`count count--${t.tone}`}>{t.count}</span>}
            {t.dot && tab !== t.id && <span className="dot dot--accent" />}
          </button>
        ))}
        <div className="panelhead__fill" />
        <button className="ic" onClick={onClose} title="Ocultar panel (Ctrl `)"><IconX size={14} /></button>
      </div>
      <div className="dock2__body">
        <div className="dock2__pane" style={{ display: tab === 'terminal' ? 'flex' : 'none' }}><TerminalPanel /></div>
        {tab === 'problems' && <Problems />}
        {tab === 'output' && <Output />}
      </div>
    </div>
  );
}
