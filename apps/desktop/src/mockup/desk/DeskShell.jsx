// DeskShell.jsx — el Desktop de Lixbon completo: barra de título con los cinco modos, el modo activo y la barra de estado.
// Marco idéntico al real (clases de studio.css: titlebar, modeswitch, statusbar). El modo Orquestar contiene el ADE acordado
// con el equipo, y el modo Editor el IDE de la maqueta: los dos leen el MISMO Task/Attempt, así que cambiar de modo no pierde el contexto.
import React, { useEffect } from 'react';
import { useStore, fleetCounts, attemptById, taskOf } from '../store';
import { USAGE, PROVIDERS } from '../data';
import { LogoMark } from '../../components/Logo';
import { IconGitBranch } from '../../components/Icons';
import { IconChevronDown, IconSearch } from '../../components/Icons';
import { IconModeAgent, IconModeEditor, IconModeDesign, IconModeGit, IconModeOrch, IconPanelLeft, IconPanelBottom, IconPanelRight, IconGear, IconFolderBar, IconTeamPeople, IconMinimize, IconMaximize, IconClose } from './IdeIcons';
import AdeDesktop from '../ade/AdeDesktop';
import IdeDesktop from '../ide/IdeDesktop';
import Overlays from '../ade/Overlays';
import { ModeSkeleton } from './DeskModes';
import { useDesk, MODES } from './deskStore';
import './realShell.css';
import '../styles/desk.css';

const TABS = [
  { id: 'agent', label: 'Agente', Icon: IconModeAgent },
  { id: 'editor', label: 'Editor', Icon: IconModeEditor },
  { id: 'design', label: 'Diseño', Icon: IconModeDesign },
  { id: 'git', label: 'Git', Icon: IconModeGit },
  { id: 'orch', label: 'Orquestar', Icon: IconModeOrch },
];

function ModeSwitch() {
  const mode = useDesk((d) => d.mode);
  const setMode = useDesk((d) => d.setMode);
  const attention = fleetCounts(useStore()).attention;
  const idx = Math.max(0, TABS.findIndex((t) => t.id === mode));
  return (
    <nav className="modeswitch" aria-label="Modo" style={{ '--idx': idx }}>
      <span className="modeswitch__thumb" />
      {TABS.map(({ id, label, Icon }, i) => (
        <button key={id} type="button" className={`modeswitch__tab ${mode === id ? 'is-active' : ''} ${id === 'orch' && attention > 0 ? 'has-alert' : ''}`}
          onClick={() => setMode(id)} aria-label={label} aria-current={mode === id ? 'page' : undefined} title={`${label} (Alt ${i + 1})`}>
          <Icon size={16} />
          <span className="modeswitch__label">{label}</span>
          {id === 'orch' && attention > 0 && <span className="modeswitch__count" aria-label={`${attention} esperan tu decisión`}>{attention}</span>}
        </button>
      ))}
    </nav>
  );
}

/** Los tres botones de panel mandan sobre los paneles propios de cada modo: mismo sitio, distinto contenido. */
function PanelToggles() {
  const mode = useDesk((d) => d.mode);
  const d = useDesk();
  const s = useStore();
  const ui = s.mockUi;
  const on = {
    left: mode === 'editor' ? ui.explorerOpen : d.left,
    bottom: mode === 'editor' ? ui.terminalOpen : false,
    right: mode === 'editor' ? ui.sidecarOpen : mode === 'orch' ? ui.inspectorOpen : d.right,
  };
  const flip = (k) => {
    if (mode === 'editor' && k === 'left') s.setMockUi({ explorerOpen: !ui.explorerOpen });
    else if (mode === 'editor' && k === 'bottom') s.setMockUi({ terminalOpen: !ui.terminalOpen });
    else if (mode === 'editor' && k === 'right') s.setMockUi({ sidecarOpen: !ui.sidecarOpen });
    else if (mode === 'orch' && k === 'right') { if (s.view !== 'workspace') s.setView('workspace'); s.setMockUi({ inspectorOpen: !ui.inspectorOpen }); }
    else if (k !== 'bottom') d.toggle(k);
  };
  const rightTitle = mode === 'orch' ? 'Detalles de la Task' : mode === 'editor' ? 'Agente' : 'Panel derecho';
  const bottomOff = mode !== 'editor';
  return (
    <div className="ptoggles" role="group" aria-label="Paneles">
      <button type="button" className={`ic tb__ic ${on.left ? 'is-on' : ''}`} onClick={() => flip('left')} title="Panel izquierdo (Ctrl B)" aria-label="Panel izquierdo" aria-pressed={!!on.left}><IconPanelLeft size={18} filled={!!on.left} /></button>
      <button type="button" className={`ic tb__ic ${on.bottom ? 'is-on' : ''} ${bottomOff ? 'is-off' : ''}`} onClick={() => !bottomOff && flip('bottom')} aria-disabled={bottomOff} title={bottomOff ? 'Panel inferior · solo en el Editor' : 'Panel inferior (Ctrl `)'} aria-label="Panel inferior" aria-pressed={!!on.bottom}><IconPanelBottom size={18} filled={!!on.bottom} /></button>
      <button type="button" className={`ic tb__ic ${on.right ? 'is-on' : ''}`} onClick={() => flip('right')} title={`${rightTitle} (Ctrl Alt B)`} aria-label={rightTitle} aria-pressed={!!on.right}><IconPanelRight size={18} filled={!!on.right} /></button>
    </div>
  );
}

function TitleBar() {
  const s = useStore();
  return (
    <header className="titlebar titlebar--ide dk-title">
      <div className="tb__l">
        <button type="button" className="titlebar__brand appmenu__btn" aria-label="Menú de Lixbon"><LogoMark size={18} /><span className="titlebar__word">lixbon</span><IconChevronDown size={12} className="appmenu__chev" /></button>
        <button type="button" className="projbtn tb__proj" title="Proyecto abierto"><IconFolderBar size={16} /><span className="tb__projname">Lixbon Core</span><IconChevronDown size={13} /></button>
      </div>
      <ModeSwitch />
      <div className="tb__r">
        <button type="button" className="ic tb__ic" onClick={() => s.setOverlay({ type: 'jump' })} title="Buscar (Ctrl K)" aria-label="Buscar (Ctrl K)"><IconSearch size={18} /></button>
        <span className="tb__sep" />
        <PanelToggles />
        <span className="tb__sep" />
        <button type="button" className="ic tb__ic" title="Ajustes" aria-label="Ajustes"><IconGear size={18} /></button>
        <button type="button" className="ic tb__ic" title="Lixbon Team" aria-label="Lixbon Team"><IconTeamPeople size={18} /></button>
        <span className="dk-avatar" aria-label="Cuenta">J</span>
        <span className="dk-wc" aria-hidden="true"><IconMinimize size={18} /><IconMaximize size={18} /><IconClose size={18} /></span>
      </div>
    </header>
  );
}

/** Barra de estado compartida: lo que no cambia con el modo (rama del Attempt, agentes, uso, conexión) más lo que lleva a otro modo. */
function StatusBar() {
  const s = useStore();
  const setMode = useDesk((d) => d.setMode);
  const c = fleetCounts(s);
  const a = attemptById(s, s.sel.attemptId);
  const task = taskOf(s, a);
  return (
    <footer className="dk-status">
      <button type="button" className="statusbar__item statusbar__item--strong" onClick={() => setMode('git')} title="Abrir en Git"><IconGitBranch size={12} /><span className="mono">{a.branch || 'plan · sin worktree'}</span></button>
      {a.files > 0 && <span className="statusbar__item">{a.files} cambios</span>}
      <span className="statusbar__item">0 errores</span>
      {c.active > 0 && (
        <button type="button" className="statusbar__item statusbar__item--agent" onClick={() => { setMode('orch'); s.setView('workspace'); }} title={`${task.title} · Attempt ${a.label}`}>
          <LogoMark size={12} motion="giro" />{c.active} {c.active === 1 ? 'agente trabajando' : 'agentes trabajando'}
        </button>
      )}
      {c.attention > 0 && (
        <button type="button" className="statusbar__item dk-need" onClick={() => { setMode('orch'); s.setView('attention'); }}>
          <span className="dot dot--pulse" />{c.attention} esperan tu decisión
        </button>
      )}
      <div className="statusbar__fill" />
      {USAGE.slice(0, 2).map((u) => <button key={u.provider} type="button" className="statusbar__item" onClick={() => { setMode('orch'); s.setView('usage'); }}>{PROVIDERS[u.provider].name} · {u.pct}%</button>)}
      <span className="statusbar__item statusbar__conn is-connected"><span className="dot" />Desktop-PC · Conectado</span>
    </footer>
  );
}

/** Un modo montado pero fuera de juego (inert + visibility) conserva su estado, como RetainedMode del Desktop real. */
function Pane({ id, children }) {
  const active = useDesk((d) => d.mode === id);
  const animate = useDesk((d) => d.via === 'mouse');
  const seq = useDesk((d) => d.seq);
  return (
    <div className={`dk-pane ${active ? 'is-active' : ''}`} data-pane={id} data-fade={active && animate && seq > 0 ? seq : undefined} aria-hidden={!active} inert={!active}>
      {children}
    </div>
  );
}

export default function DeskShell() {
  const s = useStore();
  const mode = useDesk((d) => d.mode);
  const left = useDesk((d) => d.left);
  const right = useDesk((d) => d.right);
  const setMode = useDesk((d) => d.setMode);

  // Alt+1…5 cambia de modo: se repite cientos de veces al día, así que no se anima.
  useEffect(() => {
    const onKey = (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const i = Number(e.key) - 1;
      if (i >= 0 && i < MODES.length) { e.preventDefault(); setMode(TABS[i].id, 'key'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setMode]);

  return (
    <div className="dk mkr" data-surface="desk" data-mode={mode} data-left={left ? 'on' : 'off'} data-right={right ? 'on' : 'off'}>
      <TitleBar />
      <div className="dk__body">
        <Pane id="orch"><AdeDesktop embedded live={mode === 'orch'} /></Pane>
        <Pane id="editor"><IdeDesktop embedded live={mode === 'editor'} /></Pane>
        <Pane id="agent"><ModeSkeleton mode="agent" /></Pane>
        <Pane id="git"><ModeSkeleton mode="git" /></Pane>
        <Pane id="design"><ModeSkeleton mode="design" /></Pane>
      </div>
      <StatusBar />
      <Overlays />
    </div>
  );
}
