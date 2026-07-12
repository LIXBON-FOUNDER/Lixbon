// CommandPalette.jsx — paleta de comandos (Ctrl+Mayús+P), estilo VSCode.
// Lista los comandos del registro central, filtra por título/categoría/keywords
// con el mismo fuzzy que QuickOpen y ejecuta el elegido. Reutiliza el CSS de
// QuickOpen (.quickopen__*) más un par de clases propias para el chord.
import { useState, useEffect, useRef, useMemo } from 'react';
import { useAppStore } from '../store/appStore';
import { allCommands, runCommand, onCommandsChanged } from '../lib/commands';
import { chordForCommand, prettyChord } from '../lib/keymap';
import { IconChevronRight } from './Icons';

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
  return score;
}

export function CommandPalette() {
  const setCommandPalette = useAppStore((s) => s.setCommandPalette);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [, forceUpdate] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    return onCommandsChanged(() => forceUpdate((n) => n + 1));
  }, []);

  const commands = useMemo(
    () =>
      allCommands()
        .filter((c) => !c.when || c.when())
        .map((c) => ({ ...c, chord: chordForCommand(c.id) })),
    // recomputa en cada apertura y cuando el query cambia el orden importa poco
    [query] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/\s+/g, '');
    if (!q) {
      // Sin query: ordenados por categoría y título
      return [...commands].sort((a, b) =>
        (a.category || '').localeCompare(b.category || '') ||
        a.title.localeCompare(b.title)
      );
    }
    return commands
      .map((c) => {
        const hay = `${c.title} ${c.category || ''} ${c.keywords || ''}`;
        return { c, score: fuzzyScore(hay, q) };
      })
      .filter((m) => m.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((m) => m.c);
  }, [commands, query]);

  useEffect(() => { setSelected(0); }, [query]);

  useEffect(() => {
    listRef.current?.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const close = () => setCommandPalette(false);

  const execute = async (cmd) => {
    close();
    await runCommand(cmd.id);
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
      if (matches[selected]) execute(matches[selected]);
    }
  };

  return (
    <div className="quickopen__overlay" onPointerDown={close}>
      <div className="quickopen" onPointerDown={(e) => e.stopPropagation()}>
        <div className="quickopen__box">
          <IconChevronRight size={15} />
          <input
            ref={inputRef}
            className="quickopen__input"
            placeholder="Escribe el nombre de un comando…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
        </div>
        <div className="quickopen__list" ref={listRef}>
          {matches.length === 0 && (
            <p className="filetree__hint">Sin comandos coincidentes.</p>
          )}
          {matches.map((cmd, i) => (
            <div
              key={cmd.id}
              className={`quickopen__item cmd-item ${i === selected ? 'is-selected' : ''}`}
              onPointerEnter={() => setSelected(i)}
              onClick={() => execute(cmd)}
            >
              {cmd.category && <span className="cmd-item__cat">{cmd.category}</span>}
              <span className="quickopen__name cmd-item__title">{cmd.title}</span>
              {cmd.chord && (
                <span className="cmd-item__chord">{prettyChord(cmd.chord)}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
