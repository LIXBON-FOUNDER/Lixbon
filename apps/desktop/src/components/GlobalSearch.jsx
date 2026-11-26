import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileIcon } from '@lixbon/icons/file-icons';
import { StatusIcon } from '@lixbon/icons/status';
import { useAppStore } from '../store/appStore';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useFileViewStore } from '../store/fileViewStore';
import { useChatStore, useOpenSessions, useSessionsStore, spawnSessionOf } from '../store/chatStore';
import { useCodexTermStore } from '../orch/codexterm/codexTermStore';
import { codexTerm } from '../orch/codexterm/codexTermContract';
import { api } from '../lib/api';
import { claudeSessions } from '../lib/claudeCode';
import { listFiles } from '../lib/tauri';
import { allCommands, runCommand } from '../lib/commands';
import { chordForCommand, prettyChord } from '../lib/keymap';
import { fuzzyScore } from '../lib/fuzzy';
import { extractSymbols } from '../lib/outline';
import { engineOf } from '../lib/engines';
import { IconSearch, IconTerminal, IconChevronRight } from './Icons';
import { SearchHighlight } from './SearchHighlight';
const PREFIXES = [{
  key: '>',
  label: 'comandos'
}, {
  key: '#',
  label: 'archivos'
}, {
  key: '@',
  label: 'símbolos'
}, {
  key: '?',
  label: 'agente'
}];
const GROUPS = [{
  id: 'files',
  label: 'Archivos'
}, {
  id: 'agents',
  label: 'Agentes'
}, {
  id: 'commands',
  label: 'Comandos'
}, {
  id: 'symbols',
  label: 'Símbolos'
}, {
  id: 'code',
  label: 'Código'
}];

/** Ctrl K: los archivos, sesiones y comandos reales, en la paleta del lienzo. */
export function GlobalSearch() {
  const open = useWorkbenchStore(state => state.searchOpen);
  const setOpen = useWorkbenchStore(state => state.setSearchOpen);
  const root = useAppStore(state => state.workspaceRoot);
  const activeTab = useFileViewStore(state => state.tabs.find(tab => tab.path === state.activePath && !tab.virtual));
  const sessions = useOpenSessions();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const restoreFocus = useRef(null);
  const navigating = useRef(false);
  const opening = useRef(false);
  const uid = useId();
  useLayoutEffect(() => {
    if (!open) return undefined;
    navigating.current = false;
    restoreFocus.current = document.activeElement;
    inputRef.current?.focus();
    return () => {
      if (!navigating.current && restoreFocus.current?.isConnected) restoreFocus.current.focus();
    };
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setError('');
    const requests = [listFiles(), api.get('/api/conversations?source=ide&limit=50&archived=false'), root ? claudeSessions(root) : Promise.resolve([]), root ? codexTerm.sessions({
      cwd: root
    }) : Promise.resolve([])];
    Promise.allSettled(requests).then(results => {
      if (!alive) return;
      const value = index => results[index].status === 'fulfilled' ? results[index].value : null;
      const history = [...(value(1)?.conversations || []).filter(item => !item.archived).map(item => ({
        ...item,
        engine: 'lixbon'
      })), ...(value(2) || []).filter(item => !item.archived).map(item => ({
        ...item,
        engine: 'claude'
      })), ...(value(3) || []).map(item => ({
        ...item,
        engine: 'codex'
      }))];
      setCatalog({
        root,
        files: value(0) || [],
        history
      });
      if (results.some(result => result.status === 'rejected')) setError('Algunos resultados no están disponibles.');
    });
    return () => {
      alive = false;
    };
  }, [open, root]);
  const raw = query.trim();
  const prefix = PREFIXES.some(item => item.key === raw[0]) ? raw[0] : '';
  const text = raw.slice(prefix ? 1 : 0).trim();
  const search = text.toLowerCase().replace(/\s+/g, '');
  const results = useMemo(() => {
    const out = [];
    const current = catalog?.root === root ? catalog : null;
    const rank = (items, label, limit) => items.map(item => ({
      item,
      score: search ? fuzzyScore(label(item), search) : 0
    })).filter(item => item.score >= 0).sort((a, b) => b.score - a.score).slice(0, limit).map(item => item.item);
    if (!prefix || prefix === '#') rank(current?.files || [], file => file.rel, search ? 7 : 5).forEach(file => out.push({
      group: 'files',
      kind: 'file',
      key: file.path,
      label: file.name,
      hint: file.rel,
      file
    }));
    if (!prefix || prefix === '?') {
      out.push({
        group: 'agents',
        kind: 'new-agent',
        key: 'new-agent',
        label: 'Nueva tarea de agente',
        hint: prettyChord(chordForCommand('chat.newConversation'))
      });
      const live = sessions.filter(session => session.hasMessages && session.title);
      const identities = new Set(live.filter(session => session.conversationId).map(session => `${session.engine || 'lixbon'}:${session.conversationId}`));
      const history = [...live.map(session => ({
        ...session,
        live: true,
        id: session.conversationId
      })), ...(current?.history || []).filter(session => !identities.has(`${session.engine}:${session.id}`))];
      rank(history, session => session.title || '', 5).forEach(session => out.push({
        group: 'agents',
        kind: 'session',
        key: session.live ? session.key : `${session.engine}:${session.id}`,
        label: `Ir a «${session.title || 'Sin título'}»`,
        hint: session.waiting ? 'espera tu respuesta' : session.streaming ? 'Trabajando' : '',
        session
      }));
      if (text) out.push({
        group: 'agents',
        kind: 'ask',
        key: 'ask-agent',
        label: `Preguntar al agente: “${text}”`,
        hint: 'Enter',
        text
      });
    }
    if (!prefix || prefix === '>') {
      let commands = allCommands().filter(command => !command.when || command.when());
      if (!prefix && !search) commands = ['terminal.new', 'workbench.toggleAgent'].map(id => commands.find(command => command.id === id)).filter(Boolean);
      rank(commands, command => `${command.category || ''} ${command.title} ${command.keywords || ''}`, prefix === '>' ? 30 : 5).forEach(command => out.push({
        group: 'commands',
        kind: 'command',
        key: command.id,
        label: command.id === 'terminal.new' ? 'Nueva terminal' : command.id === 'workbench.toggleAgent' ? 'Mostrar u ocultar el panel derecho' : command.title,
        hint: prettyChord(chordForCommand(command.id)),
        command
      }));
    }
    if (prefix === '@') {
      rank(activeTab ? extractSymbols(activeTab.name, activeTab.content) : [], symbol => symbol.name, 14).forEach(symbol => out.push({
        group: 'symbols',
        kind: 'symbol',
        key: `${symbol.line}:${symbol.name}`,
        label: symbol.name,
        hint: `${symbol.kind} · ${symbol.line}`,
        symbol
      }));
      if (!activeTab) out.push({
        group: 'symbols',
        kind: 'note',
        key: 'no-file',
        label: 'Abre un archivo para buscar sus símbolos'
      });
    }
    if (text && !prefix) out.push({
      group: 'code',
      kind: 'text',
      key: 'search-text',
      label: `Buscar “${text}” en el código`,
      hint: 'Ctrl Shift F'
    });
    return out;
  }, [catalog, root, search, prefix, text, activeTab, sessions]);
  const options = results.filter(result => result.kind !== 'note');
  const index = Math.max(0, Math.min(selected, options.length - 1));
  useEffect(() => setSelected(0), [query, root]);
  useEffect(() => {
    if (open) listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({
      block: 'nearest'
    });
  }, [open, index, results.length]);
  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const pick = async result => {
    if (!result || result.kind === 'note' || opening.current) return;
    if (result.kind === 'session' && !result.session.live && result.session.engine !== 'codex') {
      opening.current = true;
      setError('');
      try {
        const session = result.session,
          current = useChatStore.getState();
        await ((current.engine || 'lixbon') === session.engine ? current : spawnSessionOf(session.engine).getState()).loadConversation(session.id);
        const loaded = useChatStore.getState();
        if (loaded.conversationId !== session.id || (loaded.engine || 'lixbon') !== session.engine) {
          setError('No se pudo abrir la conversación. Vuelve a intentarlo.');
          return;
        }
        navigating.current = true;
        close();
        useWorkbenchStore.getState().setMode('agent');
      } catch (failure) {
        setError(`No se pudo abrir la conversación: ${failure.message || failure}`);
      } finally {
        opening.current = false;
      }
      return;
    }
    navigating.current = true;
    close();
    if (result.kind === 'file') {
      useWorkbenchStore.getState().setMode('editor');
      useFileViewStore.getState().open(result.file.path, result.file.name);
    } else if (result.kind === 'command') await runCommand(result.command.id);else if (result.kind === 'new-agent') {
      useWorkbenchStore.getState().setMode('agent');
      await runCommand('chat.newConversation');
    } else if (result.kind === 'session') {
      useWorkbenchStore.getState().setMode('agent');
      const session = result.session;
      if (session.live) useSessionsStore.getState().activate(session.key);else if (session.engine === 'codex') useCodexTermStore.getState().openLauncher({
        id: session.id,
        title: session.title,
        cwd: session.cwd,
        model: session.model
      });
    } else if (result.kind === 'symbol') {
      useWorkbenchStore.getState().setMode('editor');
      useFileViewStore.getState().revealLine(activeTab.path, result.symbol.line);
    } else if (result.kind === 'ask') {
      useWorkbenchStore.getState().setMode('agent');
      useChatStore.getState().send(result.text);
    } else if (result.kind === 'text') useWorkbenchStore.getState().searchInProject(text);
  };
  const onKey = event => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected(Math.min(index + 1, Math.max(0, options.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected(Math.max(0, index - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setSelected(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setSelected(Math.max(0, options.length - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void pick(options[index]);
    }
  };
  const icon = result => {
    if (result.kind === 'file') return <FileIcon nombre={result.file.path} size={16} />;
    if (result.kind === 'session') {
      const Mark = engineOf(result.session.engine).Mark;
      return <Mark size={16} />;
    }
    if (result.kind === 'new-agent' || result.kind === 'ask') return <StatusIcon kind="agent" size={16} />;
    if (result.kind === 'command') return /terminal/i.test(result.command.id) ? <IconTerminal size={16} /> : <IconChevronRight size={16} />;
    return <IconSearch size={16} />;
  };
  const highlightedLabel = result => {
    if (result.kind === 'session') return <>Ir a «<SearchHighlight text={result.session.title || 'Sin título'} query={text} />»</>;
    if (result.kind === 'ask') return <>Preguntar al agente: “<SearchHighlight text={result.text} query={text} />”</>;
    if (result.kind === 'text') return <>Buscar “<SearchHighlight text={text} query={text} />” en el código</>;
    if (result.kind === 'new-agent') return result.label;
    return <SearchHighlight text={result.label} query={text} />;
  };
  return <div className="tsearch-slot"><button className="global-search-trigger" onClick={() => setOpen(true)} aria-label="Buscar (Ctrl K)" title="Buscar (Ctrl K)"><IconSearch size={16} /><span>Buscar o ejecutar</span><kbd>Ctrl K</kbd></button>
    {open && createPortal(<div className="quickopen__overlay global-search-overlay" onPointerDown={close}><div className="quickopen global-search" role="dialog" aria-label="Paleta de comandos" onPointerDown={event => event.stopPropagation()}><div className="quickopen__box"><IconSearch size={16} /><input ref={inputRef} className="quickopen__input" role="combobox" aria-label="Busca archivos, comandos o agentes" aria-autocomplete="list" aria-expanded="true" aria-controls={`${uid}-results`} aria-activedescendant={options[index] ? `${uid}-option-${index}` : undefined} placeholder="Busca archivos, comandos o agentes" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onKey} spellCheck={false} /><kbd>Esc</kbd></div>
      <div className="global-search__results quickopen__list" ref={listRef} role="listbox" id={`${uid}-results`} aria-label="Resultados">{GROUPS.map(group => {
            const items = results.filter(result => result.group === group.id);
            return items.length > 0 && <div key={group.id} role="group" aria-labelledby={`${uid}-${group.id}`}><div className="global-search__label" id={`${uid}-${group.id}`}>{group.label}</div>{items.map(result => {
                const at = options.indexOf(result);
                return result.kind === 'note' ? <p key={result.key} className="menu__empty">{result.label}</p> : <button type="button" tabIndex={-1} role="option" id={`${uid}-option-${at}`} aria-selected={index === at} key={result.key} className={`quickopen__item global-search__option${index === at ? ' is-selected' : ''}`} onPointerEnter={() => setSelected(at)} onMouseDown={event => event.preventDefault()} onClick={() => void pick(result)}>{icon(result)}<span className="global-search__name">{highlightedLabel(result)}</span>{result.kind === 'file' && <span className="global-search__path"><SearchHighlight text={result.hint} query={text} /></span>}<span className="global-search__key">{result.kind === 'file' ? 'Enter' : result.hint}</span></button>;
              })}</div>;
          })}</div>
      {error && <p className="global-search__notice" role="status">{error}</p>}<div className="tsearch__prefixes">{PREFIXES.map(item => <button type="button" key={item.key} className="tsearch__prefix" onMouseDown={event => event.preventDefault()} onClick={() => {
            setQuery(item.key);
            inputRef.current?.focus();
          }}><kbd>{item.key}</kbd>{item.label}</button>)}</div>
    </div></div>, document.body)}
  </div>;
}
