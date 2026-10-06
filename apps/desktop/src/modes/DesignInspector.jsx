// DesignInspector.jsx — puente con la vista previa (a través del proxy que
// inyecta el inspector), el árbol de capas y el panel del elemento elegido.
import { useCallback, useEffect, useRef, useState } from 'react';
import { previewProxyStart, searchInFiles } from '../lib/tauri';
import { useAppStore } from '../store/appStore';
import { useFileViewStore } from '../store/fileViewStore';
import { useWorkbenchStore } from '../store/workbenchStore';
import { SpinRing } from '../components/Ring';
import { LogoMark } from '../components/Logo';
import { IconChevronRight, IconFileCode } from '../components/Icons';

const isLocalHttp = (url) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(url || '');

/** URL que carga el iframe (vía proxy si se puede) y los mensajes del inspector. */
export function usePreviewBridge(url) {
  const frameRef = useRef(null);
  const [port, setPort] = useState(null);
  const [ready, setReady] = useState(false);
  const [tree, setTree] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    setReady(false);
    if (!isLocalHttp(url) || !window.__TAURI_INTERNALS__) { setPort(null); return; }
    previewProxyStart(url).then((p) => setPort(p || null)).catch(() => setPort(null));
  }, [url]);

  useEffect(() => {
    const onMsg = (e) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow || !e.data?.lx) return;
      const m = e.data;
      if (m.type === 'ready') setReady(true);
      if (m.type === 'tree') setTree(m.tree);
      if (m.type === 'selected') setSelected(m.info);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const post = useCallback((msg) => frameRef.current?.contentWindow?.postMessage({ lx: 1, ...msg }, '*'), []);

  let src = url;
  if (port && url) {
    try {
      const u = new URL(url);
      src = `http://127.0.0.1:${port}${u.pathname}${u.search}${u.hash}`;
    } catch { /* URL a medio escribir: sin proxy */ }
  }

  return { frameRef, src, proxied: !!port, ready, tree, selected, setSelected, post };
}

function Node({ node, depth, selectedPath, onPick, openSet, toggle }) {
  const key = node.path.join('.');
  const open = openSet.has(key) || depth < 2;
  const active = selectedPath === key;
  return (
    <>
      <div className={`layer ${active ? 'is-active' : ''}`} style={{ paddingLeft: 6 + depth * 12 }}>
        {node.children.length > 0
          ? <button className={`layer__chev ${open ? 'is-open' : ''}`} onClick={() => toggle(key)}><IconChevronRight size={10} /></button>
          : <span className="layer__chev" />}
        <button className={`layer__name ${node.component ? 'is-comp' : ''}`} onClick={() => onPick(node.path)}>{node.name}</button>
      </div>
      {open && node.children.map((c) => (
        <Node key={c.path.join('.')} node={c} depth={depth + 1} selectedPath={selectedPath} onPick={onPick} openSet={openSet} toggle={toggle} />
      ))}
    </>
  );
}

export function Layers({ bridge }) {
  const [openSet, setOpenSet] = useState(() => new Set());
  const toggle = (k) => setOpenSet((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const { tree, selected, proxied, ready, post } = bridge;
  return (
    <>
      <div className="fieldlabel">Capas</div>
      <div className="layers">
        {!proxied && <span className="screens__empty">Disponible con un servidor local (http://localhost) en la app de escritorio.</span>}
        {proxied && !ready && <span className="screens__empty">Esperando a la página…</span>}
        {proxied && ready && tree && tree.children.map((c) => (
          <Node key={c.path.join('.')} node={c} depth={0} selectedPath={selected?.path?.join('.')} onPick={(path) => post({ type: 'select', path })} openSet={openSet} toggle={toggle} />
        ))}
      </div>
    </>
  );
}

async function openSource(info) {
  const root = useAppStore.getState().workspaceRoot;
  if (info.source?.file) {
    const file = info.source.file.startsWith(root) || /^([a-zA-Z]:|\/)/.test(info.source.file)
      ? info.source.file
      : `${root}${root.includes('\\') ? '\\' : '/'}${info.source.file}`;
    useWorkbenchStore.getState().setMode('editor');
    useFileViewStore.getState().revealLine(file, info.source.line || 1);
    return true;
  }
  if (!info.component) return false;
  // React 19 ya no expone el archivo de origen: se busca la definición.
  const hits = await searchInFiles(`(function|const|class)\\s+${info.component}\\b`, { isRegex: true }).catch(() => []);
  const hit = hits.find((h) => /\.(tsx|jsx|ts|js|vue|svelte)$/.test(h.name));
  if (!hit) return false;
  useWorkbenchStore.getState().setMode('editor');
  useFileViewStore.getState().revealLine(hit.path, hit.line);
  return true;
}

const px = (v) => (v || '').replace(/px/g, '').replace(/\s+/g, ' ').trim();

export function InspectorPanel({ bridge, context, onAsk }) {
  const { selected, proxied, ready } = bridge;
  const [finding, setFinding] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => setNotFound(false), [selected]);

  if (!proxied) {
    return <div className="insp__empty">El inspector necesita la app de escritorio y un servidor de desarrollo local (http://localhost:…).</div>;
  }
  if (!selected) {
    return <div className="insp__empty">{ready ? 'Activa el cursor de inspección en la barra de la vista previa y haz clic en un elemento.' : <SpinRing size={14} />}</div>;
  }
  const s = selected.style;
  const find = async () => {
    setFinding(true);
    const ok = await openSource(selected);
    setFinding(false);
    setNotFound(!ok);
  };

  return (
    <div className="insp scroll">
      <div className="insp__head">
        <span className="insp__name">{selected.name}</span>
        <span className="mono insp__tag">&lt;{selected.tag}&gt;{selected.classes.length ? ` .${selected.classes.slice(0, 3).join(' .')}` : ''}</span>
        {(selected.component || selected.source) && (
          <button className="lk insp__src" onClick={find} disabled={finding}>
            {finding ? <SpinRing size={11} /> : <IconFileCode size={12} />}
            {selected.source ? `${selected.source.file.split(/[\\/]/).pop()}:${selected.source.line}` : 'Ir al código'}
          </button>
        )}
        {notFound && <span className="insp__muted">No encontré dónde se define {selected.component}.</span>}
      </div>

      <section className="insp__sec">
        <span className="insp__label">Tamaño</span>
        <div className="insp__grid">
          <span className="insp__kv"><em>W</em>{selected.rect.w}</span>
          <span className="insp__kv"><em>H</em>{selected.rect.h}</span>
        </div>
      </section>
      <section className="insp__sec">
        <span className="insp__label">Espaciado</span>
        <div className="insp__grid">
          <span className="insp__kv"><em>P</em>{px(s.padding)}</span>
          <span className="insp__kv"><em>M</em>{px(s.margin)}</span>
          <span className="insp__kv"><em>Gap</em>{s.gap === 'normal' ? '—' : px(s.gap)}</span>
          <span className="insp__kv"><em>Display</em>{s.display}{s.display.includes('flex') ? ` · ${s.flexDirection}` : ''}</span>
        </div>
      </section>
      <section className="insp__sec">
        <span className="insp__label">Relleno</span>
        <div className="insp__fill"><span className="insp__swatch" style={{ background: s.background }} /><span className="mono">{s.background}</span></div>
        <span className="insp__kv"><em>Radio</em>{px(s.radius)}</span>
      </section>
      <section className="insp__sec">
        <span className="insp__label">Texto</span>
        <div className="insp__fill"><span className="insp__swatch" style={{ background: s.color }} /><span className="mono">{s.color}</span></div>
        <span className="insp__kv"><em>Fuente</em>{s.fontFamily} · {px(s.fontSize)} · {s.fontWeight}</span>
        {selected.text && <p className="insp__text">«{selected.text}»</p>}
      </section>
      <section className="insp__sec">
        <span className="insp__label">Vista</span>
        <span className="insp__muted">{context}</span>
      </section>
      <button className="btn btn--primary insp__ask" onClick={onAsk}><LogoMark size={12} /> Pedir cambios sobre este elemento</button>
    </div>
  );
}
