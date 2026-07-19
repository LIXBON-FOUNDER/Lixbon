// SearchPanel.jsx — búsqueda global en el workspace (panel izquierdo, Ctrl+Mayús+F).
// La búsqueda la hace Rust (search_in_files); aquí solo se agrupan los
// resultados por archivo y el clic abre el archivo en la línea del match.
import { useState, useRef, useEffect } from 'react';
import { ask } from '@tauri-apps/plugin-dialog';
import { searchInFiles, replaceInFiles } from '../../lib/tauri';
import { useEditorStore } from '../../store/editorStore';
import { useAppStore } from '../../store/appStore';
import { IconSearch, IconFileCode, IconChevron, IconChevronRight } from '../../components/Icons';

const MAX_HITS = 500; // debe coincidir con SEARCH_MAX_HITS en Rust

export function SearchPanel() {
  const [query, setQuery] = useState('');
  const [opts, setOpts] = useState({ caseSensitive: false, wholeWord: false, isRegex: false });
  const [replacement, setReplacement] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [notice, setNotice] = useState('');
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
    setHits([]);
    setCollapsed({});
    // Streaming: Rust va emitiendo lotes por evento mientras recorre el árbol,
    // así los primeros resultados aparecen al instante en repos grandes. El
    // retorno final de searchInFiles es la lista completa y pisa lo parcial.
    const streamId = `s${seq}`;
    let unlisten = null;
    try {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen(`search:hits:${streamId}`, (e) => {
        if (seq !== seqRef.current) return; // de una búsqueda anterior
        const batch = Array.isArray(e.payload) ? e.payload : [];
        if (batch.length) setHits((prev) => [...(prev || []), ...batch]);
      });
      const result = await searchInFiles(q, opts, streamId);
      if (seq !== seqRef.current) return; // llegó tarde: hay otra búsqueda
      setHits(result);
    } catch (e) {
      if (seq === seqRef.current) {
        setError(String(e));
        setHits(null);
      }
    } finally {
      if (unlisten) unlisten();
      if (seq === seqRef.current) setBusy(false);
    }
  };

  // Debounce de 350 ms mientras se escribe o al cambiar opciones
  useEffect(() => {
    const t = setTimeout(() => runSearch(query), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, opts]);

  const openHit = async (hit) => {
    useAppStore.getState().setCenterView('editor');
    try {
      await useEditorStore.getState().openFileAtLine(hit.path, hit.name, hit.line);
    } catch (e) {
      setError('No se pudo abrir el archivo: ' + e);
    }
  };

  const handleReplaceAll = async () => {
    if (query.trim().length < 2 || replacing) return;
    const fileCount = groups.length;
    const ok = await ask(
      `¿Reemplazar «${query}» por «${replacement}» en ${fileCount} archivo(s)? Se escribe en disco y no se puede deshacer.`,
      { title: 'lixbon', kind: 'warning', okLabel: 'Reemplazar todo', cancelLabel: 'Cancelar' }
    );
    if (!ok) return;
    setReplacing(true);
    setNotice('');
    setError('');
    try {
      const res = await replaceInFiles(query, replacement, opts);
      setNotice(`${res.replacements} reemplazo(s) en ${res.files} archivo(s).`);
      await runSearch(query); // refrescar resultados
    } catch (e) {
      setError(String(e));
    } finally {
      setReplacing(false);
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
      <div className="searchpanel__controls">
        <button
          className="searchpanel__toggle"
          title={showReplace ? 'Ocultar reemplazo' : 'Mostrar reemplazo'}
          onClick={() => setShowReplace((v) => !v)}
        >
          {showReplace ? <IconChevron size={12} open /> : <IconChevronRight size={12} />}
        </button>
        <div className="searchpanel__fields">
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
            <div className="searchpanel__opts">
              <button
                className={`searchpanel__opt ${opts.caseSensitive ? 'is-on' : ''}`}
                title="Distinguir mayúsculas y minúsculas"
                onClick={() => setOpts((o) => ({ ...o, caseSensitive: !o.caseSensitive }))}
              >
                Aa
              </button>
              <button
                className={`searchpanel__opt ${opts.wholeWord ? 'is-on' : ''}`}
                title="Palabra completa"
                onClick={() => setOpts((o) => ({ ...o, wholeWord: !o.wholeWord }))}
              >
                <span style={{ textDecoration: 'underline' }}>ab</span>
              </button>
              <button
                className={`searchpanel__opt ${opts.isRegex ? 'is-on' : ''}`}
                title="Usar expresión regular"
                onClick={() => setOpts((o) => ({ ...o, isRegex: !o.isRegex }))}
              >
                .*
              </button>
            </div>
          </div>
          {showReplace && (
            <div className="searchpanel__box searchpanel__box--replace">
              <input
                className="searchpanel__input"
                placeholder="Reemplazar con…"
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleReplaceAll(); }}
                spellCheck={false}
              />
              <button
                className="searchpanel__replace-btn"
                disabled={!hits || hits.length === 0 || replacing || query.trim().length < 2}
                onClick={handleReplaceAll}
                title="Reemplazar todas las coincidencias en el proyecto"
              >
                {replacing ? '…' : 'Reemplazar todo'}
              </button>
            </div>
          )}
        </div>
      </div>

      {notice && <p className="filetree__hint">{notice}</p>}
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
