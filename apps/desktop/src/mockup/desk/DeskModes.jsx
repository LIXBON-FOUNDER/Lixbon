// DeskModes.jsx — Agente, Git y Diseño como ESQUELETOS: la distribución real de cada modo (paneles flotantes, panel del agente
// siempre a la derecha) con lo mínimo de contenido. Lo único vivo es lo que viene del Attempt seleccionado, para que se vea que
// el mismo trabajo atraviesa los modos: su conversación en Agente, sus archivos y su rama en Git.
import React from 'react';
import { useStore, attemptById, taskOf, timelineOf } from '../store';
import { REVIEW_FILES } from '../data';
import { agentShort } from '../vocab';
import { Agent, StatePill, I } from '../ui';
import { useDesk } from './deskStore';

const Bars = ({ n = 4, w = [92, 78, 64, 84, 70] }) => <div className="sk-bars" aria-hidden="true">{Array.from({ length: n }, (_, i) => <i key={i} style={{ width: `${w[i % w.length]}%` }} />)}</div>;

function Region({ title, hint, children, className = '' }) {
  return (
    <section className={`sk-region ${className}`} aria-label={title}>
      <header className="sk-region__h"><h2>{title}</h2></header>
      {children}
      {hint && <p className="sk-hint">{hint}</p>}
    </section>
  );
}

function AgentPanel({ a, task, mode }) {
  const s = useStore();
  const ev = timelineOf(s, a).filter((e) => e.kind === 'agent' || e.kind === 'user').slice(-2);
  return (
    <Region title="Agente" className="sk-agent" hint={mode === 'agent' ? null : 'El panel del agente está siempre a la derecha, en todos los modos.'}>
      <div className="sk-agent__who"><Agent attempt={a} size={16} /><StatePill attempt={a} size={11} /></div>
      <p className="sk-agent__ctx">{task.title} · Attempt {a.label}</p>
      {ev.map((e) => <p key={e.id} className={`sk-msg ${e.kind === 'user' ? 'is-user' : ''}`}>{e.text}</p>)}
      <div className="sk-composer" aria-hidden="true">Pide algo, @ para mencionar un archivo, / para comandos</div>
    </Region>
  );
}

function Files({ a }) {
  const s = useStore();
  const files = REVIEW_FILES[a.id] || timelineOf(s, a).filter((e) => e.kind === 'edits').flatMap((e) => e.files);
  if (!files.length) return <p className="sk-empty">Sin cambios en este Attempt.</p>;
  return (
    <ul className="sk-files">
      {files.slice(0, 7).map((f) => <li key={f.path}><b className="sk-m">M</b><span className="mono trunc">{f.path.split('/').slice(-2).join('/')}</span><span className="sk-num"><i className="good">+{f.add}</i> <i className="bad">−{f.del}</i></span></li>)}
    </ul>
  );
}

const COPY = {
  agent: { label: 'Agente', note: 'Conversación con el agente, con sus sesiones a la izquierda y los cambios que propone a la derecha.' },
  git: { label: 'Git', note: 'Cambios y commit a la izquierda, pull requests en el centro, agente a la derecha.' },
  design: { label: 'Diseño', note: 'Capas a la izquierda, lienzo en el centro, inspector y agente a la derecha.' },
};

export function ModeSkeleton({ mode }) {
  const s = useStore();
  const setMode = useDesk((d) => d.setMode);
  const a = attemptById(s, s.sel.attemptId);
  const task = taskOf(s, a);
  const ev = timelineOf(s, a).filter((e) => e.kind === 'agent' || e.kind === 'user').slice(-3);
  return (
    <div className="sk" data-mode={mode}>
      <div className="sk__ribbon">
        <b>{COPY[mode].label}</b><span>{COPY[mode].note}</span><span className="sk__tag">Esqueleto de distribución · sin contenido en esta maqueta</span>
        <span className="sp" />
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setMode('orch')}><I n="nodes" size={12} />Abrir en Orquestar</button>
      </div>
      <div className="sk__grid">
        {mode === 'agent' && (<>
          <Region title="Sesiones"><ul className="sk-list"><li className="is-on"><b>{task.title}</b><span>Attempt {a.label} · {agentShort(a)}</span></li><li><b>Nueva conversación</b><span>Sin enviar</span></li><li><b>Revisar el módulo de pagos</b><span>Ayer</span></li></ul></Region>
          <Region title="Conversación" className="sk-center">
            {ev.map((e) => <p key={e.id} className={`sk-msg ${e.kind === 'user' ? 'is-user' : ''}`}>{e.text}</p>)}
            <div className="sk-composer" aria-hidden="true">Pide algo, @ para mencionar un archivo, / para comandos</div>
          </Region>
          <Region title="Cambios" hint="Los archivos que propone el agente en este Attempt."><Files a={a} /></Region>
        </>)}
        {mode === 'git' && (<>
          <Region title="Cambios y commit"><p className="sk-branch mono">{a.branch || 'plan · sin worktree'}</p><div className="sk-composer" aria-hidden="true">Mensaje de commit</div><Files a={a} /></Region>
          <Region title="Pull requests" className="sk-center" hint="Abiertos y cerrados, con checks y revisión."><ul className="sk-list"><li className="is-on"><b>{task.title}</b><span>Borrador · {a.branch || 'sin rama'}</span></li><li><b>fix: paginación de /orders</b><span>#127 · aprobado</span></li></ul><Bars n={5} /></Region>
          <AgentPanel a={a} task={task} mode={mode} />
        </>)}
        {mode === 'design' && (<>
          <Region title="Capas"><Bars n={6} w={[70, 58, 64, 52, 66, 48]} /></Region>
          <Region title="Lienzo" className="sk-center sk-canvas" hint="El lienzo ocupa el centro; las herramientas flotan sobre él." ><div className="sk-frame" aria-hidden="true"><i /><i /><i /></div></Region>
          <div className="sk-stack"><Region title="Inspector"><Bars n={4} /></Region><AgentPanel a={a} task={task} mode={mode} /></div>
        </>)}
      </div>
    </div>
  );
}
