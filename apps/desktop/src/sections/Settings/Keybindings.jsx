// Keybindings.jsx — Ajustes → Atajos de teclado. Lista los comandos del
// registro agrupados por categoría y permite reasignar su combinación; los
// cambios se guardan como overrides.
import { useEffect, useMemo, useState } from 'react';
import { allCommands } from '../../lib/commands';
import { chordForCommand, prettyChord, chordFromEvent, setBinding, resetBindings } from '../../lib/keymap';
import { IconKeyboard, IconSearch } from '../../components/Icons';
import { PageHead, SectionHead } from './SettingsParts';

export function Keybindings() {
  const [recording, setRecording] = useState(null); // commandId en grabación
  const [query, setQuery] = useState('');
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((n) => n + 1);

  useEffect(() => {
    if (!recording) return undefined;
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setRecording(null); return; }
      // Exigir al menos un modificador de comando para no capturar teclas sueltas.
      if (!(e.ctrlKey || e.metaKey || e.altKey)) return;
      const chord = chordFromEvent(e);
      if (!chord) return; // solo un modificador
      setBinding(recording, chord);
      setRecording(null);
      bump();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byCat = new Map();
    for (const cmd of allCommands()) {
      const chord = prettyChord(chordForCommand(cmd.id)) || '';
      if (q && !`${cmd.title} ${cmd.category || ''} ${chord}`.toLowerCase().includes(q)) continue;
      const cat = cmd.category || 'General';
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push({ ...cmd, chord });
    }
    return [...byCat.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cat, list]) => [cat, list.sort((a, b) => a.title.localeCompare(b.title))]);
  }, [query, version]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="spage">
      <PageHead icon={IconKeyboard} title="Atajos de teclado" sub="Haz clic en una combinación y pulsa la nueva. Esc cancela.">
        <button className="lk" onClick={() => { resetBindings(); bump(); }}>Restaurar predeterminados</button>
      </PageHead>

      <div className="field field--strong keys__search rise rise--1">
        <IconSearch size={13} />
        <input value={query} placeholder="Buscar un comando o un atajo" onChange={(e) => setQuery(e.target.value)} />
      </div>

      {groups.length === 0 && <span className="srow__hint">{query.trim() ? `Ningún comando coincide con «${query.trim()}».` : 'Todavía no hay comandos registrados.'}</span>}
      {groups.map(([cat, list]) => (
        <section key={cat} className="ssec rise rise--2">
          <SectionHead label={cat} />
          <div className="ssec ssec--card ssec--rows">
            {list.map((cmd) => (
              <div key={cmd.id} className="srow keys__row">
                <span className="srow__label">{cmd.title}</span>
                <button
                  className={`keybind__chord ${recording === cmd.id ? 'is-recording' : ''} ${cmd.chord ? '' : 'is-empty'}`}
                  onClick={() => setRecording(recording === cmd.id ? null : cmd.id)}
                  title="Clic y pulsa la nueva combinación (Esc cancela)"
                >
                  {recording === cmd.id ? 'Pulsa una combinación…' : (cmd.chord || 'Sin asignar')}
                </button>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
