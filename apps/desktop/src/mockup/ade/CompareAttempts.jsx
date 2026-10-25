// CompareAttempts.jsx — dos (o más) Attempts de la MISMA Task, con el MISMO ContextPackage, lado a lado.
// Composición en dos zonas: arriba el RESUMEN (cifras y decisión, siempre a la vista); abajo la EXPLORACIÓN
// (diferencias, riesgos, evidencias) en un panel con scroll propio, para inspeccionar sin perder la comparación.
import { useState } from 'react';
import { useStore, attemptsOfTask, taskOf, attemptById, timelineOf } from '../store';
import { PROOF_PACKS, REVIEW_FILES } from '../data';
import { Agent, Loc, StatePill, I, Seg, money } from '../ui';

const APPROACH = {
  att_oa_a: 'Rotates refresh tokens in place and keeps a sliding-expiry fallback. Still thinking about live-session compatibility.',
  att_oa_b: PROOF_PACKS.att_oa_b.approach,
  att_rt_a: 'Event-sourced state machine; worktree manager resolves paths through ProjectLocation.',
  att_rt_b: PROOF_PACKS.att_rt_b.approach,
};
const WARN = { att_oa_a: 0, att_oa_b: 1, att_rt_a: 0, att_rt_b: 3 };

function best(vals, dir) {
  const v = vals.filter((x) => x != null);
  if (v.length < 2) return -1;
  const t = dir === 'min' ? Math.min(...v) : Math.max(...v);
  return vals.filter(x => x === t).length > 1 ? -1 : vals.indexOf(t);
}

const sign = (n) => (n > 0 ? `+${n}` : `${n}`);

/** Diferencias que salen solo de cifras ya mostradas: hechos, no un veredicto. */
function deltas(a, b) {
  const out = [];
  const files = b.files - a.files;
  if (files) out.push(`${Math.abs(files)} ${files > 0 ? 'more' : 'fewer'} files`);
  const lines = (b.add - b.del) - (a.add - a.del);
  if (lines) out.push(`${sign(lines)} net lines`);
  const min = b.minutes - a.minutes;
  if (min) out.push(`${Math.abs(min)} min ${min < 0 ? 'faster' : 'slower'}`);
  const cost = +(b.cost - a.cost).toFixed(2);
  if (cost) out.push(`${money(Math.abs(cost))} ${cost < 0 ? 'cheaper' : 'costlier'}`);
  return out;
}

/** Archivos que cambió cada Attempt: del Review si existe; si no, de sus ediciones en la actividad. */
function filesOf(s, a) {
  return REVIEW_FILES[a.id] || timelineOf(s, a).filter((e) => e.kind === 'edits').flatMap((e) => e.files);
}

function Differences({ atts, s }) {
  return (
    <div className="cmpx__cols" style={{ gridTemplateColumns: `repeat(${atts.length}, minmax(0, 1fr))` }}>
      {atts.map((a, i) => (
        <section key={a.id} className="cmpx__card" aria-label={`Approach of Attempt ${a.label}`}>
          <h3>Attempt {a.label} · approach</h3>
          <p>{APPROACH[a.id] || 'Approach summary available when the Attempt finishes.'}</p>
          <FileList files={filesOf(s, a)} a={a} />
          {atts.length === 2 && i === 1 && <p className="cmpx__delta"><b>B vs A</b> {deltas(atts[0], atts[1]).join(' · ') || 'no measurable difference yet'}<small>Differences are facts from the table above, not a verdict.</small></p>}
        </section>
      ))}
    </div>
  );
}

function FileList({ files, a }) {
  if (!files.length) return <p className="muted">{a.files} files changed — the list is available when the review is ready.</p>;
  return (
    <ul className="cmpx__files" aria-label={`Files changed in Attempt ${a.label}`}>
      {files.map((f) => <li key={f.path}>{f.risk && <span className={`risk-dot risk-dot--${f.risk}`} title={`${f.risk} risk`} />}<span className="mono trunc grow" title={f.path}>{f.path}</span><span className="good">+{f.add}</span><span className="danger">−{f.del}</span></li>)}
    </ul>
  );
}

function Risks({ atts }) {
  return (
    <div className="cmpx__cols" style={{ gridTemplateColumns: `repeat(${atts.length}, minmax(0, 1fr))` }}>
      {atts.map((a) => {
        const p = PROOF_PACKS[a.id];
        const w = WARN[a.id] ?? 0;
        return (
          <section key={a.id} className="cmpx__card" aria-label={`Risks of Attempt ${a.label}`}>
            <h3>Attempt {a.label} · risks{w > 0 && <span className="chip chip--warn">{w} warning{w > 1 ? 's' : ''}</span>}</h3>
            {p ? <ul className="cmpx__ul">{p.risks.map((r) => <li key={r.text}><span className={`risk risk--${r.level}`}>{r.level}</span>{r.text}</li>)}</ul> : <p className="muted">Not assessed yet — risks are assessed when the Attempt finishes.</p>}
          </section>
        );
      })}
    </div>
  );
}

function Evidence({ atts, s }) {
  return (
    <div className="cmpx__cols" style={{ gridTemplateColumns: `repeat(${atts.length}, minmax(0, 1fr))` }}>
      {atts.map((a) => {
        const p = PROOF_PACKS[a.id];
        const notPassed = p ? p.validation.filter((v) => v.status !== 'pass') : [];
        return (
          <section key={a.id} className="cmpx__card" aria-label={`Evidence of Attempt ${a.label}`}>
            <h3>Attempt {a.label} · evidence</h3>
            {p ? (
              <>
                <p className="cmpx__sum">{p.validation.length - notPassed.length} of {p.validation.length} checks passed{notPassed.length > 0 && <> · <b className="danger">{notPassed.length} not passed</b></>}</p>
                {p.failed.map((f) => <p key={f} className="cmpx__flag cmpx__flag--fail"><b>Failed</b>{f}</p>)}
                {p.unverified.map((f) => <p key={f} className="cmpx__flag cmpx__flag--unv"><b>Not verified</b>{f}</p>)}
              </>
            ) : <p className="muted">Evidence is assembled when the Attempt finishes.</p>}
            <div className="row" style={{ flexWrap: 'wrap', marginTop: 'auto' }}>
              <button type="button" className="btn btn--merged btn--sm" disabled={!p} onClick={() => s.select(a.id, 'proof')}><I n="eye" size={12} />Proof Pack</button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.openReview(a.id)}>Open diff</button>
            </div>
          </section>
        );
      })}
    </div>
  );
}

export default function CompareAttempts() {
  const s = useStore();
  const cur = attemptById(s, s.sel.attemptId);
  const task = taskOf(s, cur);
  const atts = attemptsOfTask(s, task.id);
  const [msg, setMsg] = useState('');
  const [pane, setPane] = useState('diff');
  if (atts.length < 2) {
    return (
      <div className="pad">
        <h1 className="v-title">Compare Attempts</h1>
        <div className="empty">“{task.title}” has a single Attempt. <button type="button" className="btn btn--accent btn--sm" onClick={() => s.openFork(cur.id)}>Fork as Attempt</button> to try a different agent from the same ContextPackage.</div>
      </div>
    );
  }
  const rows = [
    ['Files changed', atts.map((a) => a.files), best(atts.map((a) => a.files), 'min'), (v) => `${v} files`],
    ['Lines', atts.map((a) => <span key={a.id}><b className="good">+{a.add}</b> <b className="danger">−{a.del}</b></span>)],
    ['Tests', atts.map((a) => (a.tests ? a.tests.pass / a.tests.total : null)), best(atts.map((a) => (a.tests ? a.tests.pass / a.tests.total : null)), 'max'), (v, a) => (a.tests ? `${a.tests.pass}/${a.tests.total}` : '—')],
    ['Time', atts.map((a) => a.minutes), best(atts.map((a) => a.minutes), 'min'), (v) => `${v} min`],
    ['Usage', atts.map((a) => a.cost), best(atts.map((a) => a.cost), 'min'), (v, a) => `${money(v)} · ${(a.tokens / 1000).toFixed(0)}k tok`],
    ['Warnings', atts.map((a) => WARN[a.id] ?? 0), best(atts.map((a) => WARN[a.id] ?? 0), 'min'), (v) => (v ? `${v} warning${v > 1 ? 's' : ''}` : 'none')],
    ['Risks', atts.map((a) => { const p = PROOF_PACKS[a.id]; return p ? <span key={a.id} className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{p.risks.map((r, i) => <span key={i} className={`risk risk--${r.level}`}>{r.level}</span>)}</span> : <span key={a.id} className="muted">not assessed yet</span>; })],
  ];
  const cols = `104px repeat(${atts.length}, minmax(0, 1fr))`;
  return (
    <div className="cmpx">
      <header className="v-head cmpx__head">
        <h1 className="v-title">Compare Attempts · {task.title}</h1>
        <span className="chip chip--good">Same ContextPackage {atts[0].ctx}</span>
        <span className="muted">{atts.some(a => ['working', 'starting', 'waiting'].includes(a.state)) ? 'Provisional comparison · some Attempts are still running' : 'Compare evidence before choosing a result'}</span>
      </header>

      <section className="cmpx__top" aria-label="Comparison summary">
        <div className="cmpx__grid" style={{ gridTemplateColumns: cols }}>
          <div />
          {atts.map((a) => (
            <div key={a.id} className={`cmpx__col ${s.choice[task.id] === a.id ? 'is-chosen' : ''}`}>
              <div className="row"><span className="astrip__l">{a.label}</span><Agent attempt={a} /><StatePill attempt={a} />{s.choice[task.id] === a.id && <span className="chip chip--tag chip--good">chosen</span>}</div>
              <Loc attempt={a} parts={['branch', 'host']} forceHost />
              <button type="button" className="btn btn--accent btn--sm cmpx__choose" onClick={() => s.choose(task.id, a.id)}>Choose {a.label} · {a.provider === 'local' ? 'Local' : a.provider[0].toUpperCase() + a.provider.slice(1)}</button>
            </div>
          ))}
          {rows.map(([label, cells, bestIdx, fmt]) => (
            <div key={label} className="cmpx__rowwrap" style={{ display: 'contents' }}>
              <div className="cmpv__lab">{label}</div>
              {cells.map((c, i) => {
                const a = atts[i];
                const isPrim = fmt && c != null;
                return <div key={a.id} className={`cmpv__cell ${bestIdx === i ? 'is-best' : ''}`}>{isPrim ? fmt(c, a) : c == null ? <span className="muted">—</span> : c}{bestIdx === i && <i title="Best of the set">★</i>}</div>;
              })}
            </div>
          ))}
        </div>
      </section>

      <section className="cmpx__explore" aria-label="Explore the comparison">
        <div className="cmpx__bar">
          <Seg value={pane} onChange={setPane} options={[{ id: 'diff', label: 'Differences' }, { id: 'risks', label: 'Risks' }, { id: 'evidence', label: 'Evidence' }]} />
          <span className="sp" />
          <input className="input cmpx__ask" placeholder="One instruction for both…" value={msg} onChange={(e) => setMsg(e.target.value)} aria-label="Instruction for all Attempts" />
          <button type="button" className="btn btn--ghost btn--sm" disabled={!msg.trim()} onClick={() => { atts.forEach((a) => s.send({ attemptId: a.id, text: msg })); setMsg(''); }}>Ask both to revise</button>
        </div>
        <div className="cmpx__pane" role="tabpanel">
          {pane === 'diff' && <Differences atts={atts} s={s} />}
          {pane === 'risks' && <Risks atts={atts} />}
          {pane === 'evidence' && <Evidence atts={atts} s={s} />}
        </div>
        <p className="muted cmpv__note">“Choose” records the winner and offers to archive the rest. Nothing is deleted or merged until Integration.</p>
      </section>
    </div>
  );
}
