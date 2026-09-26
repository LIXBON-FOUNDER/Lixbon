// FilePreview.jsx — vista previa de Markdown, HTML y SVG dentro del editor,
// y el marco de los visuales que llegan del chat.
import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { markdownComponents, REMARK } from '../chat/ChatMarkdown';
import { useAppStore } from '../store/appStore';
import { useFileViewStore } from '../store/fileViewStore';
import { openExternal } from '../lib/tauri';
import { previewKind, resolveFrom, servedUrl, useVisualBase } from '../lib/preview';
import { IconRefresh, IconExternal } from '../components/Icons';

const EXTERNAL = /^(https?:|mailto:|data:)/i;

function MarkdownPreview({ path, content }) {
  const root = useAppStore((s) => s.workspaceRoot);
  const base = useVisualBase();

  const components = useMemo(() => ({
    ...markdownComponents,
    img({ src = '', alt }) {
      const url = EXTERNAL.test(src) ? src : servedUrl(base, root, resolveFrom(path, src));
      return url ? <img src={url} alt={alt || ''} loading="lazy" /> : <span className="mdview__missing">{alt || src}</span>;
    },
    a({ href = '', children }) {
      const onClick = (e) => {
        if (href.startsWith('#')) return;
        e.preventDefault();
        if (EXTERNAL.test(href)) openExternal(href);
        else useFileViewStore.getState().open(resolveFrom(path, href));
      };
      return <a href={href} onClick={onClick}>{children}</a>;
    },
  }), [base, root, path]);

  return (
    <div className="mdview">
      <article className="md mdview__doc">
        <ReactMarkdown remarkPlugins={REMARK} components={components}>{content}</ReactMarkdown>
      </article>
    </div>
  );
}

export function VisualFrame({ url, label, stale, version = 0 }) {
  const [reloads, setReloads] = useState(0);
  return (
    <div className="visual">
      <div className="visual__bar">
        <span className="visual__label">{label}</span>
        {stale && <span className="visual__hint">Se actualiza al guardar</span>}
        <div className="panelhead__fill" />
        <button className="ic" onClick={() => setReloads((n) => n + 1)} title="Recargar"><IconRefresh size={13} /></button>
        <button className="ic" onClick={() => url && openExternal(url)} disabled={!url} title="Abrir en el navegador"><IconExternal size={13} /></button>
      </div>
      {url ? (
        <iframe
          key={`${version}:${reloads}`}
          className="visual__frame"
          title={label}
          src={url}
          sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
        />
      ) : (
        <div className="visual__empty">La vista previa necesita una carpeta de trabajo abierta.</div>
      )}
    </div>
  );
}

export function FilePreview({ tab }) {
  const root = useAppStore((s) => s.workspaceRoot);
  const base = useVisualBase();
  if (previewKind(tab.path) === 'markdown') return <MarkdownPreview path={tab.path} content={tab.content} />;
  if (base === null) return null;
  return (
    <VisualFrame
      url={servedUrl(base, root, tab.path)}
      label={tab.name}
      stale={tab.content !== tab.saved}
      version={tab.mtime ?? 0}
    />
  );
}
