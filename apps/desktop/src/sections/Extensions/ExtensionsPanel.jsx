// ExtensionsPanel.jsx — panel de extensiones (Open VSX). Instala el .vsix y
// Rust extrae TODO lo declarativo: temas de color, gramáticas TextMate,
// snippets, temas de iconos y lenguajes. Lo no soportado se avisa (warnings).
import { useState, useEffect, useRef } from 'react';
import { useExtStore } from '../../store/extStore';
import { IconSearch, IconTrash, IconCheck, IconDownload } from '../../components/Icons';

/** Chips de lo que aporta una extensión instalada. */
function ContribChips({ ext }) {
  const chips = [];
  const n = (arr) => (arr || []).length;
  if (n(ext.themes)) chips.push(`${n(ext.themes)} tema${n(ext.themes) > 1 ? 's' : ''}`);
  if (n(ext.grammars)) {
    const langs = [...new Set((ext.grammars || []).map((g) => g.language).filter(Boolean))];
    chips.push(langs.length ? `sintaxis: ${langs.slice(0, 3).join(', ')}` : 'sintaxis');
  }
  if (n(ext.snippets)) {
    const langs = [...new Set((ext.snippets || []).map((s) => s.language))];
    chips.push(`snippets: ${langs.slice(0, 3).join(', ')}`);
  }
  if (n(ext.icon_themes)) chips.push('iconos');
  if (n(ext.languages)) chips.push(`${n(ext.languages)} lenguaje${n(ext.languages) > 1 ? 's' : ''}`);
  if (!chips.length) return null;
  return (
    <div className="extpanel__chips">
      {chips.map((c) => <span key={c} className="extpanel__chip">{c}</span>)}
    </div>
  );
}

export function ExtensionsPanel() {
  const {
    installed, activeTheme, activeIconTheme, results, searching, installing, error,
    search, install, uninstall, applyTheme, resetTheme, applyIconTheme, resetIconTheme,
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
          placeholder="Buscar extensiones en Open VSX…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
      </div>

      <p className="extpanel__note">
        Compatible con lo declarativo de las extensiones de VSCode (Open VSX):
        <strong> temas, sintaxis, snippets e iconos</strong>. El código de las
        extensiones no es ejecutable fuera de VSCode.
      </p>

      {error && <p className="extpanel__error">{error}</p>}

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
                <ContribChips ext={ext} />
                <div className="extpanel__themes">
                  {(ext.themes || []).map((theme) => {
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
                  {(ext.icon_themes || []).map((it) => {
                    const isActive =
                      activeIconTheme?.extId === ext.id && activeIconTheme?.path === it.path;
                    return (
                      <button
                        key={it.path}
                        className={`extpanel__theme ${isActive ? 'is-active' : ''}`}
                        onClick={() => (isActive ? resetIconTheme() : applyIconTheme(ext.id, it))}
                        title={isActive ? 'Quitar (volver a los iconos lixbon)' : 'Usar estos iconos en el explorador'}
                      >
                        {isActive && <IconCheck size={13} />}
                        {it.label} (iconos)
                      </button>
                    );
                  })}
                </div>
                {(ext.warnings || []).map((w) => (
                  <p key={w} className="extpanel__warning">⚠ {w}</p>
                ))}
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
            Busca una extensión (por ejemplo "one dark", "material icon theme",
            "elixir") e instálala: temas, sintaxis, snippets e iconos aplican al
            momento.
          </p>
        )}
      </div>
    </div>
  );
}
