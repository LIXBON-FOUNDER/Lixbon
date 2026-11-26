import { FileIcon } from '@lixbon/icons/file-icons';
// QuickOpen.jsx — buscador rápido de archivos (Ctrl+P), estilo VSCode.
// Carga la lista plana del workspace una vez al abrirse y filtra con un
// fuzzy match por subsecuencia (bonus por caracteres consecutivos).
import { useState, useEffect, useId, useRef, useMemo } from 'react';
import { listFiles } from '../lib/tauri';
import { useAppStore } from '../store/appStore';
import { useFileViewStore } from '../store/fileViewStore';
import { IconSearch } from './Icons';
import { fuzzyScore } from '../lib/fuzzy';
import { SearchHighlight } from './SearchHighlight';

export function QuickOpen() {
  const setQuickOpen = useAppStore((s) => s.setQuickOpen);
  const [files, setFiles] = useState([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const uid = useId();
  const listRef = useRef(null);

  useEffect(() => {
    const previous = document.activeElement;
    let alive = true;
    inputRef.current?.focus();
    listFiles()
      .then(value=>{if(alive)setFiles(value);})
      .catch((e) => {if(alive)setError(String(e));});
    return ()=>{alive=false;if(previous?.isConnected)previous.focus();};
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/\s+/g, '');
    if (!q) return files.slice(0, 50);
    return files
      .map((f) => ({ f, score: fuzzyScore(f.rel, q) }))
      .filter((m) => m.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((m) => m.f);
  }, [files, query]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  // Mantener visible la fila seleccionada
  useEffect(() => {
    listRef.current
      ?.querySelector('.is-selected')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const close = () => setQuickOpen(false);

  const openFile = (file) => {
    close();
    const app = useAppStore.getState();
    app.selectNav('explorer');
    useFileViewStore.getState().peek(file.path, file.name);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, Math.max(0, matches.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (matches[selected]) openFile(matches[selected]);
    }
  };

  return (
    <div className="quickopen__overlay" onPointerDown={close}>
      <div className="quickopen" onPointerDown={(e) => e.stopPropagation()}>
        <div className="quickopen__box">
          <IconSearch size={15} />
          <input
            ref={inputRef}
            className="quickopen__input"
            role="combobox"
            aria-label="Ir a archivo"
            aria-autocomplete="list"
            aria-controls={`${uid}-files`}
            aria-expanded="true"
            aria-activedescendant={matches[selected]?`${uid}-file-${selected}`:undefined}
            placeholder="Ir a archivo… (escribe para filtrar)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
        </div>
        <div className="quickopen__list" ref={listRef} role="listbox" id={`${uid}-files`} aria-label="Archivos">
          {error && <p className="filetree__hint">{error}</p>}
          {!error && matches.length === 0 && (
            <p className="filetree__hint">Sin coincidencias.</p>
          )}
          {matches.map((file, i) => (
            <div
              key={file.path}
              id={`${uid}-file-${i}`}
              role="option"
              aria-selected={i===selected}
              className={`quickopen__item ${i === selected ? 'is-selected' : ''}`}
              onPointerEnter={() => setSelected(i)}
              onClick={() => openFile(file)}
            >
              <FileIcon nombre={file.path} size={16} />
              <span className="quickopen__name"><SearchHighlight text={file.name} query={query}/></span>
              <span className="quickopen__rel">{file.rel}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
