// ExtensionsPanel.jsx — capacidades del agente (linter, terminal remota,
// historial de builds…), no un marketplace de editor: lixbon ya no es un IDE.
import { useState } from 'react';
import { useExtStore } from '../../store/extStore';
import { IconSearch, IconTerminal, IconList, IconRefresh } from '../../components/Icons';

const ROW_ICON = {
  linter: IconList,
  'remote-terminal': IconTerminal,
  'build-history': IconRefresh,
};

export function ExtensionsPanel() {
  const { extensions, toggle, install } = useExtStore();
  const [tab, setTab] = useState('installed'); // 'installed' | 'explore'
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const list = extensions
    .filter((e) => (tab === 'installed' ? e.installed : !e.installed))
    .filter((e) => !q || e.name.toLowerCase().includes(q));

  return (
    <div className="extpanel">
      <div className="extpanel__head">
        <span className="extpanel__title">Extensiones</span>
      </div>

      <div className="extpanel__tabs">
        <button
          className={`extpanel__tab ${tab === 'installed' ? 'is-active' : ''}`}
          onClick={() => setTab('installed')}
        >
          Instaladas
        </button>
        <button
          className={`extpanel__tab ${tab === 'explore' ? 'is-active' : ''}`}
          onClick={() => setTab('explore')}
        >
          Explorar
        </button>
      </div>

      <div className="extpanel__search">
        <IconSearch size={13} />
        <input
          className="extpanel__search-input"
          placeholder="Buscar extensiones…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
      </div>

      <div className="extpanel__body">
        {list.map((ext) => {
          const Icon = ROW_ICON[ext.id] || IconList;
          return (
            <div key={ext.id} className="extpanel__row">
              <span className="extpanel__row-icon"><Icon size={16} /></span>
              <div className="extpanel__row-body">
                <div className="extpanel__row-line">
                  <span className="extpanel__row-name">{ext.name}</span>
                  {ext.installed ? (
                    <button
                      className={`extpanel__switch ${ext.enabled ? 'is-on' : ''}`}
                      onClick={() => toggle(ext.id)}
                      title={ext.enabled ? 'Desactivar' : 'Activar'}
                    >
                      <span className="extpanel__switch-thumb" />
                    </button>
                  ) : (
                    <button className="extpanel__install" onClick={() => install(ext.id)}>
                      Instalar
                    </button>
                  )}
                </div>
                <span className="extpanel__row-desc">{ext.desc}</span>
              </div>
            </div>
          );
        })}
        {list.length === 0 && (
          <p className="filetree__hint">
            {tab === 'installed' ? 'No tienes extensiones instaladas.' : 'No hay más extensiones para explorar.'}
          </p>
        )}
      </div>
    </div>
  );
}
