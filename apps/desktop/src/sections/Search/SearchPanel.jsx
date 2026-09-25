// SearchPanel.jsx — búsqueda en el proyecto: texto (con mayúsculas, palabra
// completa, regex y reemplazo) o semántica sobre el índice del código.
import { useEffect, useMemo, useRef, useState } from 'react';
import { searchInFiles, replaceInFiles } from '../../lib/tauri';
import { searchIndex } from '../../lib/codebaseIndex';
import { useAppStore } from '../../store/appStore';
import { useIndexStore } from '../../store/indexStore';
import { useFileViewStore } from '../../store/fileViewStore';
import { useWorkbenchStore } from '../../store/workbenchStore';
import { Segmented } from '../../components/Segmented';
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
  const indexStatus = useIndexStore((s) => s.status);
  const refreshIndex = useIndexStore((s) => s.refreshStatus);
  const [kind, setKind] = useState('text');
  const [query, setQuery] = useState('');
  const [replace, setReplace] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [opts, setOpts] = useState({ caseSensitive: false, wholeWord: false, isRegex: false });
  const [hits, setHits] = useState([]);
  const [chunks, setChunks] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState({});
  const [note, setNote] = useState('');
  const inputRef = useRef(null);
  const reqId = useRef(0);

  const pendingSearch = useWorkbenchStore((s) => s.pendingSearch);

  useEffect(() => {
    inputRef.current?.focus();
    refreshIndex();
  }, [refreshIndex]);

  useEffect(() => {
    const text = useWorkbenchStore.getState().takePendingSearch();
    if (text) { setKind('text'); setQuery(text); inputRef.current?.focus(); }
  }, [pendingSearch]);

  useEffect(() => {
    const q = query.trim();
    setNote('');
    if (!q || !root) { setHits([]); setChunks([]); setError(''); return undefined; }
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      setBusy(true);
      setError('');
      try {
        if (kind === 'text') {
          const res = await searchInFiles(q, opts);
          if (id === reqId.current) setHits(res.slice(0, MAX_HITS));
        } else {
          const res = await searchIndex(q, 12);
          if (id === reqId.current) setChunks(res);
        }
      } catch (e) {
        if (id === reqId.current) setError(String(e?.message || e));
      } finally {
        if (id === reqId.current) setBusy(false);
      }
    }, kind === 'text' ? 250 : 600);
    return () => clearTimeout(t);
  }, [query, opts, kind, root]);

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
        <Segmented
          value={kind}
          onChange={setKind}
          width={96}
          options={[{ value: 'text', label: 'Texto' }, { value: 'semantic', label: 'Semántica' }]}
        />
        <div className="searchpanel__row">
          {kind === 'text' && (
            <button className="ic" onClick={() => setShowReplace((v) => !v)} aria-label="Mostrar reemplazar">
              <IconChevronRight size={14} className={`chev ${showReplace ? 'is-open' : ''}`} />
            </button>
          )}
          <div className="field field--strong">
            <input
              ref={inputRef}
              className="mono"
              value={query}
              placeholder={kind === 'text' ? 'Buscar' : 'Describe lo que buscas'}
              onChange={(e) => setQuery(e.target.value)}
            />
            {kind === 'text' && (
              <>
                <button className={`opt ${opts.caseSensitive ? 'is-on' : ''}`} onClick={() => toggle('caseSensitive')} title="Distinguir mayúsculas">Aa</button>
                <button className={`opt ${opts.wholeWord ? 'is-on' : ''}`} onClick={() => toggle('wholeWord')} title="Palabra completa">ab</button>
                <button className={`opt ${opts.isRegex ? 'is-on' : ''}`} onClick={() => toggle('isRegex')} title="Expresión regular">.*</button>
              </>
            )}
          </div>
        </div>
        {kind === 'text' && showReplace && (
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
            : kind === 'text'
              ? (query.trim() ? `${hits.length}${hits.length >= MAX_HITS ? '+' : ''} resultados en ${groups.length} archivos` : '')
              : indexStatus.exists
                ? `${indexStatus.count} fragmentos indexados`
                : 'Sin índice: constrúyelo en Ajustes → Índice'}
        </div>
      </div>

      <div className="searchpanel__results scroll">
        {kind === 'text' && groups.map((g) => (
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
        {kind === 'semantic' && chunks.map((c, i) => (
          <button key={i} className="schunk rise" onClick={() => open(root + sep + c.rel.replace(/\//g, sep), c.start, c.rel.split('/').pop())}>
            <span className="schunk__head">
              <span className="sgroup__name">{c.rel.split('/').pop()}</span>
              <span className="sgroup__dir">{c.rel} · L{c.start}–{c.end}</span>
              <span className="count">{Math.round(c.score * 100)}%</span>
            </span>
            <span className="schunk__text mono">{c.text.slice(0, 220)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
