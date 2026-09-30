// SearchPanel.jsx — búsqueda de texto en el proyecto (mayúsculas, palabra
// completa, regex) con reemplazo.
import { useEffect, useMemo, useRef, useState } from 'react';
import { searchInFiles, replaceInFiles } from '../../lib/tauri';
import { useAppStore } from '../../store/appStore';
import { useFileViewStore } from '../../store/fileViewStore';
import { useWorkbenchStore } from '../../store/workbenchStore';
import { SpinRing } from '../../components/Ring';
import { IconChevronRight } from '../../components/Icons';

const MAX_HITS = 2000;

function Highlight({ text, query, opts }) {
  const parts = useMemo(() => {
    if (!query) return [text];
    try {
      const src = opts.isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(opts.wholeWord ? `\\b(?:${src})\\b` : src, opts.caseSensitive ? 'g' : 'gi');
      const out = [];
      let last = 0;
      for (const m of text.matchAll(re)) {
        if (!m[0]) break;
        out.push(text.slice(last, m.index), <mark key={m.index}>{m[0]}</mark>);
        last = m.index + m[0].length;
      }
      out.push(text.slice(last));
      return out;
    } catch {
      return [text];
    }
  }, [text, query, opts]);
  return <>{parts}</>;
}

export function SearchPanel() {
  const root = useAppStore((s) => s.workspaceRoot);
  const [query, setQuery] = useState('');
  const [replace, setReplace] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [opts, setOpts] = useState({ caseSensitive: false, wholeWord: false, isRegex: false });
  const [hits, setHits] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState({});
  const [note, setNote] = useState('');
  const inputRef = useRef(null);
  const reqId = useRef(0);

  const pendingSearch = useWorkbenchStore((s) => s.pendingSearch);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const text = useWorkbenchStore.getState().takePendingSearch();
    if (text) { setQuery(text); inputRef.current?.focus(); }
  }, [pendingSearch]);

  useEffect(() => {
    const q = query.trim();
    setNote('');
    if (!q || !root) { setHits([]); setError(''); return undefined; }
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      setBusy(true);
      setError('');
      try {
        const res = await searchInFiles(q, opts);
        if (id === reqId.current) setHits(res.slice(0, MAX_HITS));
      } catch (e) {
        if (id === reqId.current) setError(String(e?.message || e));
      } finally {
        if (id === reqId.current) setBusy(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, opts, root]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const h of hits) {
      if (!map.has(h.path)) map.set(h.path, { path: h.path, name: h.name, rel: h.path.slice(root.length + 1), hits: [] });
      map.get(h.path).hits.push(h);
    }
    return [...map.values()];
  }, [hits, root]);

  const doReplace = async () => {
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    try {
      const r = await replaceInFiles(q, replace, opts);
      setNote(`${r.replacements} reemplazos en ${r.files} archivos`);
      await useFileViewStore.getState().syncFromDisk();
      setHits(await searchInFiles(q, opts));
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (k) => setOpts((o) => ({ ...o, [k]: !o[k] }));
  const open = (path, line, name) => useFileViewStore.getState().revealLine(path, line, name);
  const sep = root.includes('\\') ? '\\' : '/';

  return (
    <div className="searchpanel">
      <div className="searchpanel__form">
        <div className="searchpanel__row">
          <button className="ic" onClick={() => setShowReplace((v) => !v)} aria-label="Mostrar reemplazar">
            <IconChevronRight size={14} className={`chev ${showReplace ? 'is-open' : ''}`} />
          </button>
          <div className="field field--strong">
            <input
              ref={inputRef}
              className="mono"
              value={query}
              placeholder="Buscar"
              onChange={(e) => setQuery(e.target.value)}
            />
            <button className={`opt ${opts.caseSensitive ? 'is-on' : ''}`} onClick={() => toggle('caseSensitive')} title="Distinguir mayúsculas">Aa</button>
            <button className={`opt ${opts.wholeWord ? 'is-on' : ''}`} onClick={() => toggle('wholeWord')} title="Palabra completa">ab</button>
            <button className={`opt ${opts.isRegex ? 'is-on' : ''}`} onClick={() => toggle('isRegex')} title="Expresión regular">.*</button>
          </div>
        </div>
        {showReplace && (
          <div className="searchpanel__row searchpanel__row--indent drop-in">
            <div className="field">
              <input className="mono" value={replace} placeholder="Reemplazar" onChange={(e) => setReplace(e.target.value)} />
            </div>
            <button className="lk" onClick={doReplace} disabled={!query.trim() || busy}>Todo</button>
          </div>
        )}
        <div className="searchpanel__summary">
          {busy && <SpinRing size={11} />}
          {error ? <span className="is-error">{error}</span>
            : note ? note
            : query.trim() ? `${hits.length}${hits.length >= MAX_HITS ? '+' : ''} resultados en ${groups.length} archivos` : ''}
        </div>
      </div>

      <div className="searchpanel__results scroll">
        {groups.map((g) => (
          <div key={g.path} className="sgroup rise">
            <button className="sgroup__head" onClick={() => setCollapsed((c) => ({ ...c, [g.path]: !c[g.path] }))}>
              <IconChevronRight size={12} className={`chev ${collapsed[g.path] ? '' : 'is-open'}`} />
              <span className="sgroup__name">{g.name}</span>
              <span className="sgroup__dir">{g.rel.split(sep).slice(0, -1).join('/')}</span>
              <span className="count">{g.hits.length}</span>
            </button>
            {!collapsed[g.path] && g.hits.map((h, i) => (
              <button key={i} className="shit mono" onClick={() => open(h.path, h.line, h.name)}>
                <span className="shit__ln">{h.line}</span>
                <span className="shit__text"><Highlight text={h.text.trim()} query={query.trim()} opts={opts} /></span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
