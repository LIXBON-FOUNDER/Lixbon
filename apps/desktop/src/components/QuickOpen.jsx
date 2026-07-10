// QuickOpen.jsx — buscador rápido de archivos (Ctrl+P), estilo VSCode.
// Carga la lista plana del workspace una vez al abrirse y filtra con un
// fuzzy match por subsecuencia (bonus por caracteres consecutivos).
import { useState, useEffect, useRef, useMemo } from 'react';
import { listFiles } from '../lib/tauri';
import { useAppStore } from '../store/appStore';
import { useEditorStore } from '../store/editorStore';
import { IconFileCode, IconSearch } from './Icons';

function fuzzyScore(text, q) {
  const t = text.toLowerCase();
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return -1;
    streak = idx === ti ? streak + 3 : 1;
    score += streak - Math.min(idx - ti, 20) * 0.05;
    ti = idx + 1;
  }
  return score - t.length * 0.01; // desempate: rutas cortas primero
}

export function QuickOpen() {
  const setQuickOpen = useAppStore((s) => s.setQuickOpen);
  const [files, setFiles] = useState([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    listFiles()
      .then(setFiles)
      .catch((e) => setError(String(e)));
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

  const openFile = async (file) => {
    close();
    useAppStore.getState().setCenterView('editor');
    try {
      await useEditorStore.getState().openFile(file.path, file.name);
    } catch (e) {
      alert('Error abriendo el archivo: ' + e);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, matches.length - 1));
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
            placeholder="Ir a archivo… (escribe para filtrar)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
        </div>
        <div className="quickopen__list" ref={listRef}>
          {error && <p className="filetree__hint">{error}</p>}
          {!error && matches.length === 0 && (
            <p className="filetree__hint">Sin coincidencias.</p>
          )}
          {matches.map((file, i) => (
            <div
              key={file.path}
              className={`quickopen__item ${i === selected ? 'is-selected' : ''}`}
              onPointerEnter={() => setSelected(i)}
              onClick={() => openFile(file)}
            >
              <IconFileCode size={15} />
              <span className="quickopen__name">{file.name}</span>
              <span className="quickopen__rel">{file.rel}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
