// PreviewProofPack.jsx — la revisión empieza por la EVIDENCIA, no por un diff de 3.000 líneas.
// Distingue lo verificado automáticamente de lo que «dice el agente» y de lo inferido.
// Orden: 1) lo que necesita a una persona  2) lo que se comprobó  3) detalle. La decisión va en un panel fijo,
// atada al Intento y a su revisión: aceptar vale solo para lo que se ve.
import { useState } from 'react';
import { usePreviewStore, attemptById, taskOf } from './previewStore';
import { PROOF_PACKS, REVIEW_FILES } from './previewData';
import { I, Loc, Agent, StatePill } from './PreviewUi';
import { RISK_LABEL } from './previewVocab';

const SRC = { auto: ['auto', 'Verificado por el código de salida de una orden o un escáner'], agent: ['dice el agente', 'Lo informa el agente; nadie lo verificó'], inferred: ['inferido', 'Heurística: tómalo como pista'] };
const ST = { pass: ['✓', 'pv-good', 'Pasó'], fail: ['✕', 'pv-bad', 'Falló'], skipped: ['–', 'pv-tone-waiting', 'Sin ejecutar'], warn: ['!', 'pv-tone-waiting', 'Revisar'] };
const RISK_ORDER = { high: 0, medium: 1, low: 2 };

export function PreviewProofPack() {
  const s = usePreviewStore();
  const a = attemptById(s, s.sel.attemptId);
  const task = taskOf(s, a);
  const pp = PROOF_PACKS[a.id];
  const [q, setQ] = useState('');
  if (!pp) {
    return (
      <div className="pv-pad">
        <header className="pv-view__head"><h1 className="pv-view__title">Proof Pack</h1></header>
        <div className="changes__empty">
          El Intento {a.label} aún no tiene Proof Pack: se reúne cuando termina. Hasta ahora: {a.files} archivos, +{a.add}/−{a.del}{a.tests ? `, pruebas ${a.tests.pass}/${a.tests.total}` : ''}.
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.setView('review')}>Revisar los cambios igualmente</button>
        </div>
      </div>
    );
  }
  const files = REVIEW_FILES[a.id];
  const failedNow = pp.validation.filter((v) => v.status === 'fail').length;
  const notRun = pp.validation.filter((v) => v.status === 'skipped').length;
  const risks = [...pp.risks].sort((x, y) => RISK_ORDER[x.level] - RISK_ORDER[y.level]);
  const needs = pp.failed.length + pp.unverified.length + pp.review.length + pp.questions.length;
  return (
    <div className="pv-pp">
      <header className="pv-view__head">
        <h1 className="pv-view__title">Proof Pack</h1>
        <span className="pv-tag mono" title="Una revisión siempre apunta a Intento + revisión">{task.title} · Intento {a.label} @ {pp.revision}</span>
        <StatePill attempt={a} />
        <Agent attempt={a} detail={false} />
        <Loc attempt={a} parts={['branch', 'host']} forceHost />
      </header>
      <div className="pv-pp__body">
        <div className="pv-pp__main scroll">
          <section className="pv-pp__tier pv-pp__tier--human" aria-label="Necesita tu revisión">
            <h2 className="pv-pp__h"><span className="pv-pp__n mono">1</span>Necesita tu revisión<span className="count">{needs}</span></h2>
            {pp.failed.length > 0
              ? <ul className="pv-pp__list">{pp.failed.map((f) => <li key={f} className="pv-flag pv-tone-failed"><b>✕ Falló</b> {f}</li>)}</ul>
              : <p className="pv-muted"><span className="pv-good">✓</span> Nada falló por el camino.</p>}
            {pp.unverified.length > 0 && <ul className="pv-pp__list">{pp.unverified.map((f) => <li key={f} className="pv-flag pv-tone-waiting"><b>? Sin verificar</b> {f}</li>)}</ul>}
            <div className="pv-pp__group">
              <h3 className="ssec__label">Archivos en una ruta sensible · {pp.review.length}</h3>
              <div className="pv-wrap">{pp.review.map((f) => <button key={f} type="button" className="pv-chipbtn mono" onClick={() => s.setView('review')}>{f}</button>)}</div>
            </div>
            <div className="pv-pp__group">
              <h3 className="ssec__label">Riesgo · de mayor a menor</h3>
              <ul className="pv-insp__list pv-insp__list--plain">{risks.map((r) => <li key={r.text}><span className={`pv-risk pv-risk--${r.level}`}>{RISK_LABEL[r.level]}</span> {r.text}</li>)}</ul>
            </div>
            {pp.questions.length > 0 && (
              <div className="pv-pp__group">
                <h3 className="ssec__label">Pregunta abierta</h3>
                {pp.questions.map((x) => <p key={x}>{x}</p>)}
                <div className="pv-decide">
                  <input className="pv-input" placeholder="Responde al agente…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Respuesta" />
                  <button type="button" className="btn btn--ghost btn--sm" disabled={!q.trim()} onClick={() => { s.send({ attemptId: a.id, text: q.trim(), mode: 'queue' }); setQ(''); }}>Enviar</button>
                </div>
              </div>
            )}
          </section>

          <section className="pv-pp__tier" aria-label="Qué se comprobó">
            <h2 className="pv-pp__h"><span className="pv-pp__n mono">2</span>Qué se comprobó
              <span className="panelhead__fill" />
              {Object.values(SRC).map(([k, t]) => <span key={k} title={t} className="pv-tag pv-tag--dim">{k}</span>)}
            </h2>
            <table className="pv-table">
              <tbody>
                {pp.validation.map((v) => (
                  <tr key={v.name} className={v.status !== 'pass' ? `is-${v.status}` : ''}>
                    <td><span className={ST[v.status][1]}>{ST[v.status][0]} {ST[v.status][2]}</span></td>
                    <td>{v.name}</td>
                    <td className="mono">{v.result}</td>
                    <td className="pv-muted mono">{v.ms}</td>
                    <td><span className="pv-tag pv-tag--dim" title={SRC[v.src][1]}>{SRC[v.src][0]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h3 className="ssec__label">Seguridad y dependencias</h3>
            <ul className="pv-insp__list pv-insp__list--plain">
              {pp.security.map((x) => <li key={x.name}><span className={ST[x.status][1]}>{ST[x.status][0]}</span> {x.name} <span className="pv-muted">· {x.detail}</span></li>)}
              {pp.deps.map((d) => <li key={d.name}><span className="pv-tone-active">+</span> dependencia <b className="mono">{d.name}</b> <span className="pv-muted mono">{d.change}</span></li>)}
              {!pp.deps.length && <li className="pv-muted">Sin cambios de dependencias.</li>}
            </ul>
          </section>

          <details className="pv-pp__tier">
            <summary className="pv-pp__h"><span className="pv-pp__n mono">3</span>Detalle<span className="pv-muted">· qué intentó, qué cambió{pp.screenshots.length ? `, ${pp.screenshots.length} capturas` : ''}</span></summary>
            <div className="pv-pp__detail">
              <section><h3 className="ssec__label">Qué intentó el agente</h3><p><b>{pp.objective}.</b> {pp.approach}</p></section>
              <section>
                <h3 className="ssec__label">Qué cambió</h3>
                <p><b className="mono">{pp.files}</b> archivos · <b className="pv-good mono">+{pp.add}</b> <b className="pv-bad mono">−{pp.del}</b></p>
                <div className="pv-pp__bar"><i className="is-add" style={{ flex: pp.add }} /><i className="is-del" style={{ flex: pp.del }} /></div>
                {files && <p className="pv-muted">{files.filter((f) => f.risk === 'high').length} de riesgo alto · {files.filter((f) => f.generated).length} generados</p>}
              </section>
            </div>
            {pp.screenshots.length > 0 && <div className="pv-wrap">{pp.screenshots.map((l) => <span key={l} className="pv-shot"><I n="image" size={14} />{l}</span>)}</div>}
          </details>
        </div>

        <aside className="pv-pp__decide" aria-label={`Decisión para el Intento ${a.label} en ${pp.revision}`}>
          <span className="pv-muted">Decisión para</span>
          <b>{task.title}</b>
          <span className="mono">Intento {a.label} @ {pp.revision}</span>
          <ul className="pv-pp__verdict">
            <li className={failedNow ? 'is-bad' : ''}><b className="mono">{failedNow}</b> fallan ahora</li>
            <li className={pp.failed.length ? 'is-warn' : ''}><b className="mono">{pp.failed.length}</b> fallaron por el camino</li>
            <li className={pp.unverified.length + notRun ? 'is-warn' : ''}><b className="mono">{pp.unverified.length + notRun}</b> sin verificar o sin ejecutar</li>
            <li className={pp.review.length ? 'is-warn' : ''}><b className="mono">{pp.review.length}</b> archivos sensibles</li>
            <li><b className="mono">{pp.questions.length}</b> preguntas abiertas</li>
          </ul>
          <button type="button" className="btn btn--accent" onClick={() => s.setView('review')}>Revisar los cambios</button>
          <div className="pv-pp__two">
            <button type="button" className="btn btn--ghost" onClick={() => s.decide(a.id, 'accepted', pp.revision)} title={`Acepta solo la revisión ${pp.revision}`}>Aceptar @ {pp.revision}</button>
            <button type="button" className="btn pv-btn--danger" onClick={() => s.decide(a.id, 'rejected', pp.revision)}>Rechazar</button>
          </div>
          <p className="pv-muted">Aceptar vale solo para la revisión {pp.revision}. Automático no es demostrado: aquí nunca se afirma «la arquitectura es correcta» ni «no hay regresiones». Integrar lo decide una persona.</p>
        </aside>
      </div>
    </div>
  );
}
