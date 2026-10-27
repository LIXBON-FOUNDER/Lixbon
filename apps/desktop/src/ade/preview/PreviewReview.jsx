// PreviewReview.jsx — revisión archivo a archivo con el DiffView del producto. Una revisión apunta a
// Intento + revisión, no a «lo que haya ahora en una carpeta». Los comentarios se acumulan y viajan al
// agente como UN paquete; la siguiente ronda filtra lo que cambió desde la anterior.
import { useMemo, useState } from 'react';
import { DiffView } from '../../sections/SourceControl/DiffView';
import { Segmented } from '../../components/Segmented';
import { usePreviewStore, attemptById, taskOf } from './previewStore';
import { REVIEW_FILES, PATCHES, PROOF_PACKS } from './previewData';
import { I, Loc, Agent, Tabs } from './PreviewUi';
import { RISK_LABEL } from './previewVocab';

const FALLBACK_FILES = [
  { path: 'src/runtime/attempt.ts', add: 188, del: 12, risk: 'medium', since: true },
  { path: 'src/runtime/events.ts', add: 96, del: 0, risk: 'low', since: true },
  { path: 'src/runtime/session.ts', add: 142, del: 31, risk: 'high', since: false },
  { path: 'src/runtime/worktree.ts', add: 134, del: 12, risk: 'high', since: false },
];

function samplePatch(path) {
  const base = path.split('/').pop().replace(/\.[a-z]+$/, '');
  return [
    `diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`,
    `@@ -10,2 +10,6 @@ ${base}`,
    ` // ${base}`,
    `+export const ${base}Enabled = true;`,
    `+export function ${base}Init(opts = {}) {`,
    '+  return { ...defaults, ...opts };',
    '+}',
    ' ',
    '',
  ].join('\n');
}

const FILTERS = [{ id: 'all', label: 'Todos' }, { id: 'since', label: 'Desde la última' }, { id: 'unreviewed', label: 'Sin revisar' }, { id: 'high', label: 'Riesgo alto' }];

export function PreviewReview() {
  const s = usePreviewStore();
  const a = attemptById(s, s.sel.attemptId);
  const task = taskOf(s, a);
  const rv = s.review(a.id);
  const pp = PROOF_PACKS[a.id];
  const baseFiles = REVIEW_FILES[a.id] || FALLBACK_FILES;
  const [filter, setFilter] = useState(rv.round > 1 ? 'since' : 'all');
  const [hideGen, setHideGen] = useState(true);
  const [path, setPath] = useState(baseFiles[0].path);
  const [mode, setMode] = useState('inline');
  const [draft, setDraft] = useState('');
  const isSince = (f) => (rv.round > 1 ? rv.comments.some((c) => c.path === f.path) : f.since);
  const files = useMemo(() => baseFiles.filter((f) => (hideGen ? !f.generated : true)
    && (filter === 'all' || (filter === 'since' && isSince(f)) || (filter === 'unreviewed' && !rv.reviewed[f.path]) || (filter === 'high' && f.risk === 'high'))),
  [baseFiles, filter, hideGen, rv]); // eslint-disable-line react-hooks/exhaustive-deps
  const file = baseFiles.find((f) => f.path === path) || files[0] || baseFiles[0];
  const done = baseFiles.filter((f) => rv.reviewed[f.path]).length;
  const pending = rv.comments.filter((c) => !c.sent);
  const fileComments = rv.comments.filter((c) => c.path === file.path);
  const rev = pp?.revision || 'e5a02f7';
  const addComment = () => { if (!draft.trim()) return; s.addComment(a.id, file.path, draft.trim()); setDraft(''); };

  return (
    <div className="pv-rv">
      <header className="pv-view__head">
        <h1 className="pv-view__title">Revisión</h1>
        <span className="pv-tag mono">{task.title} · Intento {a.label} @ {rev}</span>
        <Agent attempt={a} detail={false} />
        <Loc attempt={a} parts={['branch']} />
        {rv.round > 1 && <span className="pv-tag pv-tag--accent">ronda {rv.round}</span>}
        <span className="panelhead__fill" />
        {pp && <button type="button" className="lk" onClick={() => s.setView('proof')}><I n="left" size={12} />Proof Pack</button>}
      </header>
      <div className="pv-rv__body">
        <aside className="pv-rv__files">
          <div className="pv-rv__progress"><b className="mono">{done}/{baseFiles.length}</b> revisados<span className="pv-meter"><i style={{ width: `${(done / baseFiles.length) * 100}%` }} /></span></div>
          <Tabs value={filter} onChange={setFilter} label="Filtrar archivos" options={FILTERS} />
          <label className="pv-check"><input type="checkbox" checked={hideGen} onChange={(e) => setHideGen(e.target.checked)} /> Ocultar archivos generados</label>
          <ul className="scroll">
            {files.map((f) => {
              const n = rv.comments.filter((c) => c.path === f.path).length;
              return (
                <li key={f.path} className={`${f.path === file.path ? 'is-on' : ''}${rv.reviewed[f.path] ? ' is-done' : ''}`}>
                  <input type="checkbox" checked={Boolean(rv.reviewed[f.path])} onChange={() => s.toggleReviewed(a.id, f.path)} aria-label={`Marcar ${f.path} como revisado`} />
                  <button type="button" onClick={() => setPath(f.path)}>
                    <span className={`pv-riskdot pv-riskdot--${f.risk}`} title={`riesgo ${RISK_LABEL[f.risk]}`} />
                    <span className="pv-rv__fname pv-trunc" title={f.path}><span className="mono">{f.path.split('/').pop()}</span><small>{f.path.split('/').slice(0, -1).join('/') || '.'}</small></span>
                    <span className="pv-good mono">+{f.add}</span><span className="pv-bad mono">−{f.del}</span>
                    {n > 0 && <span className="count">{n}</span>}
                  </button>
                </li>
              );
            })}
            {!files.length && <li className="pv-muted">Nada coincide con este filtro.</li>}
          </ul>
        </aside>
        <section className="pv-rv__diff" aria-label={`Diff de ${file.path}`}>
          <div className="pv-rv__dhead">
            <span className="mono pv-trunc">{file.path}</span>
            <span className={`pv-risk pv-risk--${file.risk}`}>riesgo {RISK_LABEL[file.risk]}</span>
            <span className="panelhead__fill" />
            <Segmented size="sm" value={mode} onChange={setMode} width={84} options={[{ value: 'split', label: 'Lado a lado' }, { value: 'inline', label: 'En línea' }]} />
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.toggleReviewed(a.id, file.path)}>{rv.reviewed[file.path] ? '✓ Revisado' : 'Marcar revisado'}</button>
          </div>
          <div className="pv-rv__patch scroll"><DiffView mode={mode} patch={PATCHES[file.path] || samplePatch(file.path)} /></div>
          <div className="pv-rv__comments">
            {fileComments.map((c) => (
              <div key={c.id} className={`pv-rv__comment${c.sent ? ' is-sent' : ''}`}>
                <I n="chat" size={12} /><span>{c.text}</span><span className="pv-muted">{c.sent ? 'enviado' : 'pendiente'}</span>
                {!c.sent && <button type="button" className="ic" aria-label="Quitar comentario" onClick={() => s.removeComment(a.id, c.id)}><I n="x" size={11} /></button>}
              </div>
            ))}
            <div className="pv-decide">
              <input className="pv-input" placeholder={`Comentario sobre ${file.path.split('/').pop()}…`} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addComment()} aria-label="Comentario" />
              <button type="button" className="btn btn--ghost btn--sm" disabled={!draft.trim()} onClick={addComment}>Añadir a la revisión</button>
            </div>
          </div>
        </section>
      </div>
      <footer className="pv-rv__foot">
        <span><b className="mono">{pending.length}</b> comentario{pending.length === 1 ? '' : 's'} pendiente{pending.length === 1 ? '' : 's'}{pending.length > 0 && <span className="pv-muted"> · van al agente en UN solo paquete</span>}</span>
        {done < baseFiles.length && <span className="pv-muted">· {baseFiles.length - done} sin marcar como revisados</span>}
        <span className="panelhead__fill" />
        <button type="button" className="btn btn--accent btn--sm" disabled={!pending.length} onClick={() => s.sendReview(a.id)}>Enviar la revisión ({pending.length})</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.decide(a.id, 'accepted', rev)} title={`Acepta solo la revisión ${rev}`}>Aceptar @ {rev}</button>
        <button type="button" className="btn btn--sm pv-btn--danger" onClick={() => s.decide(a.id, 'rejected', rev)}>Rechazar</button>
      </footer>
    </div>
  );
}
