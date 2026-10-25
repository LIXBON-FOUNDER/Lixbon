// OrchTree.jsx — navegador de la izquierda: lo que espera a una persona, el run activo con su coordinador y sus hijas,
// y el historial de runs cerrados. Orden estable: un evento de fondo nunca cambia la selección.
import React, { useState } from 'react';
import { useOrch, attentionItems, fleetCounts, unansweredQuestions, isAwaiting, isMerged, isFinal } from './orchStore';
import { RUN, CLOSED_RUNS, PROJECT } from './orchData';
import { StatusMark, AgentChip, roleName, clock, money, I } from './orchUi';

const KIND_LABEL = { approve: 'Aprobar en terminal', spawn: 'Lanzamiento', question: 'Pregunta', integrate: 'Integrar', review: 'Revisar', failed: 'Falló' };

function AttentionList({ items }) {
  const [all, setAll] = useState(false);
  const select = useOrch((s) => s.select);
  const openDialog = useOrch((s) => s.openDialog);
  const sel = useOrch((s) => s.sel);
  if (!items.length) return null;
  const go = (it) => {
    if (it.kind === 'spawn') select(it.pendingId);
    else if (it.kind === 'review') { select(it.taskId); openDialog({ kind: 'review', taskId: it.taskId }); }
    else if (it.kind === 'integrate') { select(it.taskId); openDialog({ kind: 'integrate', taskId: it.taskId }); }
    else select(it.taskId);
  };
  return (
    <section className="o-attn" aria-label="Esperan tu decisión">
      <header className="o-sec-h"><h2>Esperan tu decisión</h2><span className="o-count" title={`${items.length} acciones tuyas pendientes`}>{items.length}</span></header>
      <ul>
        {(all ? items : items.slice(0, 4)).map((it) => (
          <li key={it.key}>
            <button type="button" className={`o-attn__row ${sel === (it.pendingId || it.taskId) ? 'is-sel' : ''}`} onClick={() => go(it)}>
              <span className="o-attn__title">{it.title}</span>
              <span className="o-attn__hint"><b>{KIND_LABEL[it.kind]}</b> · {it.hint}</span>
            </button>
          </li>
        ))}
      </ul>
      {items.length > 4 && <button type="button" className="o-more" onClick={() => setAll((v) => !v)}>{all ? 'Ver menos' : `Ver ${items.length - 4} más`}</button>}
    </section>
  );
}

function TaskRow({ t, depth }) {
  const s = useOrch();
  const asking = unansweredQuestions(s).some((q) => q.from === t.id);
  const merged = isMerged(s, t);
  const phase = t.phases[t.phases.length - 1];
  const final = isFinal(t);
  const note = final ? (t.status === 'exited' || t.status === 'failed' ? t.failure : t.summary?.replace(/`/g, '').split('.')[0]) : t.status === 'blocked' ? `Espera a ${t.deps.join(', ')} (--after)` : phase ? `${phase.name}${phase.note ? ' · ' + phase.note.replace(/`/g, '') : ''}` : null;
  return (
    <li>
      <button type="button" className={`o-row ${s.sel === t.id ? 'is-sel' : ''} o-row--${t.status}`} style={{ '--d': depth }} onClick={() => s.select(t.id)} aria-current={s.sel === t.id ? 'true' : undefined}>
        <StatusMark s={s} t={t} size={14} />
        <span className="o-row__main">
          <span className="o-row__title">{t.title}</span>
          <span className="o-row__meta">
            {t.role ? `${roleName(t.role)} · ` : ''}<AgentChip agent={t.agent} model={t.model} effort={t.effort} size={12} hideEffort />
          </span>
          {note && <span className="o-row__note" title={note}>{note}</span>}
        </span>
        <span className="o-row__end">
          {asking && <span className="o-badge o-badge--ask" title="Tiene una pregunta sin responder">?</span>}
          {isAwaiting(t) && <span className="o-badge o-badge--warn" title="Espera tu aprobación en su terminal">!</span>}
          {merged && <span className="o-badge" title="Fusionada en la rama del coordinador">fusionada</span>}
          {t.attempt > 1 && <span className="o-badge" title={`Intento ${t.attempt}: un reintento no reutiliza identidad (Plan · Fase 2)`}>int. {t.attempt}</span>}
          <span className="o-row__time">{t.status === 'blocked' ? '—' : clock(t.min)}</span>
        </span>
      </button>
    </li>
  );
}

export function OrchTree() {
  const s = useOrch();
  const [closedOpen, setClosedOpen] = useState(false);
  const items = attentionItems(s);
  const f = fleetCounts(s);
  const coord = s.tasks.find((t) => !t.parent);
  const kids = s.tasks.filter((t) => t.parent);
  const pctCost = Math.min(100, (f.cost / RUN.budget.cost) * 100);
  return (
    <aside className="o-tree" aria-label="Runs y agentes">
      <div className="o-tree__scroll">
        <AttentionList items={items} />

        <section aria-label="Run activo">
          <header className="o-sec-h"><h2>Run activo</h2><span className="o-meta">{PROJECT.name}</span></header>
          <button type="button" className={`o-run ${s.sel === coord.id ? 'is-sel' : ''}`} onClick={() => s.select(coord.id)} aria-current={s.sel === coord.id ? 'true' : undefined}>
            <span className="o-run__top"><span className="o-chip o-chip--mono">{RUN.issue}</span><span className="o-meta">{f.done}/{f.total} terminadas</span></span>
            <span className="o-run__title">{RUN.title}</span>
            <span className="o-bar" aria-hidden="true"><i style={{ width: `${(f.done / f.total) * 100}%` }} /></span>
          </button>
          <ul className="o-list">
            <TaskRow t={coord} depth={0} />
            {kids.map((t) => <TaskRow key={t.id} t={t} depth={1} />)}
          </ul>
        </section>

        <section aria-label="Runs cerrados">
          <button type="button" className="o-fold" aria-expanded={closedOpen} onClick={() => setClosedOpen((v) => !v)}>
            <I n={closedOpen ? 'down' : 'right'} size={12} /> Runs cerrados <span className="o-meta">{CLOSED_RUNS.length}</span>
          </button>
          {closedOpen && (
            <ul className="o-closed">
              {CLOSED_RUNS.map((r) => (
                <li key={r.id}>
                  <span className="o-closed__title">{r.title}</span>
                  <span className="o-meta">{r.issue} · {r.merged}/{r.tasks} fusionadas · {r.ago} · {money(r.cost)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <footer className="o-tree__foot" aria-label="Presupuesto del run">
        <div className="o-budget">
          <span>{money(f.cost)} <span className="o-meta">de {money(RUN.budget.cost)}</span></span>
          <span className="o-meta">{f.live} de {RUN.budget.parallel} en paralelo</span>
        </div>
        <span className="o-bar o-bar--thin" aria-hidden="true"><i style={{ width: `${pctCost}%` }} /></span>
      </footer>
    </aside>
  );
}
