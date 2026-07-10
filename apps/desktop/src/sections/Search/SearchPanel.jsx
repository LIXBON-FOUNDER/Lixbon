// SearchPanel.jsx — búsqueda global en el workspace (panel izquierdo, Ctrl+Mayús+F).
// La búsqueda la hace Rust (search_in_files); aquí solo se agrupan los
// resultados por archivo y el clic abre el archivo en la línea del match.
import { useState, useRef, useEffect } from 'react';
import { searchInFiles } from '../../lib/tauri';
import { useEditorStore } from '../../store/editorStore';
import { useAppStore } from '../../store/appStore';
import { IconSearch, IconFileCode, IconChevron, IconChevronRight } from '../../components/Icons';

const MAX_HITS = 500; // debe coincidir con SEARCH_MAX_HITS en Rust

export function SearchPanel() {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState(null); // null = sin buscar aún
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState({});
  const inputRef = useRef(null);
  const seqRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const runSearch = async (q) => {
    const seq = ++seqRef.current;
    if (q.trim().length < 2) {
      setHits(null);
      setError('');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await searchInFiles(q);
      if (seq !== seqRef.current) return; // llegó tarde: hay otra búsqueda
      setHits(result);
      setCollapsed({});
    } catch (e) {
      if (seq === seqRef.current) {
        setError(String(e));
        setHits(null);
      }
    } finally {
      if (seq === seqRef.current) setBusy(false);
    }
  };

  // Debounce de 350 ms mientras se escribe
  useEffect(() => {
    const t = setTimeout(() => runSearch(query), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const openHit = async (hit) => {
    useAppStore.getState().setCenterView('editor');
    try {
      await useEditorStore.getState().openFileAtLine(hit.path, hit.name, hit.line);
    } catch (e) {
      setError('No se pudo abrir el archivo: ' + e);
    }
  };

  // Agrupar por archivo conservando el orden
  const groups = [];
  if (hits) {
    const byPath = new Map();
    for (const hit of hits) {
      let group = byPath.get(hit.path);
      if (!group) {
        group = { path: hit.path, name: hit.name, items: [] };
        byPath.set(hit.path, group);
        groups.push(group);
      }
      group.items.push(hit);
    }
  }

  return (
    <div className="searchpanel">
      <div className="searchpanel__box">
        <IconSearch size={15} />
        <input
          ref={inputRef}
          className="searchpanel__input"
          placeholder="Buscar en los archivos…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') runSearch(query); }}
          spellCheck={false}
        />
      </div>

      {error && <p className="filetree__hint">{error}</p>}
      {busy && <p className="filetree__hint">Buscando…</p>}
      {!busy && hits && (
        <p className="filetree__hint">
          {hits.length === 0
            ? 'Sin resultados.'
            : `${hits.length}${hits.length >= MAX_HITS ? '+' : ''} resultados en ${groups.length} archivos`}
        </p>
      )}

      <div className="searchpanel__results">
        {groups.map((group) => {
          const isCollapsed = !!collapsed[group.path];
          return (
            <div key={group.path}>
              <div
                className="searchpanel__file"
                title={group.path}
                onClick={() => setCollapsed((p) => ({ ...p, [group.path]: !isCollapsed }))}
              >
                {isCollapsed ? <IconChevronRight size={12} /> : <IconChevron size={12} open />}
                <IconFileCode size={14} />
                <span className="searchpanel__file-name">{group.name}</span>
                <span className="searchpanel__count">{group.items.length}</span>
              </div>
              {!isCollapsed &&
                group.items.map((hit, i) => (
                  <div
                    key={i}
                    className="searchpanel__hit"
                    onClick={() => openHit(hit)}
                    title={`${group.path}:${hit.line}`}
                  >
                    <span className="searchpanel__line">{hit.line}</span>
                    <span className="searchpanel__text">{hit.text}</span>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
