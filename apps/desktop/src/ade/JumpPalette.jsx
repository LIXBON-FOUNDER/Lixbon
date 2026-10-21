import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import './JumpPalette.css';

const asText = (value) => (typeof value === 'string' ? value.trim() : '');
const resultKey = (kind, projectId, itemId) => JSON.stringify([kind, projectId, itemId]);
const asFacts = (value) => (Array.isArray(value) ? value.map(asText).filter(Boolean) : []);

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

function isRestorableFocusTarget(target) {
  if (!(target instanceof HTMLElement) || !target.isConnected || target.matches(':disabled')) return false;
  for (let node = target; node; node = node.parentElement) {
    if (node.hasAttribute('hidden') || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden') return false;
  }
  return true;
}

// Clave de resultado de un destino recordado (misma identidad durable que usan los resultados).
function recentResultKey(recent) {
  if (recent?.kind === 'project') return resultKey('project', asText(recent.projectId), asText(recent.projectId));
  if (recent?.kind === 'task') return resultKey('task', asText(recent.projectId), asText(recent.taskId));
  if (recent?.kind === 'attention') return resultKey('attention', asText(recent.attentionId), asText(recent.attentionId));
  return null;
}

function buildGroups({ projects, tasks, attention, recents, query }) {
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
      facts: asFacts(project?.facts),
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
      facts: asFacts(task?.facts),
      target: { kind: 'task', projectId, taskId: id },
    }];
  });

  const attentionItems = (Array.isArray(attention) ? attention : []).flatMap((item) => {
    const id = asText(item?.id);
    const targetKind = asText(item?.targetKind);
    const targetId = asText(item?.targetId);
    if (!id || !targetKind || !targetId) return [];
    const projectId = asText(item?.projectId);
    const label = asText(item?.title) || targetId;
    const metadata = [id, targetId, projectId, asText(item?.branch)].filter(Boolean);
    if (!matches(query, label, metadata)) return [];
    return [{
      key: resultKey('attention', id, id),
      kind: 'attention',
      label,
      metadata,
      facts: asFacts(item?.facts),
      target: { kind: 'attention', attentionId: id, targetKind, targetId, projectId: projectId || null },
    }];
  });

  const groups = [
    { kind: 'project', label: 'Projects', items: orderMatches(projectItems, query) },
    { kind: 'task', label: 'Tasks', items: orderMatches(taskItems, query) },
    { kind: 'attention', label: 'Attention', items: orderMatches(attentionItems, query) },
  ];
  if (query) return groups;

  // Sin búsqueda, los destinos recientes que siguen en los resultados actuales van primero y no se repiten abajo;
  // los que ya no existen simplemente no aparecen.
  const byKey = new Map(groups.flatMap((group) => group.items).map((item) => [item.key, item]));
  const recentItems = [];
  for (const recent of Array.isArray(recents) ? recents : []) {
    const key = recentResultKey(recent);
    const item = key && byKey.get(key);
    if (item && !recentItems.includes(item)) recentItems.push(item);
  }
  if (recentItems.length === 0) return groups;
  const recentKeys = new Set(recentItems.map((item) => item.key));
  return [
    { kind: 'recent', label: 'Recientes', items: recentItems },
    ...groups.map((group) => ({ ...group, items: group.items.filter((item) => !recentKeys.has(item.key)) })),
  ];
}

const PaletteOption = memo(function PaletteOption({ item, id, selected, onSelect }) {
  return (
    <div
      id={id}
      className={`jpal__option${selected ? ' is-active' : ''}`}
      role="option"
      aria-selected={selected}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onSelect(item.key)}
    >
      <span className="jpal__option-main">
        <span className="jpal__option-label">{item.label}</span>
        {item.facts.length > 0 && <span className="jpal__option-facts">{item.facts.join(' · ')}</span>}
      </span>
      <span className="jpal__option-meta">{item.metadata.join(' · ')}</span>
    </div>
  );
});

/**
 * Controlled navigation palette; the shell host (`JumpPaletteHost`) owns reads and result freshness.
 *
 * API:
 * - `open`, `query`, and `onQueryChange` control visibility and search text.
 * - `loading` identifies an in-progress result refresh with nothing to show yet.
 * - `statusNote` is optional extra text for the status line (partial results, progress).
 * - `notice` is `{ message, actionLabel?, onAction? }`, announced as an alert and reachable with Tab.
 * - `projects`: `{ id, name, branch?, facts? }`; `tasks`: `{ id, projectId, title, branch?, facts? }`.
 * - `attention`: `{ id, targetKind, targetId, projectId?, title?, facts? }` (one per active Attention).
 *   `facts` are display-only strings (status, host/origin); only titles/names, durable IDs and branch are searched.
 * - `recents`: destinos recordados `{ kind: 'project', projectId }`, `{ kind: 'task', projectId, taskId }` o
 *   `{ kind: 'attention', attentionId }`, del más reciente al más antiguo. Sin búsqueda se muestran primero, solo los
 *   que siguen entre los resultados recibidos; el almacenamiento y la poda los gestiona el anfitrión.
 * - `onNavigate(target)` receives `{ kind: 'project', projectId }`, `{ kind: 'task', projectId, taskId }` or
 *   `{ kind: 'attention', attentionId, targetKind, targetId, projectId }`. Returning `false` rejects the target:
 *   the palette stays open so the caller can show a `notice`.
 * - `onClose()` asks the shell to close the palette.
 *
 * No query, store, shortcut, command, file-search, or Attention-resolution integration lives here.
 */
export function JumpPalette({
  open,
  query = '',
  loading = false,
  statusNote = '',
  notice = null,
  onQueryChange,
  projects = [],
  tasks = [],
  attention = [],
  recents = [],
  onNavigate,
  onClose,
}) {
  const uid = useId();
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const closeButtonRef = useRef(null);
  const noticeActionRef = useRef(null);
  const handlersRef = useRef({});
  const returnFocusRef = useRef(null);
  const restoreFocusRequestedRef = useRef(false);
  const lastQueryRef = useRef(query);
  const initializedRef = useRef(false);
  const [activeKey, setActiveKey] = useState(null);
  const safeQuery = typeof query === 'string' ? query.trim() : '';
  const groups = useMemo(
    () => buildGroups({ projects, tasks, attention, recents, query: safeQuery }),
    [projects, tasks, attention, recents, safeQuery],
  );
  const visibleGroups = useMemo(
    () => (loading ? [] : groups.filter((group) => group.items.length > 0)),
    [groups, loading],
  );
  const results = useMemo(() => visibleGroups.flatMap((group) => group.items), [visibleGroups]);
  const activeIndex = results.findIndex((item) => item.key === activeKey);
  const activeResult = activeIndex >= 0 ? results[activeIndex] : null;
  const note = asText(statusNote);
  const baseMessage = loading
    ? 'Cargando resultados…'
    : results.length === 0
      ? 'Sin resultados para esta búsqueda.'
      : `${results.length} ${results.length === 1 ? 'resultado' : 'resultados'} · ↑↓ mover · Ctrl+Home/End ir al inicio/final · Enter abrir · Esc cerrar`;
  const statusMessage = note ? `${baseMessage} ${note}` : baseMessage;
  const listId = `${uid}-results`;
  const headingId = `${uid}-heading`;
  const inputId = `${uid}-search`;
  const helpId = `${uid}-help`;

  useEffect(() => {
    if (!open) return undefined;
    returnFocusRef.current = document.activeElement;
    restoreFocusRequestedRef.current = false;
    inputRef.current?.focus();
    return () => {
      const restore = returnFocusRef.current;
      const active = document.activeElement;
      const focusStayedWithPalette = active === document.body || active === document.documentElement
        || !active?.isConnected || Boolean(dialogRef.current?.contains(active));
      if (restoreFocusRequestedRef.current && focusStayedWithPalette && isRestorableFocusTarget(restore)
        && !dialogRef.current?.contains(restore)) {
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

  // Stable across active-key changes so memoized rows do not re-render on every arrow key.
  handlersRef.current = { results, onNavigate, onClose };
  const activate = useCallback((key) => {
    const { results: current, onNavigate: navigate, onClose: dismiss } = handlersRef.current;
    const entry = current.find((item) => item.key === key);
    if (!entry || typeof navigate !== 'function') return;
    if (navigate(entry.target) === false) return;
    restoreFocusRequestedRef.current = true;
    dismiss?.();
  }, []);

  if (!open) return null;

  const close = () => {
    restoreFocusRequestedRef.current = true;
    onClose?.();
  };
  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const stops = [inputRef.current, noticeActionRef.current, closeButtonRef.current].filter(Boolean);
      const at = stops.indexOf(document.activeElement);
      const step = event.shiftKey ? -1 : 1;
      stops[(at + step + stops.length) % stops.length]?.focus();
      return;
    }
    if (event.target !== inputRef.current) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (results.length) setActiveKey(results[Math.min(activeIndex + 1, results.length - 1)]?.key ?? results[0].key);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length) setActiveKey(results[Math.max(activeIndex < 0 ? results.length - 1 : activeIndex - 1, 0)]?.key);
    } else if (event.key === 'Home' && event.ctrlKey) {
      event.preventDefault();
      setActiveKey(results[0]?.key ?? null);
    } else if (event.key === 'End' && event.ctrlKey) {
      event.preventDefault();
      setActiveKey(results.at(-1)?.key ?? null);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      activate(activeKey);
    }
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
                  return (
                    <PaletteOption
                      key={item.key}
                      item={item}
                      id={`${listId}-option-${index}`}
                      selected={item.key === activeKey}
                      onSelect={activate}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        {notice && (
          <div className="jpal__notice" role="alert">
            <span>{notice.message}</span>
            {notice.actionLabel && (
              <button
                ref={noticeActionRef}
                type="button"
                className="jpal__notice-action"
                onClick={() => {
                  notice.onAction?.();
                  inputRef.current?.focus();
                }}
              >
                {notice.actionLabel}
              </button>
            )}
          </div>
        )}
        <p className="jpal__status" role="status" aria-live="polite">
          {statusMessage}
        </p>
      </section>
    </div>
  );
}
