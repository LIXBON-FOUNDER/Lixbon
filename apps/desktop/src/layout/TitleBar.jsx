// TitleBar.jsx — barra de ventana propia (decorations: false): marca,
// proyecto, selector de modo, buscador desplegable, paneles, cuenta y los
// controles de ventana. En modo minimal (sin sesión) solo marca y controles.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useRemoteStore } from '../store/remoteStore';
import { useShallow } from 'zustand/react/shallow';
import { useWorkbenchStore, selectSidePanels } from '../store/workbenchStore';
import { useFileViewStore } from '../store/fileViewStore';
import { useChatStore } from '../store/chatStore';
import { listFiles, pickDirectory } from '../lib/tauri';
import { allCommands, runCommand } from '../lib/commands';
import { chordForCommand, prettyChord } from '../lib/keymap';
import { fuzzyScore } from '../lib/fuzzy';
import { extractSymbols } from '../lib/outline';
import { LogoMark } from '../components/Logo';
import { Popover } from '../components/Popover';
import { TeamButton } from './TeamButton';
import { AccountMenu } from './AccountMenu';
import { AppMenu } from './AppMenu';
import { WindowControls } from './WindowControls';
import {
  IconSearch, IconChevronDown, IconLayoutLeft, IconLayoutBottom, IconLayoutRight,
  IconFolderOpen, IconFileCode, IconTerminal,
} from '../components/Icons';

const MODE_TABS = [
  { id: 'agent', label: 'Agente' },
  { id: 'editor', label: 'Editor' },
  { id: 'design', label: 'Diseño' },
  { id: 'git', label: 'Git' },
];
const TAB_W = 76;

const baseName = (p) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '');

function ModeSwitch() {
  const mode = useWorkbenchStore((s) => s.mode);
  const setMode = useWorkbenchStore((s) => s.setMode);
  const onPage = useWorkbenchStore((s) => !!s.page);
  const idx = Math.max(0, MODE_TABS.findIndex((t) => t.id === mode));
  return (
    <nav className={`modeswitch ${onPage ? 'is-idle' : ''}`} aria-label="Modo">
      <span className="modeswitch__thumb" style={{ transform: `translateX(${idx * TAB_W}px)` }} />
      {MODE_TABS.map((t) => (
        <button
          key={t.id}
          className={`modeswitch__tab ${mode === t.id ? 'is-active' : ''}`}
          style={{ width: TAB_W }}
          onClick={() => setMode(t.id)}
          title={prettyChord(chordForCommand(`mode.${t.id}`))}
        >
          {t.label}
        </button>
      ))}
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
      <button ref={ref} className="projbtn" onClick={() => setOpen((v) => !v)}>
        {baseName(workspaceRoot) || 'Sin carpeta'}
        <IconChevronDown size={12} />
      </button>
      <Popover anchorRef={ref} open={open} onClose={close} className="menu">
        <div className="menu__label">Recientes</div>
        {recentFolders.length === 0 && <div className="menu__empty">Todavía no hay carpetas recientes</div>}
        {recentFolders.map((p) => (
          <button key={p} className={`menu__item ${p === workspaceRoot ? 'is-current' : ''}`} onClick={() => choose(p)}>
            <span className="menu__main">{baseName(p)}</span>
            <span className="menu__hint">{p}</span>
          </button>
        ))}
        <div className="menu__sep" />
        <button className="menu__item" onClick={browse}>
          <IconFolderOpen size={14} />
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
      <div ref={boxRef} className={`tsearch ${open ? 'is-open' : ''}`}>
        <button className="tsearch__icon" onClick={() => setOpen(true)} aria-label="Buscar (Ctrl K)">
          <IconSearch size={15} />
        </button>
        <input
          ref={inputRef}
          className="tsearch__input"
          value={query}
          placeholder="Archivos, código, comandos o pregúntale al agente"
          tabIndex={open ? 0 : -1}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => setTimeout(() => { if (!inputRef.current?.value) setOpen(false); }, 120)}
        />
        <span className="tsearch__kbd">Ctrl K</span>
      </div>
      <Popover anchorRef={boxRef} open={open} onClose={collapse} align="right" className="menu tsearch__results">
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

const RIGHT_TITLE = { editor: 'Agente', agent: 'Cambios', design: 'Agente' };

function PanelToggles() {
  const mode = useWorkbenchStore((s) => s.mode);
  const { left, right } = useWorkbenchStore(useShallow(selectSidePanels));
  const { toggleSide, toggleAgent } = useWorkbenchStore();
  const terminalOpen = useAppStore((s) => s.panels.terminal);
  const toggleTerminal = useAppStore((s) => s.toggleTerminal);
  return (
    <div className="ptoggles">
      <button className={`ic ${left ? 'is-on' : ''}`} onClick={toggleSide} title="Panel izquierdo (Ctrl B)"><IconLayoutLeft size={16} /></button>
      {mode === 'editor' && <button className={`ic ${terminalOpen ? 'is-on' : ''}`} onClick={toggleTerminal} title="Terminal (Ctrl `)"><IconLayoutBottom size={16} /></button>}
      {right !== undefined && <button className={`ic ${right ? 'is-on' : ''}`} onClick={toggleAgent} title={`${RIGHT_TITLE[mode]} (Ctrl Alt B)`}><IconLayoutRight size={16} /></button>}
    </div>
  );
}

export function TitleBar({ minimal = false }) {
  const remoteActive = useRemoteStore((s) => s.active);
  const openModal = useAppStore((s) => s.openModal);
  const onPage = useWorkbenchStore((s) => !!s.page);

  return (
    <header className="titlebar">
      {minimal ? (
        <div className="titlebar__brand" data-tauri-drag-region>
          <LogoMark size={18} />
          <span className="titlebar__word">lixbon</span>
        </div>
      ) : <AppMenu />}

      {!minimal && <ProjectMenu />}
      <div className="titlebar__drag" data-tauri-drag-region />
      {!minimal && <ModeSwitch />}
      <div className="titlebar__drag" data-tauri-drag-region />

      {!minimal && (
        <div className="titlebar__tools">
          <SearchExpand />
          {!onPage && <PanelToggles />}
          {remoteActive && (
            <button className="ic is-on" onClick={() => openModal('remote')} title="Sesión de control remoto activa">
              <IconTerminal size={16} />
            </button>
          )}
          <TeamButton />
          <AccountMenu compact />
        </div>
      )}
      <WindowControls />
    </header>
  );
}
