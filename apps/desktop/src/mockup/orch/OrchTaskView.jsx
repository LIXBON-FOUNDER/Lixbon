// OrchTaskView.jsx — una hija (o el coordinador) por dentro: cabecera con su identidad, aviso de lo que espera de ti,
// y Terminal · Actividad · Cambios. La acción principal depende del estado, nunca está escondida.
import React, { useEffect, useRef, useState } from 'react';
import { useOrch, isFinal, isAwaiting, isMerged, canIntegrate, canReview, reviewStatus, unansweredQuestions, STATUS_LABEL } from './orchStore';
import { PROJECT } from './orchData';
import { StatusMark, AgentChip, Liveness, PlanTag, Seg, Empty, Txt, roleName, stateText, clock, I } from './orchUi';

const KIND = { phase: 'Fase', done: 'Entrega', question: 'Pregunta', reply: 'Respuesta', note: 'Nota', exited: 'Cerrada' };
const ago = (m) => (m <= 0 ? 'ahora' : m < 60 ? `hace ${m} min` : `hace ${Math.round(m / 60)} h`);

function Terminal({ t }) {
  const end = useRef(null);
  const approve = useOrch((s) => s.approveTerminal);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [t.log?.length]);
  if (!t.parent) return <Empty>El coordinador es el chat del modo Agente; su terminal no se muestra aquí. Sigue sus órdenes en «Actividad».</Empty>;
  const lines = t.log || [];
  return (
    <div className="o-term" role="log" aria-label={`Terminal de ${t.title}`}>
      {lines.map(([k, text], i) => <div key={i} className={`o-term__l o-term__l--${k}`}>{text}</div>)}
      {isAwaiting(t) && (
        <div className="o-term__ask">
          <p className="mono">{t.approval.command}</p>
          <p>{t.approval.why} Si nadie responde en {t.approval.deadlineMin} min, la tarea falla.</p>
          <div className="o-actions">
            <button type="button" className="btn btn--accent btn--sm" onClick={() => approve(t.id, true)}>Aprobar</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => approve(t.id, false)}>Rechazar</button>
          </div>
        </div>
      )}
      {t.status === 'running' && <div className="o-term__l o-term__cursor" aria-hidden="true">▍</div>}
      <div ref={end} />
    </div>
  );
}

function Activity({ t }) {
  const s = useOrch();
  const mine = s.messages.filter((m) => m.from === t.id || m.to === t.id);
  const name = (id) => (id === 'persona' ? 'Tú' : s.tasks.find((x) => x.id === id)?.title || id);
  return (
    <div className="o-act">
      <section><h3>Encargo</h3><p className="o-spec"><Txt>{t.spec}</Txt></p></section>
      {t.summary && <section><h3>Resumen final</h3><p className="o-spec"><Txt>{t.summary}</Txt></p>{t.files?.length > 0 && <p className="o-meta mono">{t.files.join(' · ')}</p>}</section>}
      {t.failure && <section><h3>Qué pasó</h3><p className="o-spec">{t.failure} Perder contacto no prueba que murió: aquí sí hay prueba, el proceso terminó con código 1.</p></section>}
      <section>
        <h3>Fases</h3>
        {t.phases.length ? (
          <ol className="o-phases">
            {t.phases.map((p, i) => {
              const state = p.done ? 'done' : isFinal(t) ? 'stopped' : 'running';
              return (
                <li key={i} className={`is-${state}`}>
                  <span className="o-phases__dot" aria-hidden="true" />
                  <span className="o-phases__name">{p.name}</span>
                  <span className="o-meta">{p.done ? 'terminada' : state === 'running' ? 'en curso' : 'sin cerrar'} · {ago(p.ago)}</span>
                  {p.note && <span className="o-phases__note"><Txt>{p.note}</Txt></span>}
                </li>
              );
            })}
          </ol>
        ) : <Empty>Aún no ha informado de ninguna fase.</Empty>}
      </section>
      <section>
        <h3>Mensajes</h3>
        {mine.length ? (
          <ul className="o-msgs">
            {mine.slice().reverse().map((m) => (
              <li key={m.id} className={`o-msg o-msg--${m.kind}`}>
                <span className="o-meta"><b>{KIND[m.kind] || m.kind}</b> · {name(m.from)} → {name(m.to)} · {ago(m.at)}</span>
                <span><Txt>{m.body}</Txt></span>
              </li>
            ))}
          </ul>
        ) : <Empty>Sin mensajes todavía.</Empty>}
      </section>
    </div>
  );
}

function Changes({ t }) {
  const s = useOrch();
  const [open, setOpen] = useState(0);
  if (!t.diff?.length) return <Empty>Sin commits nuevos en la rama todavía.</Empty>;
  const f = t.diff[open];
  return (
    <div className="o-changes">
      <div className="o-changes__head">
        <span className="o-meta mono">{PROJECT.coordBranch}...{t.branch}</span>
        {canReview(s, t) && <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.openDialog({ kind: 'review', taskId: t.id })}>Abrir revisión</button>}
      </div>
      <table className="o-tbl">
        <thead><tr><th>Archivo</th><th className="r">Añadidas</th><th className="r">Quitadas</th></tr></thead>
        <tbody>
          {t.diff.map((d, i) => (
            <tr key={d.path} className={i === open ? 'is-sel' : ''} onClick={() => setOpen(i)}>
              <td className="mono">{d.path.split('/').slice(-2).join('/')}</td><td className="r good">+{d.add}</td><td className="r bad">−{d.del}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <pre className="o-diff mono" aria-label={`Cambios en ${f.path}`}>{f.hunk.map(([k, line], i) => <span key={i} className={`o-diff__${k === '+' ? 'add' : k === '-' ? 'del' : 'ctx'}`}>{k}{' '}{line}{'\n'}</span>)}</pre>
    </div>
  );
}

function Question({ q }) {
  const s = useOrch();
  const [text, setText] = useState('');
  const from = s.tasks.find((x) => x.id === q.from);
  return (
    <div className="o-notice o-notice--ask" role="group" aria-label="Pregunta sin responder">
      <p className="o-notice__t">Pregunta de {from?.title}</p>
      <p>{q.body}</p>
      <p className="o-meta">La responde el coordinador; si necesita tu decisión, te la pide. Puedes adelantarla aquí.</p>
      <div className="o-reply">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Tu decisión (llega a la hija por el coordinador)" aria-label="Tu decisión" onKeyDown={(e) => { if (e.key === 'Enter') { s.reply(q.id, text); setText(''); } }} />
        <button type="button" className="btn btn--primary btn--sm" disabled={!text.trim()} onClick={() => { s.reply(q.id, text); setText(''); }}>Responder</button>
      </div>
    </div>
  );
}

export function OrchTaskView() {
  const s = useOrch();
  const t = s.tasks.find((x) => x.id === s.sel);
  const [tab, setTab] = useState('actividad');
  const [followUp, setFollowUp] = useState('');
  useEffect(() => { if (t) setTab(t.parent && ['running', 'awaiting_terminal_approval', 'starting'].includes(t.status) ? 'terminal' : 'actividad'); }, [t?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!t) return <div className="o-view"><Empty>Elige un agente del árbol para ver su trabajo.</Empty></div>;

  const parent = s.tasks.find((x) => x.id === t.parent);
  const merged = isMerged(s, t);
  const final = isFinal(t);
  const qs = unansweredQuestions(s).filter((q) => q.from === t.id);
  const rv = reviewStatus(s, t);

  let primary = null;
  if (canIntegrate(s, t)) primary = <button type="button" className="btn btn--accent" onClick={() => s.openDialog({ kind: 'integrate', taskId: t.id })}>Integrar</button>;
  else if (canReview(s, t) && rv !== 'rejected') primary = <button type="button" className="btn btn--accent" onClick={() => s.openDialog({ kind: 'review', taskId: t.id })}>{rv === 'stale' ? 'Revisar de nuevo' : 'Revisar diff'}</button>;
  else if (t.status === 'exited' || t.status === 'failed') primary = <button type="button" className="btn btn--primary" onClick={() => s.relaunch(t.id)}>Relanzar · intento {t.attempt + 1}</button>;
  else if (isAwaiting(t)) primary = <button type="button" className="btn btn--accent" onClick={() => setTab('terminal')}>Ir a la terminal</button>;

  return (
    <div className="o-view">
      <header className="o-thead">
        <StatusMark s={s} t={t} size={20} />
        <div className="o-thead__text">
          <h1>{t.parent ? t.title : 'Coordinador'}</h1>
          <p className="o-thead__meta">
            <span className={`o-state o-state--${t.status}`}>{stateText(s, t, merged)} · {t.status === 'blocked' ? 'sin arrancar' : clock(t.min)}</span>
            <span className="mono">{t.id}</span>
            {t.role && <span>{roleName(t.role)}</span>}
            <AgentChip agent={t.agent} model={t.model} effort={t.effort} size={14} />
            <span>{parent ? `hija de Coordinador` : 'coordina este run'}</span>
            {t.branch && <span className="o-chip o-chip--mono"><I n="branch" size={11} />{t.branch}</span>}
            {t.attempt > 1 && <span className="o-chip" title="Cada lanzamiento crea un intento con su propia identidad (Plan · Fase 2)">Intento {t.attempt}</span>}
            {!final && <Liveness live={t.live} />}
          </p>
        </div>
        <div className="o-thead__actions">
          {primary}
          {!final && t.parent && t.status !== 'blocked' && <button type="button" className="btn btn--ghost" title="Solo para emergencias: el coordinador recibe el aviso" onClick={() => s.openDialog({ kind: 'stop', taskId: t.id })}>Detener</button>}
          {merged && <span className="o-badge o-badge--good" title={s.integrated[t.id].commit}>Fusionada · <span className="mono">{s.integrated[t.id].commit}</span></span>}
        </div>
      </header>

      {t.status === 'blocked' && (
        <div className="o-notice o-notice--plan" role="note">
          <p className="o-notice__t">Bloqueada hasta que termine {t.deps.join(', ')} <PlanTag phase="Fase 2" /></p>
          <p>Se lanzó con <span className="mono">lxo spawn --after {t.deps.join(',')}</span>. El host la arranca cuando sus dependencias terminan con éxito y detecta ciclos al crearla.</p>
        </div>
      )}
      {isAwaiting(t) && (
        <div className="o-notice o-notice--warn" role="alert">
          <p className="o-notice__t">Esperando aprobación en la terminal · vence en {t.approval.deadlineMin} min</p>
          <p>Ve a la terminal del agente para aprobar o rechazar. <span className="mono">{t.approval.command}</span></p>
        </div>
      )}
      {qs.map((q) => <Question key={q.id} q={q} />)}
      {t.status === 'done' && t.role === 'adversario' && (
        <div className="o-notice" role="note">
          <p className="o-notice__t">Réplica del adversario · ronda 1 de 2</p>
          <p>t5 respondió a los tres hallazgos. Lo que siga sin resolverse tras la segunda ronda se te cuenta, no se oculta.</p>
        </div>
      )}

      <div className="o-tabs">
        <Seg value={tab} onChange={setTab} label="Vista de la tarea" options={[
          ...(t.parent ? [{ id: 'terminal', label: 'Terminal' }] : []), { id: 'actividad', label: 'Actividad', count: s.messages.filter((m) => m.from === t.id || m.to === t.id).length || undefined },
          ...(t.branch ? [{ id: 'cambios', label: 'Cambios', count: t.diff?.length }] : []),
        ]} />
        {t.worktree && <span className="o-meta mono o-path" title={t.worktree}>{t.worktree}</span>}
      </div>

      <div className="o-body">
        {tab === 'terminal' && <Terminal t={t} />}
        {tab === 'actividad' && <Activity t={t} />}
        {tab === 'cambios' && <Changes t={t} />}
      </div>

      {t.status === 'done' && t.parent && !merged && (
        <footer className="o-follow">
          <input value={followUp} onChange={(e) => setFollowUp(e.target.value)} placeholder="Pídele al coordinador una corrección (la lanza con lxo continue · máx. 2 vueltas)" aria-label="Corrección para la hija, vía coordinador" />
          <button type="button" className="btn btn--ghost btn--sm" disabled={!followUp.trim()} onClick={() => { s.continueTask(t.id, followUp); setFollowUp(''); }}>Pedir corrección</button>
        </footer>
      )}
    </div>
  );
}
