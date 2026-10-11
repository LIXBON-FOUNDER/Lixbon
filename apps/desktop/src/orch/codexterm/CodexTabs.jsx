// CodexTabs.jsx — lista de pestañas de Codex (barra lateral) y su área (centro).
import { useCodexTermStore } from './codexTermStore';
import { CodexTerminal } from './CodexTerminal';
import { ProviderMark } from '../agent/ProviderMark';
import { folderName } from '../agent/agentIdentity';

export function CodexTabList() {
  const { tabs, activeKey, activate, closeTab } = useCodexTermStore();
  if (!tabs.length) return null;
  return (
    <div className="codextabs" aria-label="Terminales de Codex">
      {tabs.map((t, i) => (
        <div key={t.key} className={`codextabs__item ${t.key === activeKey ? 'is-active' : ''}`}>
          <button type="button" className="codextabs__open" onClick={() => activate(t.key)} data-testid={`codex-tab-${t.key}`}>
            <ProviderMark provider="codex" size={12} /> Codex {i + 1}{t.title || folderName(t.cwd) ? <span className="codextabs__folder"> · {t.title || folderName(t.cwd)}</span> : null}{t.exited ? ` · terminó${t.code === null || t.code === undefined ? '' : ` (${t.code})`}` : ''}
            {(t.model || t.effort) && <span className="codextabs__meta mono" data-testid={`codex-tab-meta-${t.key}`}>{[t.model, t.effort].filter(Boolean).join(' · ')}</span>}
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
