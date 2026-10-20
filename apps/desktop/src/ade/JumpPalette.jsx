import { useEffect, useId, useMemo, useRef, useState } from 'react';
import './JumpPalette.css';

const asText = (value) => (typeof value === 'string' ? value.trim() : '');
const resultKey = (kind, projectId, itemId) => JSON.stringify([kind, projectId, itemId]);

function matches(query, label, metadata) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return label.toLowerCase().includes(needle)
    || metadata.some((value) => value.toLowerCase().includes(needle));
}

function orderMatches(items, query) {
  if (!query) return items;
  const needle = query.toLowerCase();
  const primary = [];
  const metadata = [];
  for (const item of items) {
    if (item.label.toLowerCase().includes(needle)) primary.push(item);
    else if (item.metadata.some((value) => value.toLowerCase().includes(needle))) metadata.push(item);
  }
  return [...primary, ...metadata];
}

function buildGroups({ projects, tasks, attention, query }) {
  const projectItems = (Array.isArray(projects) ? projects : []).flatMap((project) => {
    const id = asText(project?.id);
    const name = asText(project?.name);
    if (!id) return [];
    const label = name || id;
    const metadata = [id, asText(project?.branch)].filter(Boolean);
    if (!matches(query, label, metadata)) return [];
    return [{
      key: resultKey('project', id, id),
      kind: 'project',
      label,
      metadata,
      target: { kind: 'project', projectId: id },
    }];
  });

  const taskItems = (Array.isArray(tasks) ? tasks : []).flatMap((task) => {
    const id = asText(task?.id);
    const projectId = asText(task?.projectId);
    if (!id || !projectId) return [];
    const title = asText(task?.title);
    const label = title || id;
    const metadata = [id, projectId, asText(task?.branch)].filter(Boolean);
    if (!matches(query, label, metadata)) return [];
    return [{
      key: resultKey('task', projectId, id),
      kind: 'task',
      label,
      metadata,
      target: { kind: 'task', projectId, taskId: id },
    }];
  });

  const attentionItems = (Array.isArray(attention) ? attention : []).flatMap((item) => {
    const projectId = asText(item?.projectId);
    const taskId = asText(item?.taskId);
    if (!projectId || !taskId) return [];
    const title = asText(item?.title);
    const label = title || taskId;
    const metadata = [projectId, taskId, asText(item?.branch)].filter(Boolean);
    if (!matches(query, label, metadata)) return [];
    return [{
      key: resultKey('attention', projectId, taskId),
      kind: 'attention',
      label,
      metadata,
      target: { kind: 'attention', projectId, taskId },
    }];
  });

  return [
    { kind: 'project', label: 'Projects', items: orderMatches(projectItems, query) },
    { kind: 'task', label: 'Tasks', items: orderMatches(taskItems, query) },
    { kind: 'attention', label: 'Attention', items: orderMatches(attentionItems, query) },
  ];
}

/**
 * Presentational, controlled navigation palette for a future shell owner.
 *
 * API:
 * - `open`, `query`, and `onQueryChange` control visibility and search text.
 * - `loading` identifies an in-progress result refresh.
 * - `projects`: normalized `{ id, name, branch? }` results.
 * - `tasks`: normalized `{ id, projectId, title, branch? }` results.
 * - `attention`: normalized `{ projectId, taskId, title, branch? }` results.
 * - `onNavigate(target)` receives only `{ kind, projectId }` for a Project or
 *   `{ kind, projectId, taskId }` for a Task or Attention item.
 * - `onClose()` asks the shell to close the palette.
 *
 * The caller owns all reads and result freshness. This component has no query,
 * store, shortcut, command, file-search, or Attention-resolution integration.
 */
export function JumpPalette({
  open,
  query = '',
  loading = false,
  onQueryChange,
  projects = [],
  tasks = [],
  attention = [],
  onNavigate,
  onClose,
}) {
  const uid = useId();
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const closeButtonRef = useRef(null);
  const returnFocusRef = useRef(null);
  const lastQueryRef = useRef(query);
  const initializedRef = useRef(false);
  const [activeKey, setActiveKey] = useState(null);
  const safeQuery = typeof query === 'string' ? query.trim() : '';
  const groups = useMemo(
    () => buildGroups({ projects, tasks, attention, query: safeQuery }),
    [projects, tasks, attention, safeQuery],
  );
  const visibleGroups = useMemo(
    () => (loading ? [] : groups.filter((group) => group.items.length > 0)),
    [groups, loading],
  );
  const results = useMemo(() => visibleGroups.flatMap((group) => group.items), [visibleGroups]);
  const activeIndex = results.findIndex((item) => item.key === activeKey);
  const activeResult = activeIndex >= 0 ? results[activeIndex] : null;
  const statusMessage = loading
    ? 'Cargando resultados…'
    : results.length === 0
      ? 'Sin resultados para esta búsqueda.'
      : `${results.length} ${results.length === 1 ? 'resultado' : 'resultados'} · ↑↓ mover · Home/End ir al inicio/final · Enter abrir · Esc cerrar`;
  const listId = `${uid}-results`;
  const headingId = `${uid}-heading`;
  const inputId = `${uid}-search`;
  const helpId = `${uid}-help`;

  useEffect(() => {
    if (!open) return undefined;
    returnFocusRef.current = document.activeElement;
    inputRef.current?.focus();
    return () => {
      const restore = returnFocusRef.current;
      if (restore instanceof HTMLElement && restore.isConnected && !dialogRef.current?.contains(restore)) {
        restore.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    const queryChanged = lastQueryRef.current !== query;
    lastQueryRef.current = query;
    if (!open) {
      initializedRef.current = false;
      setActiveKey(null);
      return;
    }
    if (queryChanged || !initializedRef.current) {
      initializedRef.current = true;
      setActiveKey(results[0]?.key ?? null);
      return;
    }
    if (!activeKey || !results.some((item) => item.key === activeKey)) {
      setActiveKey(results[0]?.key ?? null);
    }
  }, [open, query, results, activeKey]);

  useEffect(() => {
    if (!activeResult) return;
    const option = document.getElementById(`${listId}-option-${activeIndex}`);
    option?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, activeResult, listId]);

  if (!open) return null;

  const close = () => onClose?.();
  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      if (event.target === inputRef.current) {
        closeButtonRef.current?.focus();
      } else {
        inputRef.current?.focus();
      }
      return;
    }
    if (event.target !== inputRef.current) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (results.length) setActiveKey(results[Math.min(activeIndex + 1, results.length - 1)]?.key ?? results[0].key);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length) setActiveKey(results[Math.max(activeIndex < 0 ? results.length - 1 : activeIndex - 1, 0)]?.key);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveKey(results[0]?.key ?? null);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveKey(results.at(-1)?.key ?? null);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const current = results.find((item) => item.key === activeKey);
      if (!current || typeof onNavigate !== 'function') return;
      onNavigate(current.target);
      close();
    }
  };

  const selectCurrent = (key) => {
    const current = results.find((item) => item.key === key);
    if (!current || typeof onNavigate !== 'function') return;
    onNavigate(current.target);
    close();
  };

  const optionIndex = new Map(results.map((item, index) => [item.key, index]));

  return (
    <div
      className="jpal__overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={dialogRef}
        className="jpal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onKeyDown={handleKeyDown}
        onMouseDown={(event) => {
          const target = event.target instanceof Element ? event.target : null;
          if (target?.closest('button, input, [role="option"]')) return;
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <header className="jpal__header">
          <div>
            <h2 id={headingId} className="jpal__title">Jump Palette</h2>
            <p id={helpId} className="jpal__help">Projects, Tasks y Attention · busca por nombre, título, ID o rama.</p>
          </div>
          <button ref={closeButtonRef} type="button" className="jpal__close" aria-label="Cerrar Jump Palette" onClick={close}>
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <label className="jpal__sr-only" htmlFor={inputId}>Buscar Projects, Tasks y Attention</label>
        <input
          ref={inputRef}
          id={inputId}
          className="jpal__input"
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeResult ? `${listId}-option-${activeIndex}` : undefined}
          aria-describedby={helpId}
          value={typeof query === 'string' ? query : ''}
          onChange={(event) => onQueryChange?.(event.currentTarget.value)}
          placeholder="Buscar por nombre, título, ID o rama…"
          autoComplete="off"
          spellCheck={false}
        />

        <div className="jpal__results">
          <div id={listId} role="listbox" aria-label="Resultados de navegación" aria-busy={loading}>
            {visibleGroups.map((group) => (
              <div key={group.kind} className="jpal__group" role="group" aria-label={group.label}>
                <h3 className="jpal__group-title" aria-hidden="true">
                  <span>{group.label}</span><span className="jpal__count" aria-hidden="true">{group.items.length}</span>
                </h3>
                {group.items.map((item) => {
                  const index = optionIndex.get(item.key);
                  const selected = item.key === activeKey;
                  return (
                    <div
                      key={item.key}
                      id={`${listId}-option-${index}`}
                      className={`jpal__option${selected ? ' is-active' : ''}`}
                      role="option"
                      aria-selected={selected}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActiveKey(item.key)}
                      onClick={() => selectCurrent(item.key)}
                    >
                      <span className="jpal__option-label">{item.label}</span>
                      <span className="jpal__option-meta">{item.metadata.join(' · ')}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <p className="jpal__status" role="status" aria-live="polite">
          {statusMessage}
        </p>
      </section>
    </div>
  );
}
