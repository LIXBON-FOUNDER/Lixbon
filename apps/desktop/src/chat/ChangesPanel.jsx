// ChangesPanel.jsx — lo que hizo el agente en esta conversación: archivos
// cambiados (diff real contra el contenido previo, aceptar o revertir), el
// contexto que leyó y los comandos que ejecutó.
import { useEffect, useMemo, useState } from 'react';
import { useChatStore } from '../store/chatStore';
import { useAppStore } from '../store/appStore';
import { useFileViewStore } from '../store/fileViewStore';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useReviewStore, pendingChanges } from '../store/reviewStore';
import { readFileContent } from '../lib/tauri';
import { diffHunks, diffStats } from '../lib/lineDiff';
import { Segmented } from '../components/Segmented';
import { SpinRing } from '../components/Ring';
import { IconCheck } from '../components/Icons';

const CONTEXT_TOOLS = { read_file: 'leer', outline: 'estructura', list_files: 'listar', find_files: 'buscar archivos', search: 'buscar', search_codebase: 'búsqueda semántica', fetch_url: 'web', web_search: 'web' };

function absOf(root, rel) {
  const sep = root.includes('\\') ? '\\' : '/';
  return root + sep + rel.replace(/\//g, sep);
}

function useTouchedFiles() {
  const messages = useChatStore((s) => s.messages);
  return useMemo(() => {
    const pending = pendingChanges(messages);
    const map = new Map();
    messages.forEach((m) => {
      const c = m.change;
      if (m.role !== 'tool' || !c?.path || m.ok === false || c.kind === 'command') return;
      const e = map.get(c.path) || { path: c.path, kind: c.kind, added: 0, removed: 0, reverted: true, accepted: false };
      if (!m.reverted) { e.added += c.added || 0; e.removed += c.removed || 0; e.reverted = false; }
      if (m.accepted) e.accepted = true;
      if (c.kind === 'create' || c.kind === 'delete') e.kind = c.kind;
      map.set(c.path, e);
    });
    return [...map.values()].map((e) => ({ ...e, pending: pending.get(e.path) }));
  }, [messages]);
}

function useCurrentText(abs, enabled) {
  const tabContent = useFileViewStore((s) => s.tabs.find((t) => t.path === abs && !t.loading)?.content);
  const [disk, setDisk] = useState(null);
  useEffect(() => {
    if (!enabled || tabContent !== undefined) return undefined;
    let alive = true;
    readFileContent(abs).then((t) => { if (alive) setDisk(t); }).catch(() => { if (alive) setDisk(''); });
    return () => { alive = false; };
  }, [abs, enabled, tabContent]);
  return tabContent !== undefined ? tabContent : disk;
}

function FileDiff({ root, entry }) {
  const abs = absOf(root, entry.path);
  const override = useReviewStore((s) => s.overrides[entry.path]);
  const current = useCurrentText(abs, !!entry.pending);
  const baseline = override !== undefined ? override : entry.pending?.baseline;
  const hunks = useMemo(() => (entry.pending && current != null ? diffHunks(baseline ?? '', current) : []), [entry.pending, baseline, current]);

  if (!entry.pending) {
    return <div className="changes__empty">{entry.reverted ? 'Revertido.' : 'Cambios aceptados.'}</div>;
  }
  if (current == null) return <div className="changes__empty"><SpinRing size={12} /></div>;
  if (!hunks.length) return <div className="changes__empty">Sin diferencias con el archivo original.</div>;
  return (
    <div className="changes__diff scroll mono">
      {hunks.map((h, i) => (
        <div key={i} className="hunk">
          <div className="dl dl--head">@@ −{h.oldStart + 1},{h.oldLines.length} +{h.newStart + 1},{h.newLines.length} @@</div>
          {h.oldLines.map((l, k) => <div key={`o${k}`} className="dl dl--del">−  {l}</div>)}
          {h.newLines.map((l, k) => <div key={`n${k}`} className="dl dl--add">+  {l}</div>)}
        </div>
      ))}
    </div>
  );
}

function ChangesTab() {
  const files = useTouchedFiles();
  const root = useAppStore((s) => s.workspaceRoot);
  const [selected, setSelected] = useState(null);
  const current = files.find((c) => c.path === selected) || files.find((c) => c.pending) || files[0];
  const pendingFiles = files.filter((f) => f.pending);
  const totals = pendingFiles.reduce((a, c) => ({ added: a.added + c.added, removed: a.removed + c.removed }), { added: 0, removed: 0 });

  const revert = async (entry) => {
    const { revertTool, messages } = useChatStore.getState();
    const indices = pendingChanges(messages).get(entry.path)?.indices || [];
    for (const i of [...indices].reverse()) await revertTool(i);
    useReviewStore.getState().clearOverride(entry.path);
    await useFileViewStore.getState().syncFromDisk();
  };
  const accept = (entry) => {
    useChatStore.getState().acceptChanges(entry.path);
    useReviewStore.getState().clearOverride(entry.path);
  };
  const acceptAll = () => {
    useChatStore.getState().acceptChanges(null);
    useReviewStore.getState().clearAll();
  };
  const revertAll = async () => { for (const c of pendingFiles) await revert(c); };
  const openInEditor = (entry) => {
    useWorkbenchStore.getState().setMode('editor');
    useFileViewStore.getState().open(absOf(root, entry.path));
  };

  if (!files.length) return <div className="changes__empty">Cuando el agente cree o edite archivos, aparecerán aquí con su diff.</div>;

  return (
    <>
      <div className="changes__summary">
        <span>{pendingFiles.length ? `${pendingFiles.length} por revisar` : 'Todo revisado'}</span>
        {pendingFiles.length > 0 && <span className="mono diffstat"><em className="is-add">+{totals.added}</em> <em className="is-del">−{totals.removed}</em></span>}
      </div>
      <div className="changes__list">
        {files.map((c) => (
          <button
            key={c.path}
            className={`changes__row ${current?.path === c.path ? 'is-active' : ''} ${c.pending ? '' : 'is-done'}`}
            onClick={() => setSelected(c.path)}
          >
            {!c.pending && <IconCheck size={12} />}
            <span className="mono changes__path">{c.path}</span>
            {c.kind === 'create' && <span className="tag tag--good">nuevo</span>}
            {c.kind === 'delete' && <span className="tag tag--danger">borrado</span>}
            {c.pending && <span className="mono diffstat"><em className="is-add">+{c.added}</em> <em className="is-del">−{c.removed}</em></span>}
          </button>
        ))}
      </div>

      {current && <FileDiff key={`${current.path}:${current.pending?.indices.length || 0}`} root={root} entry={current} />}

      <div className="changes__actions">
        {current?.pending && (
          <>
            <button className="btn btn--ghost btn--sm" onClick={() => accept(current)}>Aceptar</button>
            <button className="lk" onClick={() => revert(current)}>Revertir</button>
          </>
        )}
        <div className="panelhead__fill" />
        {current && current.kind !== 'delete' && !current.reverted && (
          <button className="lk" onClick={() => openInEditor(current)}>Abrir en editor</button>
        )}
      </div>
      {pendingFiles.length > 1 && (
        <div className="changes__actions changes__actions--all">
          <button className="btn btn--accent" onClick={acceptAll}>Aceptar todo</button>
          <button className="lk" onClick={revertAll}>Revertir todo</button>
        </div>
      )}
    </>
  );
}

function ClaudeContext() {
  const info = useChatStore((s) => s.ccInfo);
  const ctx = useChatStore((s) => s.ccContext);
  const cost = useChatStore((s) => s.ccCost);
  const pct = Math.min(100, Math.round((ctx.used / ctx.window) * 100));
  return (
    <div className="ccctx">
      <div className="ccctx__row"><span>Contexto</span><span className="mono">{ctx.used.toLocaleString('es')} / {ctx.window.toLocaleString('es')} · {pct}%</span></div>
      <div className="ccctx__bar"><i style={{ width: `${pct}%` }} /></div>
      {info && (
        <>
          <div className="ccctx__row"><span>Modelo</span><span className="mono">{info.model}</span></div>
          <div className="ccctx__row"><span>Herramientas</span><span className="mono">{info.tools}</span></div>
          {info.mcp.length > 0 && <div className="ccctx__row"><span>MCP</span><span className="mono ccctx__mcp">{info.mcp.map((m) => `${m.name}${m.status === 'connected' ? '' : ` (${m.status})`}`).join(', ')}</span></div>}
          {cost > 0 && <div className="ccctx__row"><span>Coste de la sesión</span><span className="mono">{cost.toFixed(2)} US$</span></div>}
          <div className="ccctx__row"><span>Versión</span><span className="mono">{info.version}</span></div>
        </>
      )}
    </div>
  );
}

function ContextTab() {
  const messages = useChatStore((s) => s.messages);
  const isClaude = useChatStore((s) => s.engine === 'claude');
  const items = useMemo(() => {
    const seen = new Map();
    for (const m of messages) {
      if (m.role !== 'tool' || !CONTEXT_TOOLS[m.tool]) continue;
      const a = m.args || {};
      const label = a.path || a.query || a.pattern || a.url || a.glob || '.';
      const key = `${m.tool}:${label}`;
      const prev = seen.get(key);
      seen.set(key, { tool: m.tool, label, count: (prev?.count || 0) + 1, ok: m.ok !== false, pending: m.pending });
    }
    return [...seen.values()];
  }, [messages]);

  if (!items.length) {
    return (
      <>
        {isClaude && <ClaudeContext />}
        <div className="changes__empty">Aquí verás los archivos que el agente lee y lo que busca para responder.</div>
      </>
    );
  }
  return (
    <div className="ctxlist scroll">
      {isClaude && <ClaudeContext />}
      {items.map((it) => (
        <div key={`${it.tool}:${it.label}`} className={`ctxrow ${it.ok ? '' : 'is-failed'}`}>
          <span className="ctxrow__kind">{CONTEXT_TOOLS[it.tool]}</span>
          <span className="mono ctxrow__label">{it.label}</span>
          {it.pending ? <SpinRing size={11} /> : it.count > 1 && <span className="mono ctxrow__count">×{it.count}</span>}
        </div>
      ))}
    </div>
  );
}

function TerminalTab() {
  const messages = useChatStore((s) => s.messages);
  const runs = useMemo(() => messages.filter((m) => m.role === 'tool' && m.tool === 'run_command'), [messages]);
  const [open, setOpen] = useState(null);
  if (!runs.length) return <div className="changes__empty">Los comandos que ejecute el agente aparecerán aquí con su salida.</div>;
  return (
    <div className="runlist scroll">
      {runs.map((r, i) => (
        <div key={i} className={`runrow ${r.ok === false ? 'is-failed' : ''}`}>
          <button className="runrow__head" onClick={() => setOpen(open === i ? null : i)}>
            {r.pending ? <SpinRing size={11} /> : <span className={`dot ${r.ok === false ? 'dot--danger' : 'dot--good'}`} />}
            <span className="mono runrow__cmd">{r.args?.command}</span>
          </button>
          {open === i && r.full && <pre className="mono runrow__out drop-in">{r.full}</pre>}
        </div>
      ))}
    </div>
  );
}

export function ChangesPanel() {
  const [tab, setTab] = useState('changes');
  return (
    <div className="changes">
      <div className="panelhead">
        <Segmented
          size="sm"
          value={tab}
          onChange={setTab}
          width={76}
          options={[{ value: 'changes', label: 'Cambios' }, { value: 'context', label: 'Contexto' }, { value: 'terminal', label: 'Terminal' }]}
        />
      </div>
      {tab === 'changes' && <ChangesTab />}
      {tab === 'context' && <ContextTab />}
      {tab === 'terminal' && <TerminalTab />}
    </div>
  );
}
