// ProofPack.jsx — la revisión empieza por la EVIDENCIA, no por un diff de 3.000 líneas.
// Propuesta Lixbon (no estándar de mercado). Distingue evidencia automática de lo que "dice el agente" y de inferencias.
// Jerarquía: 1) lo que requiere revisión humana  2) validación  3) detalle. La decisión vive en un panel fijo, con su Attempt y revisión.
import { useState } from 'react';
import { useStore, attemptById, taskOf } from '../store';
import { PROOF_PACKS, REVIEW_FILES } from '../data';
import { I, Loc, Agent, StatePill } from '../ui';

const SRC = { auto: ['auto', 'Verified by a command exit code / scanner'], agent: ['agent says', 'Reported by the agent; not independently verified'], inferred: ['inferred', 'Heuristic — treat as a hint'] };
// Estado en palabras, no solo en glifo: «Failed» y «Not run» no se confunden con «Passed».
const ST = { pass: ['✓', 'good', 'Passed'], fail: ['✕', 'danger', 'Failed'], skipped: ['–', 'warn', 'Not run'], warn: ['!', 'warn', 'Check'] };
const RISK_ORDER = { high: 0, medium: 1, low: 2 };

function Shot({ label, i }) {
  return (
    <figure className="shot">
      <div className="shot__img" style={{ '--h': `${(i * 37) % 360}` }}><span /><span /><span /></div>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

export default function ProofPack() {
  const s = useStore();
  const a = attemptById(s, s.sel.attemptId);
  const task = taskOf(s, a);
  const pp = PROOF_PACKS[a.id];
  const [q, setQ] = useState('');
  if (!pp) {
    return (
      <div className="pad">
        <h1 className="v-title">Proof Pack</h1>
        <div className="empty">No Proof Pack for Attempt {a.label} yet — it is assembled when the Attempt finishes. Evidence so far: {a.files} files, +{a.add}/−{a.del}{a.tests ? `, tests ${a.tests.pass}/${a.tests.total}` : ''}.
          <div style={{ marginTop: 10 }}><button type="button" className="btn btn--ghost btn--sm" onClick={() => s.openReview(a.id)}>Review changes anyway</button></div></div>
      </div>
    );
  }
  const files = REVIEW_FILES[a.id];
  const flagged = pp.review;
  const notPassed = pp.validation.filter((v) => v.status !== 'pass');
  const failedChecks = pp.validation.filter((v) => v.status === 'fail').length;
  const risks = [...pp.risks].sort((x, y) => RISK_ORDER[x.level] - RISK_ORDER[y.level]);
  const attention = pp.failed.length + pp.unverified.length + flagged.length + pp.questions.length;
  return (
    <div className="ppx">
      <header className="v-head ppx__head">
        <h1 className="v-title">Proof Pack</h1>
        <span className="chip mono" title="A Review always targets Attempt + revision">{task.title} · Attempt {a.label} @ {pp.revision}</span>
        <StatePill attempt={a} /><Agent attempt={a} />
        <Loc attempt={a} parts={['branch', 'host']} forceHost />
      </header>

      <div className="ppx__body">
        <div className="ppx__main">
          {/* 1 · Lo que requiere una persona */}
          <section className="ppx__tier ppx__tier--human" aria-label="Needs your review">
            <h2 className="ppx__h"><span className="ppx__n">1</span>Needs your review<span className="chip chip--warn">{attention} item{attention === 1 ? '' : 's'}</span></h2>

            {pp.failed.length > 0
              ? <ul className="ppx__list">{pp.failed.map((f) => <li key={f} className="ppx__item ppx__item--fail"><b className="ppx__tag ppx__tag--fail">✕ Failed</b><span>{f}</span></li>)}</ul>
              : <p className="ppx__quiet"><span className="good">✓</span> Nothing failed along the way.</p>}

            {pp.unverified.length > 0 && <ul className="ppx__list">{pp.unverified.map((f) => <li key={f} className="ppx__item ppx__item--unv"><b className="ppx__tag ppx__tag--unv">? Not verified</b><span>{f}</span></li>)}</ul>}

            <div className="ppx__grp">
              <h3>Files on a security-sensitive path <span className="muted">· {flagged.length}</span></h3>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {flagged.map((f) => <button key={f} type="button" className="chip chip--warn mono pp__file" onClick={() => s.openReview(a.id)}>{f}</button>)}
              </div>
            </div>

            <div className="ppx__grp">
              <h3>Risk <span className="muted">· highest first</span></h3>
              <ul className="ppx__list ppx__list--plain">{risks.map((r) => <li key={r.text}><span className={`risk risk--${r.level}`}>{r.level}</span><span>{r.text}</span></li>)}</ul>
            </div>

            {pp.questions.length > 0 && (
              <div className="ppx__grp">
                <h3>Open question{pp.questions.length > 1 ? 's' : ''}</h3>
                {pp.questions.map((x) => <p key={x} className="pp__q">{x}</p>)}
                <div className="row"><input className="input" placeholder="Answer to the agent…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Answer" />
                  <button type="button" className="btn btn--ghost btn--sm" disabled={!q.trim()} onClick={() => { s.send({ attemptId: a.id, text: q.trim(), mode: 'queue' }); setQ(''); }}>Send</button></div>
              </div>
            )}
          </section>

          {/* 2 · Validación */}
          <section className="ppx__tier" aria-label="Validation">
            <h2 className="ppx__h"><span className="ppx__n">2</span>What it checked
              <span className="pp__legend">{Object.values(SRC).map(([k, t]) => <span key={k} title={t} className={`src src--${k.replace(' says', '')}`}>{k}</span>)}</span></h2>
            <table className="tbl ppx__tbl"><tbody>
              {pp.validation.map((v) => (
                <tr key={v.name} className={v.status !== 'pass' ? `is-${v.status}` : ''}>
                  <td><span className={`ppx__st ppx__st--${v.status}`} title={ST[v.status][2]}>{ST[v.status][0]} {ST[v.status][2]}</span></td>
                  <td>{v.name}</td><td className="mono">{v.result}</td><td className="muted">{v.ms}</td><td><span className={`src src--${v.src}`}>{SRC[v.src][0]}</span></td>
                </tr>
              ))}
            </tbody></table>
            <h3 className="ppx__sub">Security &amp; dependencies</h3>
            <ul className="pp__ul ppx__sec">
              {pp.security.map((x) => <li key={x.name}><span className={ST[x.status][1]}>{ST[x.status][0]}</span> {x.name}<small>{x.detail}</small></li>)}
              {pp.deps.map((d) => <li key={d.name}><span className="info">+</span> dependency <b className="mono">{d.name}</b><small>{d.change}</small></li>)}
              {!pp.deps.length && <li className="muted">No dependency changes.</li>}
            </ul>
          </section>

          {/* 3 · Detalle */}
          <details className="ppx__tier ppx__detail">
            <summary className="ppx__h"><span className="ppx__n">3</span>Detail<span className="muted">· what it tried, what changed{pp.screenshots.length ? `, ${pp.screenshots.length} screenshots` : ''}</span><I n="down" size={12} /></summary>
            <div className="ppx__dgrid">
              <section><h3>What the agent tried</h3><p><b>{pp.objective}.</b> {pp.approach}</p></section>
              <section>
                <h3>What changed</h3>
                <div className="pp__big"><b>{pp.files}</b> files <span className="row" style={{ display: 'inline-flex', marginLeft: 10, fontSize: 13 }}><b className="good">+{pp.add}</b><b className="danger">−{pp.del}</b></span></div>
                <div className="pp__bar"><i className="add" style={{ flex: pp.add }} /><i className="del" style={{ flex: pp.del }} /></div>
                {files && <div className="muted">{files.filter((f) => f.risk === 'high').length} high-risk · {files.filter((f) => f.generated).length} generated</div>}
              </section>
            </div>
            {pp.screenshots.length > 0 && (
              <section className="ppx__shots"><h3>Visual evidence <span className="muted">· {pp.screenshots.length} screenshots from a known flow</span></h3>
                <div className="pp__shots">{pp.screenshots.map((l, i) => <Shot key={l} label={l} i={i + 1} />)}</div></section>
            )}
          </details>
        </div>

        {/* Decisión: fija, con su Attempt y revisión */}
        <aside className="ppx__decide" aria-label={`Decision for Attempt ${a.label} at ${pp.revision}`}>
          <div className="ppx__ctx"><span className="muted">Decision for</span><b>{task.title}</b><span className="mono">Attempt {a.label} @ {pp.revision}</span></div>
          <ul className="ppx__verdict" aria-label="Review summary">
            <li className={failedChecks ? 'is-bad' : ''}><b>{failedChecks}</b> check{failedChecks === 1 ? '' : 's'} failing now</li>
            <li className={pp.failed.length ? 'is-warn' : ''}><b>{pp.failed.length}</b> failed along the way</li>
            <li className={pp.unverified.length ? 'is-warn' : ''}><b>{pp.unverified.length + notPassed.filter((v) => v.status === 'skipped').length}</b> not verified or not run</li>
            <li className={flagged.length ? 'is-warn' : ''}><b>{flagged.length}</b> sensitive file{flagged.length === 1 ? '' : 's'}</li>
            <li><b>{pp.questions.length}</b> open question{pp.questions.length === 1 ? '' : 's'}</li>
          </ul>
          <button type="button" className="btn btn--accent btn--lg btn--block" onClick={() => s.openReview(a.id)}>Review changes →</button>
          <div className="ppx__two">
            <button type="button" className="btn btn--ghost btn--lg" onClick={() => s.decide(a.id, 'accepted')} title={`Accepts only revision ${pp.revision}`}>Accept @ {pp.revision}</button>
            <button type="button" className="btn btn--danger btn--lg" onClick={() => s.decide(a.id, 'rejected')}>Reject</button>
          </div>
          <p className="muted ppx__note">Accepting is valid only for revision {pp.revision}. Automatic ≠ proven: “architecture is right” and “no regressions” are never claimed here.</p>
        </aside>
      </div>
    </div>
  );
}
