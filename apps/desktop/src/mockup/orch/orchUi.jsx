// orchUi.jsx — piezas pequeñas del Orquestador: marca de estado, chip de agente, etiqueta de fase del plan.
import React from 'react';
import { Mark, I } from '../ui';
import { PROVIDERS } from './orchData';
import { markOf, STATUS_LABEL } from './orchStore';

export const roleName = (r) => (r ? r[0].toUpperCase() + r.slice(1) : 'Coordinador');

/** La FORMA de la marca dice el estado; el color lo refuerza (misma taxonomía que el ADE). */
export function StatusMark({ s, t, size = 14 }) {
  const m = markOf(s, t);
  return <Mark kind={m.kind} tone={m.tone} size={size} />;
}

export function stateText(s, t, merged) {
  if (merged) return 'Integrada';
  if (t.status === 'done' && t.branch) return 'Para revisar';
  if (t.status === 'blocked' && t.deps?.length) return `Espera a ${t.deps.join(', ')}`;
  return STATUS_LABEL[t.status] || t.status;
}

/** Identidad del agente: inicial sobre un tinte pálido de su propio matiz (identidad, no dato). */
export function AgentMark({ id, size = 16 }) {
  const p = PROVIDERS[id];
  return (
    <span className="o-prov" style={{ width: size, height: size, fontSize: Math.round(size * 0.6), '--h': p?.hue ?? 0 }} aria-hidden="true">
      {p?.mark || '?'}
    </span>
  );
}

/** Agente · modelo · esfuerzo: lo que el rol fijó, a la vista en cada fila y cabecera. */
export function AgentChip({ agent, model, effort, size = 14, hideEffort = false }) {
  const p = PROVIDERS[agent];
  return (
    <span className="o-agent" title={`${p?.label || agent} · ${model}${effort ? ` · esfuerzo ${effort}` : ''}`}>
      <AgentMark id={agent} size={size + 2} />
      <span>{model}</span>
      {effort && !hideEffort && <span className="o-agent__e">{effort}</span>}
    </span>
  );
}

/** Marca de lo que aún no existe en el producto: se dice, no se disimula. */
export function PlanTag({ phase, children }) {
  return <span className="o-plan" title={`Propuesto en docs/PLAN_ORQUESTADOR.md · ${phase}`}>{children || 'Plan'} · {phase}</span>;
}

export const VERDICT = {
  live: { label: 'Vivo', tone: 'good' },
  unverifiable: { label: 'Sin verificar', tone: 'warn' },
  exited: { label: 'Cerrado', tone: 'muted' },
};

/** Vivacidad = proceso + latido + salida (Plan · Fase 2). Perder contacto nunca produce «cerrado». */
export function Liveness({ live, compact }) {
  if (!live) return null;
  const v = VERDICT[live.verdict];
  const hb = live.hb == null ? '' : live.hb < 60 ? `latido hace ${live.hb} s` : `latido hace ${Math.round(live.hb / 60)} min`;
  return (
    <span className={`o-live o-live--${v.tone}`} title="Vivacidad: proceso vivo, último latido y última salida del terminal (Plan · Fase 2)">
      <i aria-hidden="true" />{v.label}{!compact && hb && <span className="o-live__hb"> · {hb}</span>}
    </span>
  );
}

export const clock = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`);
export const money = (n) => `$${n.toFixed(2)}`;
export const tokensK = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** Texto con `código` en línea. */
export function Txt({ children }) {
  return String(children ?? '').split('`').map((part, i) => (i % 2 ? <code key={i} className="mono o-code">{part}</code> : part));
}

export function Empty({ children }) { return <p className="o-empty">{children}</p>; }

export function Seg({ value, onChange, options, label }) {
  return (
    <div className="o-seg" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="tab" aria-selected={value === o.id} className={value === o.id ? 'is-on' : ''} onClick={() => onChange(o.id)}>
          {o.label}{o.count != null && <i>{o.count}</i>}
        </button>
      ))}
    </div>
  );
}

export { I };
