// TitleBar.jsx — barra de ventana propia (decorations: false): marca,
// proyecto, selector de modo, buscador desplegable, paneles, cuenta y los
// controles de ventana. En modo minimal (sin sesión) solo marca y controles.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useRemoteStore } from '../store/remoteStore';
import { useShallow } from 'zustand/react/shallow';
import { useWorkbenchStore, selectSidePanels, selectRightDrawer } from '../store/workbenchStore';
import { useFileViewStore } from '../store/fileViewStore';
import { useChatStore } from '../store/chatStore';
import { useOrchStore } from '../store/orchStore';
import { usePendingSpawnsStore } from '../orch/spawn/pendingSpawnsStore';
import { useAttentionTotals } from '../orch/useAttention';
import { listFiles, pickDirectory } from '../lib/tauri';
import { allCommands, runCommand } from '../lib/commands';
import { chordForCommand, prettyChord } from '../lib/keymap';
import { fuzzyScore } from '../lib/fuzzy';
import { useIsCompact } from '../lib/frameSize';
import { extractSymbols } from '../lib/outline';
import { LogoMark } from '../components/Logo';
import { Popover } from '../components/Popover';
import { TeamButton } from './TeamButton';
import { AccountMenu } from './AccountMenu';
import { AppMenu } from './AppMenu';
import { WindowControls } from './WindowControls';
import {
  IconSearch, IconChevronDown, IconFolderOpen, IconFileCode, IconTerminal,
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
  { id: 'orch', label: 'Orquestar', Icon: IconModeOrch },
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
    <nav className="modeswitch" aria-label="Modo" style={{ '--idx': idx }}>
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
        <IconChevronDown size={13} />
      </button>
      <Popover anchorRef={ref} open={open} onClose={close} className="menu">
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

const PREFIXES = [
  { key: '>', label: 'comandos' },
  { key: '#', label: 'archivos' },
  { key: '@', label: 'símbolos' },
  { key: '?', label: 'agente' },
];

function SearchExpand() {
  const open = useWorkbenchStore((s) => s.searchOpen);
  const setOpen = useWorkbenchStore((s) => s.setSearchOpen);
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState(null);
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => inputRef.current?.focus(), 180);
    if (files === null) listFiles().then(setFiles).catch(() => setFiles([]));
    return () => clearTimeout(t);
  }, [open, files]);

  const activeTab = useFileViewStore((s) => s.tabs.find((t) => t.path === s.activePath && !t.virtual));

  const results = useMemo(() => {
    const raw = query.trim();
    const prefix = PREFIXES.some((p) => p.key === raw[0]) ? raw[0] : '';
    const text = raw.slice(prefix ? 1 : 0).trim();
    const q = text.toLowerCase();
    const out = [];
    if ((prefix === '' || prefix === '#') && files) {
      const ranked = q
        ? files.map((f) => ({ f, s: fuzzyScore(f.rel, q.replace(/\s+/g, '')) })).filter((m) => m.s >= 0).sort((a, b) => b.s - a.s)
        : prefix === '#' ? files.slice(0, 12).map((f) => ({ f })) : [];
      ranked.slice(0, prefix === '#' ? 14 : 7).forEach(({ f }) => out.push({ kind: 'file', key: f.path, label: f.name, hint: f.rel, file: f }));
    }
    if (prefix === '@') {
      const symbols = activeTab ? extractSymbols(activeTab.name, activeTab.content) : [];
      symbols
        .map((sym) => ({ sym, s: q ? fuzzyScore(sym.name, q) : 0 }))
        .filter((m) => m.s >= 0)
        .sort((a, b) => b.s - a.s || a.sym.line - b.sym.line)
        .slice(0, 14)
        .forEach(({ sym }) => out.push({ kind: 'symbol', key: `${sym.line}:${sym.name}`, label: sym.name, hint: `${sym.kind} · ${sym.line}`, sym }));
      if (!activeTab) out.push({ kind: 'note', key: 'nofile', label: 'Abre un archivo para buscar sus símbolos' });
    }
    if ((q && prefix === '') || prefix === '>') {
      allCommands()
        .map((c) => ({ c, s: q ? fuzzyScore(`${c.category || ''} ${c.title}`, q) : 0 }))
        .filter((m) => m.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, prefix === '>' ? 12 : 5)
        .forEach(({ c }) => out.push({ kind: 'cmd', key: c.id, label: c.title, hint: prettyChord(chordForCommand(c.id)), cmd: c }));
    }
    if (q && prefix === '') out.push({ kind: 'text', key: 'text', label: `Buscar “${text}” en el código`, hint: 'Ctrl Shift F' });
    if (q && (prefix === '' || prefix === '?')) out.push({ kind: 'agent', key: 'agent', label: `Preguntar al agente: “${text}”`, hint: prefix === '?' ? '↵' : '?', text });
    return out;
  }, [query, files, activeTab]);

  useEffect(() => setSel(0), [query]);

  const collapse = () => { setOpen(false); setQuery(''); };

  const pick = (r) => {
    if (!r || r.kind === 'note') return;
    collapse();
    if (r.kind === 'file') {
      useWorkbenchStore.getState().setMode('editor');
      useFileViewStore.getState().open(r.file.path, r.file.name);
    } else if (r.kind === 'cmd') {
      runCommand(r.cmd.id);
    } else if (r.kind === 'symbol') {
      useWorkbenchStore.getState().setMode('editor');
      useFileViewStore.getState().revealLine(activeTab.path, r.sym.line);
    } else if (r.kind === 'agent') {
      useWorkbenchStore.getState().setMode('agent');
      useChatStore.getState().send(r.text);
    } else if (r.kind === 'text') {
      useWorkbenchStore.getState().searchInProject(query.trim());
    }
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); collapse(); inputRef.current?.blur(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(results[sel]); }
  };

  return (
    <div className="tsearch-slot">
      <div ref={boxRef} className={`tsearch ${open ? 'is-open' : ''}`} onClick={() => { if (!open) setOpen(true); }}>
        <button className="tsearch__icon" onClick={() => setOpen(true)} aria-label="Buscar (Ctrl K)" title="Buscar (Ctrl K)">
          <IconSearch size={16} />
        </button>
        <input
          ref={inputRef}
          className="tsearch__input"
          value={query}
          placeholder={open ? 'Archivos, comandos o pregunta al agente' : 'Buscar o ejecutar'}
          readOnly={!open}
          tabIndex={open ? 0 : -1}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => setTimeout(() => { if (!inputRef.current?.value) setOpen(false); }, 120)}
        />
        <span className="tsearch__kbd">Ctrl K</span>
      </div>
      <Popover anchorRef={boxRef} open={open} onClose={collapse} align="left" className="menu tsearch__results">
        {results.map((r, i) => (
          r.kind === 'note'
            ? <div key={r.key} className="menu__empty">{r.label}</div>
            : (
              <button
                key={`${r.kind}:${r.key}`}
                className={`menu__item ${i === sel ? 'is-selected' : ''}`}
                onMouseEnter={() => setSel(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(r)}
              >
                {r.kind === 'file' && <IconFileCode size={14} />}
                {r.kind === 'cmd' && <span className="menu__chev">›</span>}
                {r.kind === 'symbol' && <span className="menu__chev">@</span>}
                {r.kind === 'text' && <IconSearch size={14} />}
                {r.kind === 'agent' && <LogoMark size={13} />}
                <span className="menu__main">{r.label}</span>
                {r.hint && <span className={r.kind === 'file' ? 'menu__hint' : 'menu__kbd'}>{r.hint}</span>}
              </button>
            )
        ))}
        <div className="tsearch__prefixes">
          {PREFIXES.map((p) => (
            <button key={p.key} className="tsearch__prefix" onMouseDown={(e) => e.preventDefault()} onClick={() => { setQuery(p.key); inputRef.current?.focus(); }}>
              <kbd>{p.key}</kbd>{p.label}
            </button>
          ))}
        </div>
      </Popover>
    </div>
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
      <button className={`ic tb__ic ${left ? 'is-on' : ''}`} onClick={toggleSide} title="Panel izquierdo (Ctrl B)" aria-label="Panel izquierdo" aria-pressed={!!left}>
        <IconPanelLeft size={18} filled={!!left} />
      </button>
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
        <ProjectMenu />
      </div>
      <ModeSwitch />
      <div className="tb__r" data-tauri-drag-region>
        <SearchExpand />
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
