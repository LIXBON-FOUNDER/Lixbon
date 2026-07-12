// Keybindings.jsx — editor de atajos (D5). Lista los comandos del registro y
// permite reasignar su combinación; los cambios se guardan como overrides.
import { useEffect, useState } from 'react';
import { allCommands } from '../../lib/commands';
import { chordForCommand, prettyChord, chordFromEvent, setBinding, resetBindings } from '../../lib/keymap';

export function Keybindings() {
  const [recording, setRecording] = useState(null); // commandId en grabación
  const [, setVersion] = useState(0);
  const bump = () => setVersion((n) => n + 1);

  useEffect(() => {
    if (!recording) return;
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

  const commands = allCommands()
    .slice()
    .sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.title.localeCompare(b.title));

  return (
    <section className="settings__panel">
      <div className="settings__inline settings__inline--spread">
        <h3 className="settings__panel-title" style={{ margin: 0 }}>Atajos de teclado</h3>
        <button className="settings__btn" onClick={() => { resetBindings(); bump(); }}>
          Restaurar por defecto
        </button>
      </div>

      <div className="keybind__list">
        {commands.map((cmd) => (
          <div key={cmd.id} className="keybind__row">
            <span className="keybind__title">
              {cmd.category && <span className="cmd-item__cat">{cmd.category}</span>}
              {cmd.title}
            </span>
            <button
              className={`keybind__chord ${recording === cmd.id ? 'is-recording' : ''}`}
              onClick={() => setRecording(recording === cmd.id ? null : cmd.id)}
              title="Clic y pulsa la nueva combinación (Esc cancela)"
            >
              {recording === cmd.id
                ? 'Pulsa una combinación…'
                : (prettyChord(chordForCommand(cmd.id)) || 'Sin asignar')}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
