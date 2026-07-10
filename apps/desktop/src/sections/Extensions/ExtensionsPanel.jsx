// ExtensionsPanel.jsx — panel de extensiones (temas de VSCode desde Open VSX).
// Busca en el registro público, instala el .vsix (Rust extrae los temas) y
// permite aplicar cualquiera de sus temas al editor.
import { useState, useEffect, useRef } from 'react';
import { useExtStore } from '../../store/extStore';
import { IconSearch, IconTrash, IconCheck, IconDownload } from '../../components/Icons';

export function ExtensionsPanel() {
  const {
    installed, activeTheme, results, searching, installing, error,
    search, install, uninstall, applyTheme, resetTheme,
  } = useExtStore();
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounce de búsqueda en Open VSX
  useEffect(() => {
    const t = setTimeout(() => search(query), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const isInstalled = (r) => installed.some((e) => e.id === `${r.namespace}.${r.name}`);

  return (
    <div className="extpanel">
      <div className="searchpanel__box">
        <IconSearch size={15} />
        <input
          ref={inputRef}
          className="searchpanel__input"
          placeholder="Buscar temas en Open VSX…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
      </div>

      <p className="extpanel__note">
        Compatible con <strong>temas de color</strong> de VSCode (Open VSX). Las
        extensiones con código no son ejecutables fuera de VSCode.
      </p>

      {error && <p className="filetree__hint">{error}</p>}

      <div className="extpanel__body">
        {/* Instaladas */}
        {installed.length > 0 && (
          <>
            <div className="extpanel__section">Instaladas</div>
            {installed.map((ext) => (
              <div key={ext.id} className="extpanel__card">
                <div className="extpanel__card-head">
                  <span className="extpanel__name" title={ext.id}>{ext.display_name}</span>
                  <button
                    className="icon-btn extpanel__remove"
                    title="Desinstalar"
                    onClick={() => uninstall(ext.id)}
                  >
                    <IconTrash size={14} />
                  </button>
                </div>
                <div className="extpanel__themes">
                  {ext.themes.map((theme) => {
                    const isActive =
                      activeTheme?.extId === ext.id && activeTheme?.file === theme.file;
                    return (
                      <button
                        key={theme.file}
                        className={`extpanel__theme ${isActive ? 'is-active' : ''}`}
                        onClick={() => (isActive ? resetTheme() : applyTheme(ext.id, theme))}
                        title={isActive ? 'Quitar (volver al tema lixbon)' : 'Aplicar este tema'}
                      >
                        {isActive && <IconCheck size={13} />}
                        {theme.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {activeTheme && (
              <button className="extpanel__reset" onClick={resetTheme}>
                Volver al tema lixbon
              </button>
            )}
          </>
        )}

        {/* Resultados de Open VSX */}
        {searching && <p className="filetree__hint">Buscando en Open VSX…</p>}
        {!searching && query.trim() && results.length === 0 && !error && (
          <p className="filetree__hint">Sin resultados.</p>
        )}
        {results.length > 0 && <div className="extpanel__section">Open VSX</div>}
        {results.map((r) => {
          const id = `${r.namespace}.${r.name}`;
          return (
            <div key={id} className="extpanel__card">
              <div className="extpanel__card-head">
                {r.files?.icon && (
                  <img src={r.files.icon} alt="" className="extpanel__icon" draggable={false} />
                )}
                <span className="extpanel__name" title={id}>
                  {r.displayName || r.name}
                </span>
              </div>
              {r.description && <p className="extpanel__desc">{r.description}</p>}
              <div className="extpanel__meta">
                <span>{r.namespace}</span>
                {r.downloadCount != null && (
                  <span>· {Intl.NumberFormat('es').format(r.downloadCount)} descargas</span>
                )}
              </div>
              <button
                className="pill-btn pill-btn--outline extpanel__install"
                disabled={installing === id || isInstalled(r)}
                onClick={() => install(r)}
              >
                <IconDownload size={14} />
                {isInstalled(r) ? 'Instalada' : installing === id ? 'Instalando…' : 'Instalar'}
              </button>
            </div>
          );
        })}

        {!query.trim() && results.length === 0 && installed.length === 0 && (
          <p className="filetree__hint">
            Busca un tema (por ejemplo "dracula", "one dark", "night owl") y aplícalo
            al editor.
          </p>
        )}
      </div>
    </div>
  );
}
