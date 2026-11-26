import { GlobalSearch } from '../components/GlobalSearch';
import { useGitStore } from '../store/gitStore';
// TitleBar.jsx — barra de ventana propia (decorations: false): marca,
// proyecto, selector de modo, buscador desplegable, paneles, cuenta y los
// controles de ventana. En modo minimal (sin sesión) solo marca y controles.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useRemoteStore } from '../store/remoteStore';
import { useShallow } from 'zustand/react/shallow';
import { useWorkbenchStore, selectSidePanels, selectRightDrawer } from '../store/workbenchStore';
import { useOrchStore } from '../store/orchStore';
import { usePendingSpawnsStore } from '../orch/spawn/pendingSpawnsStore';
import { useAttentionTotals } from '../orch/useAttention';
import { pickDirectory } from '../lib/tauri';
import { chordForCommand, prettyChord } from '../lib/keymap';
import { useIsCompact } from '../lib/frameSize';
import { LogoMark } from '../components/Logo';
import { Popover } from '../components/Popover';
import { TeamButton } from './TeamButton';
import { AccountMenu } from './AccountMenu';
import { AppMenu } from './AppMenu';
import { WindowControls } from './WindowControls';
import {
  IconChevronDown, IconFolderOpen, IconTerminal,
} from '../components/Icons';
import {
  IconModeAgent, IconModeEditor, IconModeDesign, IconModeGit, IconModeOrch,
  IconPanelLeft, IconPanelBottom, IconPanelRight, IconGear, IconFolderBar,
} from '../components/IdeIcons';

// Cinco modos, del mismo ancho y siempre en este orden. El icono y el nombre
// van juntos: bajo 1400 px solo queda el icono (el nombre sale en el tooltip).
const MODE_TABS = [
  { id: 'agent', label: 'Agente', Icon: IconModeAgent },
  { id: 'editor', label: 'Editor', Icon: IconModeEditor },
  { id: 'design', label: 'Diseño', Icon: IconModeDesign },
  { id: 'git', label: 'Git', Icon: IconModeGit },
  { id: 'orch', label: 'ADE', Icon: IconModeOrch },
];

const baseName = (p) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '');

function ModeSwitch() {
  const mode = useWorkbenchStore((s) => s.mode);
  const setMode = useWorkbenchStore((s) => s.setMode);
  const orchOn = useOrchStore((s) => !!s.snap?.settings?.enabled);
  const attention = useAttentionTotals();
  useEffect(() => { useOrchStore.getState().init(); }, []);
  useEffect(() => { if (orchOn) usePendingSpawnsStore.getState().start(); }, [orchOn]);
  // El orquestador es experimental: su pestaña solo aparece si está activado.
  const tabs = orchOn || mode === 'orch' ? MODE_TABS : MODE_TABS.filter((t) => t.id !== 'orch');
  const idx = Math.max(0, tabs.findIndex((t) => t.id === mode));
  return (
    <nav className="modeswitch" aria-label="Modos" style={{ '--idx': idx }}>
      <span className="modeswitch__thumb" />
      {tabs.map(({ id, label, Icon }) => {
        const chord = prettyChord(chordForCommand(`mode.${id}`));
        return (
          <button
            key={id}
            className={`modeswitch__tab ${mode === id ? 'is-active' : ''} ${id === 'orch' && attention.total > 0 ? 'has-alert' : ''}`}
            onClick={() => setMode(id)}
            aria-label={label}
            aria-current={mode === id ? 'page' : undefined}
            title={chord ? `${label} (${chord})` : label}
          >
            <Icon size={16} />
            <span className="modeswitch__label">{label}</span>
            {id === 'orch' && attention.total > 0 && <span className="modeswitch__count" aria-label={`${attention.total} esperan tu decisión`}>{attention.total}</span>}
          </button>
        );
      })}
    </nav>
  );
}

function ProjectMenu() {
  const branch = useGitStore((state) => state.branch);
  const { workspaceRoot, recentFolders, openWorkspace } = useAppStore();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const close = useCallback(() => setOpen(false), []);

  const choose = async (path) => {
    close();
    if (path) await openWorkspace(path).catch(() => {});
  };
  const browse = async () => {
    close();
    const dir = await pickDirectory({ title: 'Abrir carpeta' });
    if (dir) await openWorkspace(dir).catch(() => {});
  };

  return (
    <>
      <button ref={ref} className="projbtn tb__proj" onClick={() => setOpen((v) => !v)} title={workspaceRoot || 'Abrir una carpeta'}>
        <IconFolderBar size={16} />
        <span className="tb__projname">{baseName(workspaceRoot) || 'Sin carpeta'}</span>
        {branch && <span className="tb__branch">{branch}</span>}
        <IconChevronDown size={13} />
      </button>
      <Popover anchorRef={ref} open={open} onClose={close} className="menu">
        {branch && <button className="menu__item" onClick={() => { close(); useWorkbenchStore.getState().setMode('git'); }}><span className="menu__main">Rama · {branch}</span><span className="menu__hint">Cambiar en Git</span></button>}
        <div className="menu__label">Recientes</div>
        {recentFolders.length === 0 && <div className="menu__empty">Todavía no hay carpetas recientes</div>}
        {recentFolders.map((p) => (
          <button key={p} className={`menu__item ${p === workspaceRoot ? 'is-current' : ''}`} onClick={() => choose(p)} title={p}>
            <span className="menu__main">{baseName(p)}</span>
            <span className="menu__hint">{p}</span>
          </button>
        ))}
        <div className="menu__sep" />
        <button className="menu__item" onClick={browse}>
          <IconFolderOpen size={16} />
          <span className="menu__main">Abrir carpeta…</span>
          <span className="menu__kbd">Ctrl O</span>
        </button>
      </Popover>
    </>
  );
}

function SettingsButton() {
  const open = useWorkbenchStore((s) => s.page === 'settings');
  const openSettings = useWorkbenchStore((s) => s.openSettings);
  const closePage = useWorkbenchStore((s) => s.closePage);
  return (
    <button className={`ic tb__ic ${open ? 'is-on' : ''}`} onClick={() => (open ? closePage() : openSettings())} title="Ajustes" aria-label="Ajustes" aria-pressed={open}>
      <IconGear size={18} />
    </button>
  );
}

// Lo que abre el botón derecho depende del modo: en Agente son los cambios,
// en el resto es el agente de la conversación activa.
const RIGHT_TITLE = { agent: 'Cambios', editor: 'Agente', design: 'Agente', git: 'Agente', orch: 'Agente' };

// Siempre los tres, en el mismo sitio. El inferior solo existe en el Editor:
// fuera de él se queda atenuado en lugar de desaparecer y mover a los demás.
function PanelToggles() {
  const mode = useWorkbenchStore((s) => s.mode);
  const orchView = useWorkbenchStore((s) => s.orchView);
  const { left, right } = useWorkbenchStore(useShallow(selectSidePanels));
  const { toggleSide, toggleAgent } = useWorkbenchStore();
  const terminalOpen = useAppStore((s) => s.panels.terminal);
  const toggleTerminal = useAppStore((s) => s.toggleTerminal);
  const inEditor = mode === 'editor';
  // Con la ventana estrecha el panel derecho es un cajón: el botón sigue siendo el mismo.
  const drawer = useWorkbenchStore(selectRightDrawer);
  const rightOn = useIsCompact() ? drawer : right;
  const rightTitle = mode === 'orch' && orchView === 'ade' ? 'Inspector' : RIGHT_TITLE[mode] || 'Agente';
  return (
    <div className="ptoggles" role="group" aria-label="Paneles">
      <button
        className={`ic tb__ic ${inEditor && terminalOpen ? 'is-on' : ''} ${inEditor ? '' : 'is-off'}`}
        onClick={inEditor ? toggleTerminal : undefined}
        aria-disabled={!inEditor}
        title={inEditor ? 'Panel inferior (Ctrl `)' : 'Panel inferior · solo en el Editor'}
        aria-label="Panel inferior"
        aria-pressed={inEditor && !!terminalOpen}
      >
        <IconPanelBottom size={18} filled={inEditor && !!terminalOpen} />
      </button>
      <button className={`ic tb__ic ${rightOn ? 'is-on' : ''}`} onClick={toggleAgent} title={`${rightTitle} (Ctrl Alt B)`} aria-label={mode === 'orch' && orchView === 'ade' ? 'Inspector' : 'Panel derecho'} aria-pressed={!!rightOn}>
        <IconPanelRight size={18} filled={!!rightOn} />
      </button>
    </div>
  );
}

function LeftPanelButton() {
  const { toggleSide } = useWorkbenchStore();
  const { left } = useWorkbenchStore(useShallow(selectSidePanels));
  return <button className={`ic tb__ic ${left ? 'is-on' : ''}`} onClick={toggleSide} aria-label="Panel izquierdo" title="Panel izquierdo (Ctrl B)" aria-pressed={!!left}><IconPanelLeft size={18} filled={!!left} /></button>;
}

export function TitleBar({ minimal = false }) {
  const remoteActive = useRemoteStore((s) => s.active);
  const openModal = useAppStore((s) => s.openModal);

  if (minimal) {
    return (
      <header className="titlebar titlebar--min">
        <div className="titlebar__brand" data-tauri-drag-region>
          <LogoMark size={18} />
          <span className="titlebar__word">lixbon</span>
        </div>
        <div className="titlebar__drag" data-tauri-drag-region />
        <WindowControls flat />
      </header>
    );
  }

  // Tres zonas con el selector de modo siempre en el centro geométrico:
  // «lo que tengo» a la izquierda, «lo que hago» en el medio y las
  // herramientas de la ventana a la derecha.
  return (
    <header className="titlebar titlebar--ide" data-tauri-drag-region>
      <div className="tb__l" data-tauri-drag-region>
        <AppMenu />
        <LeftPanelButton />
        <ProjectMenu />
      </div>
      <ModeSwitch />
      <div className="tb__r" data-tauri-drag-region>
        <GlobalSearch />
        <span className="tb__sep" />
        <PanelToggles />
        <span className="tb__sep" />
        {remoteActive && (
          <button className="ic tb__ic is-on" onClick={() => openModal('remote')} title="Sesión de control remoto activa" aria-label="Control remoto activo">
            <IconTerminal size={18} />
          </button>
        )}
        <SettingsButton />
        <TeamButton />
        <AccountMenu compact />
        <WindowControls flat />
      </div>
    </header>
  );
}
