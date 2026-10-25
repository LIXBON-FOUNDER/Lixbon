// AttentionCard.jsx — una decisión humana, con todo el contexto para decidir (Task, Attempt, agente, host, comando, riesgo, alcance).
// Se reutiliza en el Inbox del ADE, en el banner del Task Workspace, en el IDE y (con otra piel) en Mobile.
import { useState } from 'react';
import { useStore, attemptById, taskOf } from '../store';
import { KIND_META, agentShort, hostOf } from '../vocab';
import { I, RiskTag, Loc } from '../ui';

const KIND_TONE = { permission: 'warn', question: 'warn', review: 'merged', failed: 'danger', conflict: 'danger', host: 'faint', security: 'danger' };

export function DecisionButtons({ item, from = 'ADE', block = false, size = 'sm' }) {
  const s = useStore();
  const [answer, setAnswer] = useState('');
  const cls = `btn btn--${size === 'lg' ? 'lg' : 'sm'} ${block ? 'btn--block' : ''}`;
  const a = attemptById(s, item.attemptId);
  const go = (view) => s.select(item.attemptId, view);

  if (item.kind === 'permission') {
    return (
      <div className={`dec ${block ? 'dec--block' : ''}`}>
        <button type="button" className={`${cls} btn--danger`} onClick={() => s.resolveAttention(item.id, 'deny', { from })}>Deny</button>
        <button type="button" className={`${cls} btn--ghost`} onClick={() => s.resolveAttention(item.id, 'allow_once', { from })}>Allow once</button>
        {item.risk !== 'high'
          ? <button type="button" className={`${cls} btn--accent`} onClick={() => s.resolveAttention(item.id, 'allow_attempt', { from })}>Allow for this Attempt</button>
          : <span className="muted dec__note">High risk: no “always” option. Review the command first.</span>}
      </div>
    );
  }
  if (item.kind === 'question') {
    return (
      <div className="dec dec--col">
        <div className="dec">
          {(item.options || []).map((o) => <button key={o} type="button" className={`${cls} btn--ghost`} onClick={() => s.resolveAttention(item.id, 'answer', { from, answer: o })}>{o}</button>)}
        </div>
        <div className="dec">
          <input className="input grow" placeholder="Or answer in your own words…" value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && answer.trim() && s.resolveAttention(item.id, 'answer', { from, answer: answer.trim() })} aria-label="Answer" />
          <button type="button" className={`${cls} btn--accent`} disabled={!answer.trim()} onClick={() => s.resolveAttention(item.id, 'answer', { from, answer: answer.trim() })}>Send</button>
        </div>
      </div>
    );
  }
  if (item.kind === 'review') {
    return (
      <div className="dec">
        <button type="button" className={`${cls} btn--merged`} onClick={() => go('proof')}><I n="eye" size={12} />Open Proof Pack</button>
        <button type="button" className={`${cls} btn--ghost`} onClick={() => go('review')}>Review changes</button>
        <button type="button" className={`${cls} btn--text`} onClick={() => s.resolveAttention(item.id, 'snooze', { from })}>Snooze</button>
      </div>
    );
  }
  if (item.kind === 'failed') {
    return (
      <div className="dec">
        <button type="button" className={`${cls} btn--accent`} onClick={() => s.resolveAttention(item.id, 'retry', { from })}>Retry from checkpoint</button>
        <button type="button" className={`${cls} btn--ghost`} onClick={() => go('workspace')}>View Attempt</button>
        <button type="button" className={`${cls} btn--ghost`} onClick={() => s.openFork(item.attemptId)}>Fork to another agent</button>
      </div>
    );
  }
  if (item.kind === 'conflict') {
    return (
      <div className="dec">
        <button type="button" className={`${cls} btn--accent`} onClick={() => { s.select(item.attemptId); s.setSurface('ide'); }}>Resolve in IDE</button>
        <button type="button" className={`${cls} btn--ghost`} onClick={() => go('review')}>View conflicts</button>
        <button type="button" className={`${cls} btn--text`} onClick={() => s.resolveAttention(item.id, 'snooze', { from })}>Snooze</button>
      </div>
    );
  }
  return (
    <div className="dec">
      <button type="button" className={`${cls} btn--ghost`} onClick={() => { s.toast('Re-routing to Desktop-PC… (simulated). A new Attempt would start from the same ContextPackage.'); }}>Run on Desktop-PC instead</button>
      <button type="button" className={`${cls} btn--text`} onClick={() => s.resolveAttention(item.id, 'snooze', { from })}>Snooze</button>
      {a && <button type="button" className={`${cls} btn--text`} onClick={() => s.toggleHost(a.host)}><span className="dbadge">sim</span> Reconnect host</button>}
    </div>
  );
}

export default function AttentionCard({ item, selectable, selected, onSelect, compact, detail }) {
  const s = useStore();
  const a = attemptById(s, item.attemptId);
  const task = a && taskOf(s, a);
  const tone = KIND_TONE[item.kind] || 'warn';
  return (
    <article className={`attn attn--${tone} ${compact ? 'attn--compact' : ''} ${detail ? 'attn--detail' : ''}`} aria-label={item.title}>
      <header className="attn__h">
        {selectable && <input type="checkbox" checked={!!selected} onChange={() => onSelect(item.id)} aria-label={`Select ${item.title}`} />}
        <span className={`attn__k mk-tone-${tone}`}><I n={KIND_META[item.kind]?.icon || 'warn'} size={13} />{KIND_META[item.kind]?.label}</span>
        <RiskTag risk={item.risk} />
        <span className="sp" />
        <span className="muted">{item.ago}</span>
      </header>
      <div className="attn__t">{item.title}</div>
      {a && (
        <div className="attn__ctx">
          <button type="button" className="attn__link" onClick={() => s.select(a.id)}>{task.title} · Attempt {a.label}</button>
          <span className="muted">{agentShort(a)}</span>
          <Loc attempt={a} parts={['host']} forceHost compact />
        </div>
      )}
      {item.command && (
        <div className="attn__cmd">
          <code>{item.command}</code>
          <div className="attn__facts">
            <span><b>Risk</b> {item.riskLabel}</span>
            {item.reason && <span><b>Reason</b> {item.reason}</span>}
            <span><b>Scope if allowed</b> {item.scope}</span>
            <span><b>Policy</b> {a?.policy} → Ask zone</span>
          </div>
        </div>
      )}
      {item.question && <p className="attn__q">{item.question}</p>}
      {item.summary && <p className="attn__s">{item.summary}</p>}
      <DecisionButtons item={item} />
    </article>
  );
}
