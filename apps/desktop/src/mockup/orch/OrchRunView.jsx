// OrchRunView.jsx — el run visto desde su coordinador. Responde una pregunta: ¿qué necesita de mí el equipo y qué está listo?
// Elemento propio del Orquestador: el reparto del run como carriles por hija, con sus dependencias (`--after`).
import React from 'react';
import { useOrch, fleetCounts, attentionItems, canIntegrate, canReview, isMerged, reviewStatus, STATUS_LABEL } from './orchStore';
import { RUN, LANES, COORD_LOG, PROJECT } from './orchData';
import { AgentChip, PlanTag, StatusMark, roleName, money, I } from './orchUi';

const AXIS = 42; // minutos que cubre el eje (41 de run + 1 de margen)
const pos = (agoMin) => `${((AXIS - agoMin) / AXIS) * 100}%`;

function Lanes() {
  const s = useOrch();
  const order = ['c1', 't1', 't7', 't2', 't5', 't3', 't6', 't4'];
  const ticks = [40, 30, 20, 10, 0];
  return (
    <section className="o-card o-lanes" aria-label="Reparto del run">
      <header className="o-card__h">
        <h2>Reparto del run</h2>
        <span className="o-meta">Cada carril es una hija; la línea punteada es una dependencia <PlanTag phase="Fase 2" /></span>
      </header>
      <div className="o-lanes__grid" role="list">
        <div className="o-lanes__axis" aria-hidden="true">
          {ticks.map((m) => <span key={m} style={{ left: pos(m) }}>{m === 0 ? 'ahora' : `−${m} min`}</span>)}
        </div>
        {order.map((id) => {
          const t = s.tasks.find((x) => x.id === id);
          const lane = LANES[id];
          if (!t || !lane) return null;
          const blocked = t.status === 'blocked';
          const start = lane.start ?? 0;
          const end = lane.end ?? 0;
          const left = pos(start);
          const width = `${((start - end) / AXIS) * 100}%`;
          const dep = lane.after ? LANES[lane.after] : null;
          return (
            <button key={id} type="button" role="listitem" className={`o-lane ${s.sel === id ? 'is-sel' : ''}`} onClick={() => s.select(id)} title={`${t.title} · ${STATUS_LABEL[t.status]}`}>
              <span className="o-lane__label">
                <StatusMark s={s} t={t} size={12} />
                <span className="o-lane__name">{t.parent ? t.title : 'Coordinador'}</span>
                <span className="o-lane__role">{t.role ? roleName(t.role) : ''}</span>
              </span>
              <span className="o-lane__track">
                {ticks.map((m) => <i key={m} className="o-lane__grid" style={{ left: pos(m) }} />)}
                {!blocked && <span className={`o-bar-lane o-bar-lane--${t.status} ${t.parent ? '' : 'is-coord'}`} style={{ left, width }} />}
                {blocked && dep && <span className="o-bar-lane o-bar-lane--blocked" style={{ left: '90%', width: '10%' }} />}
                {blocked && <span className="o-lane__after" style={{ right: '11%' }}>espera a {lane.after}</span>}
                {t.phases.filter((p) => p.done && !blocked).slice(0, 5).map((p, i) => <i key={i} className="o-lane__tick" style={{ left: pos(p.ago) }} title={p.name} />)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Integration() {
  const s = useOrch();
  const items = s.tasks.filter((t) => t.parent && t.branch && t.status === 'done');
  const pending = s.tasks.filter((t) => t.parent && t.branch && ['running', 'awaiting_terminal_approval', 'blocked', 'starting'].includes(t.status));
  return (
    <section className="o-card" aria-label="Integración propuesta">
      <header className="o-card__h"><h2>Integración propuesta</h2><span className="o-meta">Solo tú integras · destino <span className="mono">{PROJECT.coordBranch}</span></span></header>
      <ol className="o-int">
        {items.map((t, i) => {
          const merged = isMerged(s, t);
          const rv = reviewStatus(s, t);
          return (
            <li key={t.id}>
              <span className="o-int__n">{i + 1}.</span>
              <span className="o-int__main">
                <button type="button" className="o-link" onClick={() => s.select(t.id)}>{t.title}</button>
                <span className="o-meta mono">{t.branch} · {t.head}</span>
                <span className="o-meta">{t.tests ? `${t.tests.pass}/${t.tests.total} pruebas · ` : ''}{merged ? `fusionada en ${s.integrated[t.id].commit}` : rv === 'accepted' ? 'diff aceptado' : rv === 'stale' ? 'la rama cambió tras tu revisión' : rv === 'rejected' ? 'diff rechazado' : 'sin revisar'}</span>
              </span>
              {!merged && canIntegrate(s, t) && <button type="button" className="btn btn--accent btn--sm" onClick={() => s.openDialog({ kind: 'integrate', taskId: t.id })}>Integrar</button>}
              {!merged && !canIntegrate(s, t) && canReview(s, t) && rv !== 'rejected' && <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.openDialog({ kind: 'review', taskId: t.id })}>Revisar diff</button>}
              {merged && <span className="o-badge o-badge--good">fusionada</span>}
            </li>
          );
        })}
        {pending.map((t) => (
          <li key={t.id} className="is-later">
            <span className="o-int__n">·</span>
            <span className="o-int__main">
              <button type="button" className="o-link" onClick={() => s.select(t.id)}>{t.title}</button>
              <span className="o-meta">{STATUS_LABEL[t.status]}{t.deps?.length ? ` · espera a ${t.deps.join(', ')}` : ''} · entra cuando termine</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function CoordLog() {
  return (
    <section className="o-card" aria-label="Lo que hizo el coordinador">
      <header className="o-card__h"><h2>Lo que hizo el coordinador</h2><span className="o-meta">Un comando <span className="mono">lxo</span> por llamada</span></header>
      <ul className="o-log">
        {[COORD_LOG[0], ...COORD_LOG.slice(-6)].map(([k, when, text], i) => (
          <li key={i} className={`o-log__${k}`}>
            <span className="o-meta o-log__when">{when}</span>
            {k === 'cmd' ? <code className="mono">{text}</code> : <span>{text}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function OrchRunView() {
  const s = useOrch();
  const f = fleetCounts(s);
  const att = attentionItems(s);
  const by = (k) => att.filter((i) => i.kind === k).length;
  const ready = s.tasks.filter((t) => canIntegrate(s, t)).length;
  const toReview = s.tasks.filter((t) => canReview(s, t) && !canIntegrate(s, t) && reviewStatus(s, t) !== 'rejected').length;
  const finding = [
    by('approve') ? `${by('approve')} aprobación en terminal` : null,
    by('spawn') ? `${by('spawn')} ${by('spawn') === 1 ? 'lanzamiento' : 'lanzamientos'}` : null,
    by('question') ? `${by('question')} ${by('question') === 1 ? 'pregunta' : 'preguntas'}` : null,
    by('failed') ? `${by('failed')} cerrada sin entregar` : null,
  ].filter(Boolean);
  return (
    <div className="o-view">
      <header className="o-title">
        <div>
          <h1>{RUN.title}</h1>
          <p className="o-title__sub">
            {finding.length ? <>Esperan tu decisión: <b>{finding.join(' · ')}</b>.</> : 'Ninguna decisión tuya pendiente.'}{' '}
            {ready ? `${ready} ${ready === 1 ? 'rama lista' : 'ramas listas'} para integrar.` : toReview ? `${toReview} por revisar antes de integrar.` : ''}
          </p>
        </div>
        <span className="o-chip o-chip--mono" title="Issue de Lixbon Team vinculada al run">{RUN.issue}</span>
      </header>

      <dl className="o-kpis" aria-label="Estado del run">
        <div><dt>Hijas terminadas</dt><dd>{f.done}<span> /{f.total}</span></dd></div>
        <div><dt>En marcha</dt><dd>{f.working}<span> agentes</span></dd></div>
        <div><dt>Esperan tu decisión</dt><dd className={f.attention ? 'is-warn' : ''}>{f.attention}</dd></div>
        <div><dt>Coste del run</dt><dd>{money(f.cost)}<span> de {money(RUN.budget.cost)}</span></dd></div>
        <div><dt>Paralelo</dt><dd>{f.live}<span> de {RUN.budget.parallel} <PlanTag phase="Fase 5">tope</PlanTag></span></dd></div>
      </dl>

      <Lanes />
      <div className="o-two">
        <Integration />
        <CoordLog />
      </div>
    </div>
  );
}
