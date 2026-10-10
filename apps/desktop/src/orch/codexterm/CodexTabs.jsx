// CodexTabs.jsx — lista de pestañas de Codex (barra lateral) y su área (centro).
import { useCodexTermStore } from './codexTermStore';
import { CodexTerminal } from './CodexTerminal';

export function CodexTabList() {
  const { tabs, activeKey, activate, closeTab } = useCodexTermStore();
  if (!tabs.length) return null;
  return (
    <div className="codextabs" aria-label="Terminales de Codex">
      {tabs.map((t, i) => (
        <div key={t.key} className={`codextabs__item ${t.key === activeKey ? 'is-active' : ''}`}>
          <button type="button" className="codextabs__open" onClick={() => activate(t.key)} data-testid={`codex-tab-${t.key}`}>
            Codex {i + 1}{t.exited ? ' · terminó' : ''}
          </button>
          <button type="button" className="lk" title="Cerrar la terminal de Codex" onClick={() => closeTab(t.key)} data-testid={`codex-tab-close-${t.key}`}>×</button>
        </div>
      ))}
    </div>
  );
}

/** Vistas de las pestañas (solo la activa visible). El PTY y la salida viven en el store. */
export function CodexTermArea({ createTerminal }) {
  const { tabs, activeKey } = useCodexTermStore();
  return tabs.map((t) => <CodexTerminal key={t.key} tab={t} active={t.key === activeKey} createTerminal={createTerminal} />);
}
