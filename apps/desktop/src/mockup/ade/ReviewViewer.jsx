// ReviewViewer.jsx — revisión archivo por archivo. Una Review apunta a Attempt + revisión, no a "lo que haya ahora en una carpeta".
// Los comentarios se ACUMULAN y viajan al agente como UN paquete de feedback; la siguiente revisión abre en "Since last review".
import { useMemo } from 'react';
import { useStore, attemptById, taskOf } from '../store';
import { REVIEW_FILES, DIFFS, PROOF_PACKS } from '../data';
import { I, Seg, Loc, Agent } from '../ui';

function fakeDiff(path) {
  const base = path.split('/').pop().replace(/\.[a-z]+$/, '');
  return [
    { t: 'hunk', text: `@@ -10,6 +10,12 @@ ${base}` },
    { t: 'ctx', n: 10, text: `// ${base}` },
    { t: 'add', n: 11, text: `export const ${base}Enabled = true;` },
    { t: 'add', n: 12, text: `export function ${base}Init(opts = {}) {` },
    { t: 'add', n: 13, text: '  return { ...defaults, ...opts };' },
    { t: 'add', n: 14, text: '}' },
    { t: 'ctx', n: 15, text: '' },
  ];
}

const FILTERS = [['all', 'All'], ['since', 'Since last review'], ['unreviewed', 'Unreviewed'], ['high', 'High risk']];

export default function ReviewViewer({ embedded = false }) {
  const s = useStore();
  const a = attemptById(s, s.sel.attemptId);
  const task = taskOf(s, a);
  const rv = s.review(a.id);
  const pp = PROOF_PACKS[a.id];
  const baseFiles = REVIEW_FILES[a.id] || [
    { path: 'src/runtime/attempt.ts', add: 188, del: 12, risk: 'medium', since: true },
    { path: 'src/runtime/events.ts', add: 96, del: 0, risk: 'low', since: true },
    { path: 'src/runtime/session.ts', add: 142, del: 31, risk: 'high', since: false },
    { path: 'src/runtime/worktree.ts', add: 134, del: 12, risk: 'high', since: false },
  ];
  const ui = rv.ui || {};
  const setUi = (patch) => s.patchReview(a.id, { ui: { ...(s.review(a.id).ui || {}), ...patch } });
  const filter = ui.filter || (rv.round > 1 ? 'since' : 'all');
  const setFilter = (filter) => setUi({ filter });
  const hideGen = ui.hideGen ?? true;
  const setHideGen = (hideGen) => setUi({ hideGen });
  const path = ui.path || baseFiles[0].path;
  const setPath = (path) => setUi({ path });
  const commenting = ui.commenting || null;
  const setCommenting = (commenting) => setUi({ commenting });
  const draft = ui.draft || '';
  const setDraft = (draft) => setUi({ draft });
  const isSince = (f) => (rv.round > 1 ? rv.comments.some((c) => c.path === f.path) : f.since);
  const files = useMemo(() => baseFiles.filter((f) => (hideGen ? !f.generated : true) && (filter === 'all' || (filter === 'since' && isSince(f)) || (filter === 'unreviewed' && !rv.reviewed[f.path]) || (filter === 'high' && f.risk === 'high'))), [filter, hideGen, rv.reviewed, rv.round, rv.comments]); // eslint-disable-line
  const file = baseFiles.find((f) => f.path === path) || files[0];
  const diff = DIFFS[file.path] || fakeDiff(file.path);
  const done = baseFiles.filter((f) => rv.reviewed[f.path]).length;
  const pending = rv.comments.filter((c) => !c.sent);
  const rev = pp?.revision || 'a91f3c2';

  return (
    <div className={`rv ${embedded ? 'rv--embedded' : ''}`}>
      <header className="rv__head">
        <h1 className="v-title">Review</h1>
        <span className="chip mono">{task.title} · Attempt {a.label} @ {rev}</span>
        <Agent attempt={a} /><Loc attempt={a} parts={['branch']} />
        {rv.round > 1 && <span className="chip chip--tag chip--accent">round {rv.round}</span>}
        <span className="sp" />
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.openProof(a.id)}>← {pp ? 'Proof Pack' : 'Workspace'}</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => { s.setMockUi({ ideReviewOpen: false }); s.setSurface('ide'); }}>Edit code</button>
      </header>

      <div className="rv__body">
        <aside className="rv__files">
          <div className="rv__prog"><b>{done}/{baseFiles.length}</b> reviewed<span className="rv__pbar"><i style={{ width: `${(done / baseFiles.length) * 100}%` }} /></span></div>
          <Seg value={filter} onChange={setFilter} options={FILTERS.map(([id, label]) => ({ id, label }))} />
          <label className="row muted" style={{ fontSize: 11.5 }}><input type="checkbox" checked={hideGen} onChange={(e) => setHideGen(e.target.checked)} /> Hide generated files</label>
          <ul>
            {files.map((f) => (
              <li key={f.path} className={`${f.path === file.path ? 'is-on' : ''} ${rv.reviewed[f.path] ? 'is-done' : ''}`}>
                <input type="checkbox" checked={!!rv.reviewed[f.path]} onChange={() => s.toggleReviewed(a.id, f.path)} aria-label={`Mark ${f.path} reviewed`} />
                <button type="button" onClick={() => setPath(f.path)}>
                  <span className={`risk-dot risk-dot--${f.risk}`} title={`${f.risk} risk`} />
                  <span className="mono trunc grow">{f.path}</span>
                  <span className="good">+{f.add}</span><span className="danger">−{f.del}</span>
                  {rv.comments.some((c) => c.path === f.path) && <span className="chip chip--tag chip--warn">{rv.comments.filter((c) => c.path === f.path).length}</span>}
                </button>
              </li>
            ))}
            {!files.length && <li className="muted" style={{ padding: 8 }}>Nothing matches this filter.</li>}
          </ul>
        </aside>

        <section className="rv__diff" aria-label={`Diff of ${file.path}`}>
          <div className="rv__dh"><span className="mono">{file.path}</span><span className={`risk risk--${file.risk}`}>{file.risk} risk</span><span className="sp" />
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.toggleReviewed(a.id, file.path)}>{rv.reviewed[file.path] ? '✓ Reviewed' : 'Mark reviewed'}</button></div>
          <div className="diff">
            {diff.map((l, i) => {
              if (l.t === 'hunk') return <div key={i} className="diff__hunk">{l.text}</div>;
              const cm = rv.comments.filter((c) => c.path === file.path && c.line === l.n);
              return (
                <div key={i}>
                  <div className={`diff__l diff__l--${l.t}`}>
                    <button type="button" className="diff__plus" aria-label={`Comment on line ${l.n}`} onClick={() => { setCommenting(`${file.path}:${l.n}`); setDraft(''); }}>+</button>
                    <span className="diff__n">{l.n}</span><span className="diff__s">{l.t === 'add' ? '+' : l.t === 'del' ? '−' : ' '}</span><code>{l.text}</code>
                  </div>
                  {cm.map((c) => <div key={c.id} className={`diff__c ${c.sent ? 'is-sent' : ''}`}><I n="chat" size={12} /><span>{c.text}</span><span className="muted">{c.sent ? 'sent' : 'pending'}</span>{!c.sent && <button type="button" aria-label="Delete comment" onClick={() => s.removeComment(a.id, c.id)}><I n="x" size={11} /></button>}</div>)}
                  {commenting === `${file.path}:${l.n}` && (
                    <div className="diff__new">
                      <input className="input" autoFocus placeholder={`Comment on line ${l.n}…`} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) { s.addComment(a.id, file.path, l.n, draft.trim()); setCommenting(null); } if (e.key === 'Escape') setCommenting(null); }} />
                      <button type="button" className="btn btn--ghost btn--sm" disabled={!draft.trim()} onClick={() => { s.addComment(a.id, file.path, l.n, draft.trim()); setCommenting(null); }}>Add to review</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {done < baseFiles.length && <div className="hier-review-note"><I n="warn" /> {baseFiles.length - done} files have not been marked reviewed. Accepting records this revision; integration remains pending.</div>}
      <footer className="rv__foot">
        <div className="rv__pend">
          <b>{pending.length}</b> pending comment{pending.length === 1 ? '' : 's'}
          {pending.length > 0 && <span className="muted"> · {new Set(pending.map((c) => c.path)).size} file(s) · they go to the agent as ONE feedback package</span>}
        </div>
        <span className="sp" />
        <button type="button" className="btn btn--accent" disabled={!pending.length} onClick={() => s.sendReview(a.id)}>Send review to agent ({pending.length})</button>
        <button type="button" className="btn btn--ghost" onClick={() => s.decide(a.id, 'accepted')} title={`Accepts only revision ${rev}`}>Accept @ {rev}</button>
        <button type="button" className="btn btn--danger" onClick={() => s.decide(a.id, 'rejected')}>Reject</button>
      </footer>
    </div>
  );
}
