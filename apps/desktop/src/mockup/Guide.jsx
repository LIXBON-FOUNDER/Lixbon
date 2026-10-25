// Guide.jsx — preguntas → dónde mirar, decisiones de diseño y qué es simulado.
import { useState } from 'react';
import { useStore } from './store';
import { DECISIONS, QUESTIONS, SIMULATED } from './decisions';
import { I } from './ui';

export default function Guide() {
  const s = useStore();
  const [open, setOpen] = useState('D1');
  const go = (surface, view) => { if (view) { if (view === 'proof' || view === 'review') s.select('att_oa_b', view); else s.setView(view); } s.setSurface(surface); };
  return (
    <div className="guide">
      <section>
        <h2>Preguntas que esta maqueta debe poder responder</h2>
        <ul className="guide__q">{QUESTIONS.map(([q, surface, view]) => <li key={q}><button type="button" onClick={() => go(surface, view)}><span>{q}</span><I n="arrow" size={13} /></button></li>)}</ul>
      </section>
      <section>
        <h2>Decisiones de diseño <span className="muted">Problem · Options · Decision · Reason</span></h2>
        <div className="guide__d">
          {DECISIONS.map((d) => (
            <article key={d.id} className={open === d.id ? 'is-open' : ''}>
              <button type="button" onClick={() => setOpen(open === d.id ? null : d.id)}><span className="chip chip--tag">{d.id}</span><b>{d.area}</b><span className="grow">{d.problem}</span><I n={open === d.id ? 'down' : 'right'} size={12} /></button>
              {open === d.id && <dl><dt>Problem</dt><dd>{d.problem}</dd><dt>Options</dt><dd>{d.options}</dd><dt>Decision</dt><dd>{d.decision}</dd><dt>Reason</dt><dd>{d.reason}</dd></dl>}
            </article>
          ))}
        </div>
      </section>
      <section>
        <h2>Qué es simulado</h2>
        <ul className="guide__s">{SIMULATED.map((x) => <li key={x}>{x}</li>)}</ul>
        <div className="callout callout--warn">No se afirma ninguna mejora medida (p. ej. “40% menos tiempo de revisión”): el Proof Pack es una propuesta a validar con un experimento A/B, no un resultado.</div>
      </section>
    </div>
  );
}
