// AttentionCard.jsx — tarjeta de una Attention con sus acciones.
// Recibe la vista ya unida (buildAttentionViews): item + proyecto + task + intento. No calcula nada de
// dominio: el kind, el motivo y la entidad vienen del cliente; las acciones, de domain-view/attentionActions.
import { useState } from 'react';
import { attentionHint } from '../domain-view/attentionText';
import { attentionActions } from '../domain-view/attentionActions';
import { formatAgo, countdown } from '../domain-view/format';
import { routeForAttention } from '../navigation/routes';
import { ActionButton } from './ActionButton';
import { NavButton, NavLink } from './NavLink';
import { StatusPill } from './StatusMark';
import { AgentLabel } from './AgentLabel';
import { PolicySummary } from './PolicySummary';
import { InlineAnswer } from './InlineAnswer';

/** @param {{view: object, now: number, compact?: boolean}} props */
export function AttentionCard({ view, now, compact = false }) {
  const { item, kindInfo, project, attempt } = view;
  const [respondiendo, setRespondiendo] = useState(false);
  const acciones = attentionActions(view);
  const hint = attentionHint(view);
  const vence = item.dueAt ? countdown(item.dueAt, now) : '';

  return (
    <article className={`ade-attn ade-attn--${item.kind} ${compact ? 'is-compact' : ''} ${item.person?.seen ? 'is-seen' : ''}`} data-kind={item.kind} data-testid={`attention-${item.id}`} aria-label={`${kindInfo.title}: ${item.subject}`}>
      <header className="ade-attn__head">
        <span className="ade-attn__kind">
          {kindInfo.title}
          {kindInfo.estado === 'reservado' && <span className="ade-tag" title="Kind reservado: el slice G decide si es un kind de Attention.">reservado</span>}
        </span>
        <time className="ade-attn__time">{formatAgo(item.createdAt, now)}</time>
      </header>

      <h3 className="ade-attn__title"><NavLink route={routeForAttention(item)}>{item.subject}</NavLink></h3>
      <div className="ade-attn__where">
        {project && <span className="ade-attn__project">{project.name}</span>}
        {attempt && <span>Intento {attempt.ordinal}</span>}
        {attempt && <AgentLabel agent={attempt.agent} />}
        {attempt && <StatusPill state={attempt.state} />}
      </div>

      <p className="ade-attn__hint">{hint}{vence && <span className="ade-attn__due"> · {vence}</span>}</p>
      {item.kind === 'pending_spawn' && attempt && !compact && <PolicySummary policy={attempt.policy} />}

      <footer className="ade-attn__actions">
        {acciones.map((a) => {
          const variant = a.primary ? 'primary' : 'ghost';
          if (a.tipo === 'nav') return <NavButton key={a.id} route={a.route} variant={variant}>{a.label}</NavButton>;
          if (a.tipo === 'inline') {
            return <ActionButton key={a.id} intent={a.intent} label={respondiendo ? 'Cancelar' : a.label} variant={variant} onClick={() => setRespondiendo((v) => !v)} />;
          }
          return <ActionButton key={a.id} intent={a.intent} args={a.args} label={a.label} variant={variant} />;
        })}
      </footer>
      {respondiendo && <InlineAnswer attemptId={item.attemptId} onDone={() => setRespondiendo(false)} />}
    </article>
  );
}
