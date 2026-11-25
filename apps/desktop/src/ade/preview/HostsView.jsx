import { useState } from 'react';
import { StatusIcon } from '@lixbon/icons/status';
import { Modal } from '../../components/Modal';
import { usePreviewStore } from './previewStore';
import { Agent, Mark } from './PreviewUi';

const hostIcon = (host, needs) => host.status === 'offline' ? 'offline' : needs ? 'host-needs' : /windows/i.test(host.os) ? 'monitor' : /mac/i.test(host.os) ? 'laptop' : 'server';
const selectedHost = (state) => state.hosts.find((host) => host.id === state.inspectedHostId) || state.hosts[0];

export function HostSidebar() {
  const state = usePreviewStore();
  const selected = selectedHost(state);
  return <div className="pv-host-sidebar" aria-label="Hosts">
    {state.hosts.map((host) => {
      const needs = state.attention.some((item) => item.kind === 'permission' && state.attempts.some((attempt) => attempt.id === item.attemptId && attempt.host === host.id));
      return <button type="button" key={host.id} className={`pv-host-choice ${selected?.id === host.id ? 'is-selected' : ''}`} aria-pressed={selected?.id === host.id} onClick={() => state.inspectHost(host.id)}>
        <StatusIcon kind={hostIcon(host, needs)} size={18} /><span><b>{host.name}</b><small>{host.os} · {host.status === 'offline' ? 'sin conexión' : needs ? 'te pide permiso' : host.note}</small></span>
      </button>;
    })}
  </div>;
}

export function HostsDetail({ children }) {
  const state = usePreviewStore();
  const host = selectedHost(state);
  const [confirm, setConfirm] = useState(false);
  if (!host) return <div className="changes__empty">No hay hosts disponibles.</div>;
  const attempts = state.attempts.filter((attempt) => attempt.host === host.id);
  const active = attempts.filter((attempt) => ['working', 'starting', 'waiting'].includes(attempt.state));
  const requests = state.attention.filter((item) => item.kind === 'permission' && attempts.some((attempt) => attempt.id === item.attemptId));
  const toggle = () => { if (host.status === 'online' && active.length) setConfirm(true); else state.toggleHost(host.id); };
  return <div className="pv-host-detail scroll">
    <header className="pv-view__head"><h1 className="pv-view__title">{host.name}</h1><span className="panelhead__fill" /><button type="button" className="btn btn--ghost btn--sm" onClick={toggle}>{host.status === 'online' ? 'Desconectar' : 'Reconectar'}</button></header>
    <p className="pv-muted">{host.os} · {host.note} · {host.transport}</p>
    {requests.length > 0 && <div className="pv-callout"><StatusIcon kind="permission" size={16} /><span>Un intento en este host te pide permiso</span><span className="panelhead__fill" /><button type="button" className="btn btn--ghost btn--sm" onClick={() => state.setView('attention')}>Ver en Atención</button></div>}
    <div className={`pv-host-metrics ${host.status === 'offline' ? 'is-offline' : ''}`}>
      <article><span>Intentos</span><b>{active.length}</b><small>{attempts.length} en este host</small></article>
      <article><span>CPU</span><b>{typeof host.cpu === 'number' ? `${host.cpu} %` : 'No informado'}</b>{typeof host.cpu === 'number' && <meter min="0" max="100" value={host.cpu} />}</article>
      <article><span>Memoria</span><b>{typeof host.memory === 'number' ? `${host.memory} %` : 'No informado'}</b>{typeof host.memory === 'number' && <meter min="0" max="100" value={host.memory} />}</article>
    </div>
    <h2 className="pv-host-section">En este host</h2>
    <ul className="pv-host-attempts">{attempts.map((attempt) => <li key={attempt.id}><button type="button" onClick={() => state.select(attempt.id)}><Mark attempt={attempt} size={15} /><span>{state.tasks.find((task) => task.id === attempt.taskId)?.title} · Intento {attempt.label}</span><span className="panelhead__fill" /><Agent attempt={attempt} detail={false} /><small>{attempt.minutes} min</small></button></li>)}</ul>
    {children && <details className="pv-host-resources"><summary>Todos los hosts y worktrees</summary>{children}</details>}
    {confirm && <Modal title="Desconectar el host" onClose={() => setConfirm(false)} size="sm"><p>{host.name} tiene {active.length} intentos en marcha. Al desconectarlo no podrán continuar hasta que vuelva a estar disponible.</p><div className="pv-modal__actions"><button type="button" className="btn btn--ghost" onClick={() => setConfirm(false)}>Cancelar</button><button type="button" className="btn btn--primary" onClick={() => { state.toggleHost(host.id); setConfirm(false); }}>Desconectar</button></div></Modal>}
  </div>;
}
