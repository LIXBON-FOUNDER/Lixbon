// PreviewAttention.jsx — «¿qué necesita de mí ahora?». Lista de solicitudes + detalle de la elegida.
// El detalle trae lo necesario para decidir sin saltar de pantalla: qué alcanza la orden, qué hizo el
// agente justo antes y qué decidiste en casos parecidos. Teclado: J/K o ↑/↓ recorren; A permite una vez; D deniega.
// Activity (telemetría) va aparte, debajo de la lista, y no pide nada.
import { useEffect, useRef, useState } from 'react';
import { usePreviewStore, attemptById, taskOf } from './previewStore';
import { I, RiskTag, Loc, Agent, SimBadge } from './PreviewUi';
import { KIND_META, attemptName } from './previewVocab';

const GROUPS = [
  { id: 'block', title: 'Bloquean a un agente', kinds: ['permission', 'question'], hint: 'El agente no puede seguir hasta que respondas.' },
  { id: 'review', title: 'Listos para tu revisión', kinds: ['review'], hint: 'Primero la evidencia, después el diff.' },
  { id: 'problems', title: 'Problemas', kinds: ['failed', 'conflict', 'host'], hint: 'Algo se rompió o no se alcanza.' },
];
const RISK_ORDER = { high: 0, medium: 1, low: 2, none: 3 };

export function DecisionButtons({ item, from = 'ADE' }) {
  const s = usePreviewStore();
  const [answer, setAnswer] = useState('');
  const a = attemptById(s, item.attemptId);
  const go = (view) => s.select(item.attemptId, view);
  const resolve = (decision, extra) => s.resolveAttention(item.id, decision, { from, ...extra });

  if (item.kind === 'permission') {
    return (
      <div className="pv-decide">
        <button type="button" className="btn btn--sm pv-btn--danger" onClick={() => resolve('deny')}>Denegar <kbd>D</kbd></button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => resolve('allow_once')}>Permitir una vez <kbd>A</kbd></button>
        {item.risk !== 'high'
          ? <button type="button" className="btn btn--accent btn--sm" onClick={() => resolve('allow_attempt')}>Permitir en este Intento</button>
          : <span className="pv-muted">Riesgo alto: sin opción «siempre». Lee la orden antes.</span>}
      </div>
    );
  }
  if (item.kind === 'question') {
    const send = () => answer.trim() && resolve('answer', { answer: answer.trim() });
    return (
      <div className="pv-decide pv-decide--col">
        <div className="pv-decide">
          {(item.options || []).map((o) => <button key={o} type="button" className="btn btn--ghost btn--sm" onClick={() => resolve('answer', { answer: o })}>{o}</button>)}
        </div>
        <div className="pv-decide">
          <input className="pv-input" placeholder="O responde con tus palabras…" value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} aria-label="Respuesta" />
          <button type="button" className="btn btn--accent btn--sm" disabled={!answer.trim()} onClick={send}>Enviar</button>
        </div>
      </div>
    );
  }
  if (item.kind === 'review') {
    return (
      <div className="pv-decide">
        <button type="button" className="btn btn--accent btn--sm" onClick={() => go('proof')}><I n="eye" size={12} />Abrir el Proof Pack</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => go('review')}>Revisar los cambios</button>
        <button type="button" className="lk" onClick={() => resolve('snooze')}>Posponer</button>
      </div>
    );
  }
  if (item.kind === 'failed') {
    return (
      <div className="pv-decide">
        <button type="button" className="btn btn--accent btn--sm" onClick={() => resolve('retry')}>Reintentar desde el checkpoint</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => go('workspace')}>Ver el Intento</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.openFork(item.attemptId)}>Probar con otro agente</button>
      </div>
    );
  }
  if (item.kind === 'conflict') {
    return (
      <div className="pv-decide">
        <button type="button" className="btn btn--accent btn--sm" onClick={() => go('review')}>Ver los conflictos</button>
        <button type="button" className="lk" onClick={() => resolve('snooze')}>Posponer</button>
      </div>
    );
  }
  return (
    <div className="pv-decide">
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.toast('Mover a Desktop-PC (simulado): un Intento nuevo arrancaría desde el mismo ContextPackage.')}>Ejecutar en Desktop-PC</button>
      <button type="button" className="lk" onClick={() => resolve('snooze')}>Posponer</button>
      {a && <button type="button" className="lk" onClick={() => s.toggleHost(a.host)}><SimBadge /> Reconectar el host</button>}
    </div>
  );
}

export function AttentionCard({ item, compact = false, detail = false }) {
  const s = usePreviewStore();
  const a = attemptById(s, item.attemptId);
  const task = a && taskOf(s, a);
  const km = KIND_META[item.kind] || KIND_META.permission;
  return (
    <article className={`pv-card pv-card--${km.tone}${compact ? ' pv-card--compact' : ''}${detail ? ' pv-card--detail' : ''}`} aria-label={item.title}>
      <header className="pv-card__head">
        <span className={`pv-card__kind pv-tone-${km.tone}`}><I n={km.icon} size={13} />{km.label}</span>
        <RiskTag risk={item.risk} />
        <span className="panelhead__fill" />
        <span className="pv-muted">{item.ago}</span>
      </header>
      <div className="pv-card__title">{item.title}</div>
      {a && !compact && (
        <div className="pv-card__ctx">
          <button type="button" className="lk is-accent" onClick={() => s.select(a.id)}>{task.title} · {attemptName(a)}</button>
          <Agent attempt={a} detail={false} />
          <Loc attempt={a} parts={['host']} forceHost />
        </div>
      )}
      {item.command && (
        <div className="pv-card__cmd">
          <code className="mono">{item.command}</code>
          {!compact && (
            <dl className="pv-card__facts">
              <div><dt>Riesgo</dt><dd>{item.riskLabel}</dd></div>
              {item.reason && <div><dt>Motivo</dt><dd>{item.reason}</dd></div>}
              <div><dt>Alcance si lo permites</dt><dd>{item.scope}</dd></div>
              <div><dt>Perfil</dt><dd>{a ? 'Fuera de lo permitido: pregunta' : '—'}</dd></div>
            </dl>
          )}
        </div>
      )}
      {item.question && <p className="pv-card__q">{item.question}</p>}
      {item.summary && <p className="pv-card__s">{item.summary}</p>}
      <DecisionButtons item={item} />
    </article>
  );
}

/** Lo que hace falta para decidir sin salir de aquí. */
function DecisionContext({ item }) {
  const s = usePreviewStore();
  const mine = s.decisions.filter((d) => d.command && d.command === item.command);
  const similar = [...(item.similar || []), ...mine.map((d) => ({ text: `${d.decision === 'deny' ? 'Denegaste' : 'Permitiste'} esta misma orden`, ago: `hoy ${d.time}`, verdict: d.decision === 'deny' ? 'deny' : 'allow' }))];
  if (!item.touches && !item.before && !similar.length) return null;
  return (
    <div className="pv-ctx">
      {item.touches && (
        <section>
          <h3 className="ssec__label">Qué alcanza</h3>
          <ul className="pv-ctx__list">{item.touches.map((t) => <li key={t}>{t}</li>)}</ul>
        </section>
      )}
      {item.before && (
        <section>
          <h3 className="ssec__label">Justo antes, el agente</h3>
          <ol className="pv-ctx__steps">{item.before.map((t) => <li key={t}>{t}</li>)}</ol>
        </section>
      )}
      {similar.length > 0 && (
        <section>
          <h3 className="ssec__label">Decisiones parecidas</h3>
          <ul className="pv-ctx__list">
            {similar.map((d) => <li key={d.text + d.ago}><span className={d.verdict === 'deny' ? 'pv-bad' : 'pv-good'}>{d.verdict === 'deny' ? '✕' : '✓'}</span> {d.text} <span className="pv-muted">· {d.ago}</span></li>)}
          </ul>
        </section>
      )}
    </div>
  );
}

function ActivityFeed({ limit = 6 }) {
  const s = usePreviewStore();
  return (
    <section className="pv-feed" aria-label="Activity">
      <header className="pv-feed__head"><b>Activity</b><span className="pv-muted">telemetría · no te pide nada</span></header>
      <ol>
        {s.activity.slice(0, limit).map((x) => (
          <li key={x.id}>
            <button type="button" onClick={() => x.attemptId && s.select(x.attemptId)}>
              <span className={`pv-feed__dot pv-tone-${x.tone}`} /><span className="pv-feed__text">{x.text}</span><time className="mono">{x.time}</time>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function PreviewAttention() {
  const s = usePreviewStore();
  const [picked, setPicked] = useState([]);
  const [selId, setSelId] = useState(null);
  const lastIdx = useRef(0);
  const listRef = useRef(null);
  const items = s.attention;
  const groups = GROUPS.map((g) => ({ ...g, list: items.filter((x) => g.kinds.includes(x.kind)).sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk]) })).filter((g) => g.list.length);
  const flat = groups.flatMap((g) => g.list);
  // Al resolver una, se pasa a la que ocupa su lugar.
  const sel = flat.find((x) => x.id === selId) || flat[Math.min(lastIdx.current, flat.length - 1)] || null;
  useEffect(() => { if (sel) lastIdx.current = flat.findIndex((x) => x.id === sel.id); });
  const batchable = items.filter((x) => x.kind === 'permission' && x.risk === 'low');
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const approveBatch = () => {
    picked.forEach((id) => s.resolveAttention(id, 'allow_once'));
    s.toast(`Permitidas una vez ${picked.length} órdenes de riesgo bajo.`);
    setPicked([]);
  };
  const move = (dir) => {
    if (!flat.length) return;
    const i = Math.max(0, flat.findIndex((x) => x.id === sel?.id));
    const next = flat[Math.max(0, Math.min(flat.length - 1, i + dir))];
    setSelId(next.id);
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-req="${next.id}"]`)?.focus());
  };
  const onKeyDown = (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'arrowdown' || k === 'j') { e.preventDefault(); move(1); }
    else if (k === 'arrowup' || k === 'k') { e.preventDefault(); move(-1); }
    else if (sel?.kind === 'permission' && k === 'a') { e.preventDefault(); s.resolveAttention(sel.id, 'allow_once'); }
    else if (sel?.kind === 'permission' && k === 'd') { e.preventDefault(); s.resolveAttention(sel.id, 'deny'); }
  };

  return (
    <div className="pv-inbox" onKeyDown={onKeyDown}>
      <section className="pv-inbox__list" aria-label="Solicitudes">
        <header className="pv-view__head">
          <h1 className="pv-view__title">Attention</h1>
          <span className="pv-muted">{items.length ? `${items.length} ${items.length === 1 ? 'espera' : 'esperan'} una decisión` : 'Nada pendiente'}</span>
          <span className="panelhead__fill" />
          {items.some((i) => i.kind === 'host') && <button type="button" className="lk" onClick={() => items.filter((i) => i.kind === 'host').forEach((i) => s.resolveAttention(i.id, 'snooze'))}>Posponer avisos de hosts</button>}
        </header>
        {batchable.length > 1 && (
          <div className="pv-callout">
            <span><b>En lote</b> · {batchable.length} permisos de riesgo bajo del mismo tipo.</span>
            <span className="panelhead__fill" />
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPicked(batchable.map((b) => b.id))}>Elegir los de riesgo bajo</button>
            <button type="button" className="btn btn--accent btn--sm" disabled={!picked.length} onClick={approveBatch}>Permitir una vez ({picked.length})</button>
          </div>
        )}
        <div className="pv-inbox__scroll scroll" ref={listRef}>
          {!items.length && <div className="changes__empty">Nada espera tu decisión. Los agentes trabajan dentro de su contrato.</div>}
          {groups.map((g) => (
            <section key={g.id} className="pv-inbox__group">
              <h2 className="ssec__label" title={g.hint}>{g.title} <span className="count">{g.list.length}</span></h2>
              <ul>
                {g.list.map((x) => {
                  const a = attemptById(s, x.attemptId);
                  const task = a && taskOf(s, a);
                  const km = KIND_META[x.kind] || KIND_META.permission;
                  const selected = sel?.id === x.id;
                  const selectable = x.kind === 'permission' && x.risk === 'low';
                  return (
                    <li key={x.id} className={`pv-req pv-req--${km.tone}${selected ? ' is-sel' : ''}`}>
                      {selectable && <input type="checkbox" checked={picked.includes(x.id)} onChange={() => toggle(x.id)} aria-label={`Elegir ${x.title}`} />}
                      <button type="button" className="pv-req__open" data-req={x.id} aria-current={selected ? 'true' : undefined} onClick={() => setSelId(x.id)}>
                        <span className="pv-req__r1"><span className={`pv-card__kind pv-tone-${km.tone}`}><I n={km.icon} size={12} />{km.label}</span><RiskTag risk={x.risk} /><span className="panelhead__fill" /><span className="pv-muted">{x.ago}</span></span>
                        <span className="pv-req__title">{x.title}</span>
                        {a && <span className="pv-req__meta">{task.title} · {attemptName(a)}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
        <p className="pv-muted pv-inbox__foot"><I n="shield" size={12} /> Lo de alto impacto nunca va en lote. Un permiso temporal nunca se vuelve global sin que lo digas. <kbd>J</kbd>/<kbd>K</kbd> recorren · <kbd>A</kbd> permite · <kbd>D</kbd> deniega.</p>
        <ActivityFeed />
      </section>
      <section className="pv-inbox__detail scroll" aria-label="Solicitud elegida">
        {sel ? (
          <>
            <AttentionCard item={sel} detail />
            <DecisionContext item={sel} />
          </>
        ) : <div className="changes__empty">Elige una solicitud para ver su orden, su alcance y su contexto.</div>}
      </section>
    </div>
  );
}
