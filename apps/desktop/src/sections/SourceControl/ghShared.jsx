// ghShared.jsx — piezas comunes de la vista de PRs y la de GitHub Actions:
// icono de estado, markdown al estilo de GitHub (con casillas de tarea) y
// formato de duraciones.
import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import { markdownComponents, REMARK } from '../../chat/ChatMarkdown';
import { openExternal } from '../../lib/tauri';
import { IconCheck } from '../../components/Icons';
import { StatusIcon as SharedStatusIcon } from '@lixbon/icons/status';

export const STATE_TEXT = {
  ok: 'Correcto', fail: 'Falló', running: 'En curso', queued: 'En cola', cancel: 'Cancelado', skip: 'Omitido', idle: '—',
};

/** Estado de un check, una ejecución, un job o un paso. */
export function StatusIcon({ state, size = 16 }) {
  const kind = { running: 'working', ok: 'done', fail: 'failed', cancel: 'paused', skip: 'paused', queued: 'paused', idle: 'paused' }[state] || 'paused';
  return <span className={`ghst ghst--${state} ghst--shared`} title={STATE_TEXT[state]}><SharedStatusIcon kind={kind} size={size} /></span>;
}

export function duration(secs) {
  if (secs == null || Number.isNaN(secs) || secs < 0) return '';
  if (secs < 60) return `${secs} s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return s ? `${m} min ${s} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const secsBetween = (a, b) => (a && b && !a.startsWith('0001') && !b.startsWith('0001')
  ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000)) : null);

// Casillas de las listas de tareas (`- [x]`): GitHub las pinta como checkbox;
// aquí son una caja propia, de solo lectura, que encaja con el tema.
const ghComponents = {
  ...markdownComponents,
  a({ href, children }) {
    return <a href={href} onClick={(e) => { e.preventDefault(); if (href) openExternal(href); }}>{children}</a>;
  },
  input({ type, checked }) {
    if (type !== 'checkbox') return null;
    return (
      <span className={`ghtask ${checked ? 'is-done' : ''}`} role="checkbox" aria-checked={!!checked} aria-readonly="true">
        {checked && <IconCheck size={10} />}
      </span>
    );
  },
  li({ className, children }) {
    return <li className={className?.includes('task-list-item') ? 'ghtask-item' : undefined}>{children}</li>;
  },
  ul({ className, children }) {
    return <ul className={className?.includes('contains-task-list') ? 'ghtask-list' : undefined}>{children}</ul>;
  },
  img({ src, alt }) {
    return <img src={src} alt={alt || ''} loading="lazy" />;
  },
};

export const GhMarkdown = memo(function GhMarkdown({ children }) {
  return (
    <div className="md ghmd">
      <ReactMarkdown remarkPlugins={REMARK} components={ghComponents}>{children}</ReactMarkdown>
    </div>
  );
});

/** Resumen de una tanda de casillas `- [ ]` del cuerpo: { done, total }. */
export function taskProgress(md) {
  const all = (md || '').match(/^\s*[-*+] \[[ xX]\]/gm) || [];
  const done = all.filter((t) => /\[[xX]\]/.test(t)).length;
  return { done, total: all.length };
}
