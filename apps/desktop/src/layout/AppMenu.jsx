// AppMenu.jsx — menú clásico del IDE (Archivo, Editar, Ver…) escondido tras la
// marca de la barra de título: está a mano sin ocupar sitio en el diseño.
// También se abre con Alt, como en Windows.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getCommand, runCommand } from '../lib/commands';
import { chordForCommand, prettyChord } from '../lib/keymap';
import { LogoMark } from '../components/Logo';
import { IconChevronDown, IconChevronRight } from '../components/Icons';

const MENUS = [
  { label: 'Archivo', items: ['file.newFile', 'file.newFolder', '-', 'chat.openWorkspace', '-', 'file.save', 'file.saveAll', 'file.close', '-', 'chat.saveMarkdown', '-', 'workbench.openSettings'] },
  { label: 'Editar', items: ['edit.undo', 'edit.redo', '-', 'edit.selectAll', '-', 'edit.find', 'workbench.search'] },
  { label: 'Ver', items: ['workbench.commandPalette', 'workbench.quickOpen', '-', 'mode.agent', 'mode.editor', 'mode.design', 'mode.git', '-', 'workbench.showFiles', 'workbench.search', 'workbench.showExtensions', '-', 'workbench.toggleExplorer', 'workbench.toggleAgent', 'workbench.toggleTerminal', 'view.problems', 'view.output', '-', 'editor.togglePreview', 'editor.splitPreview'] },
  { label: 'Terminal', items: ['terminal.new', '-', 'terminal.run', 'terminal.build', 'terminal.check'] },
  { label: 'Agente', items: ['chat.newConversation', 'chat.showHistory', '-', 'chat.mode.agent', 'chat.mode.plan', 'chat.mode.ask', 'chat.cycleMode', '-', 'chat.undoLast', 'chat.viewLastDiff', '-', 'remote.open', 'chat.init', 'settings.openAgent'] },
  { label: 'Team', items: ['team.open', 'team.dock', '-', 'team.shareSelection'] },
  { label: 'Git', items: ['git.open', '-', 'git.pull', 'git.push', 'git.fetch', '-', 'git.createBranch', 'git.stash', 'git.stashPop'] },
  { label: 'Ayuda', items: ['workbench.commandPalette', 'help.keybindings', '-', 'help.docs', 'help.downloads'] },
];

// Títulos más cortos que los de la paleta, que necesitan contexto propio.
const SHORT = {
  'chat.openWorkspace': 'Abrir carpeta…',
  'chat.saveMarkdown': 'Exportar chat a Markdown…',
  'workbench.openSettings': 'Ajustes',
  'workbench.toggleExplorer': 'Panel lateral',
  'workbench.toggleAgent': 'Panel derecho',
  'workbench.toggleTerminal': 'Panel inferior',
  'chat.cycleMode': 'Alternar modo',
  'chat.toggleAgentMenu': 'Modo y opciones',
};

function Submenu({ items, onDone }) {
  return (
    <div className="appmenu__sub">
      {items.map((id, i) => {
        if (id === '-') return <div key={i} className="appmenu__sep" />;
        const cmd = getCommand(id);
        if (!cmd) return null;
        const chord = chordForCommand(id);
        return (
          <button key={id} className="appmenu__item" onClick={() => { onDone(); runCommand(id); }}>
            <span className="appmenu__label">{SHORT[id] || cmd.title}</span>
            {chord && <span className="appmenu__kbd">{prettyChord(chord)}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function AppMenu() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const [pos, setPos] = useState(null);

  useEffect(() => {
    if (!open) return;
    const r = btnRef.current.getBoundingClientRect();
    setPos({ left: r.left, top: r.bottom + 4 });
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
      else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % MENUS.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + MENUS.length) % MENUS.length); }
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Alt suelto (sin otra tecla en medio) abre o cierra el menú.
  useEffect(() => {
    let armed = false;
    const down = (e) => { armed = e.key === 'Alt' && !e.repeat; };
    const up = (e) => {
      if (e.key === 'Alt' && armed) { e.preventDefault(); setActive(0); setOpen((v) => !v); }
      armed = false;
    };
    const cancel = () => { armed = false; };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('pointerdown', cancel, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('pointerdown', cancel, true);
    };
  }, []);

  return (
    <>
      <button
        ref={btnRef}
        className={`titlebar__brand appmenu__btn ${open ? 'is-open' : ''}`}
        onClick={() => { setActive(0); setOpen((v) => !v); }}
        title="Menú (Alt)"
      >
        <LogoMark size={18} />
        <span className="titlebar__word">lixbon</span>
        <IconChevronDown size={12} className="appmenu__chev" />
      </button>
      {open && pos && createPortal(
        <div className="appmenu" ref={popRef} style={pos} role="menu">
          <div className="appmenu__top">
            {MENUS.map((m, i) => (
              <button
                key={m.label}
                className={`appmenu__item appmenu__root ${i === active ? 'is-active' : ''}`}
                onPointerEnter={() => setActive(i)}
                onClick={() => setActive(i)}
              >
                <span className="appmenu__label">{m.label}</span>
                <IconChevronRight size={12} />
              </button>
            ))}
          </div>
          <Submenu key={active} items={MENUS[active].items} onDone={() => setOpen(false)} />
        </div>,
        document.body,
      )}
    </>
  );
}
