import { useState } from 'react';
import { IconCode } from '../components/Icons';
import { openAttemptWorkspace } from './f6Navigation';
import { AttemptFork } from './AttemptFork';

export function AttemptWorkspaceActions({ attempt, active, onOpenAttempt }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const openEditor = async () => {
    setOpening(true);
    setError('');
    try { await openAttemptWorkspace(attempt.id); }
    catch (failure) { setError(failure.message || String(failure)); }
    finally { setOpening(false); }
  };
  return <div className="ade-workspace-actions">
    <button type="button" className="btn btn--primary btn--sm" onClick={openEditor} disabled={opening || !attempt.worktree} title={!attempt.worktree ? 'El Core no informa de un worktree para este intento' : undefined}><IconCode size={16} />{opening ? 'Abriendo…' : 'Abrir en el Editor'}</button>
    <AttemptFork key={attempt.id} attempt={attempt} active={active} compact onOpenAttempt={onOpenAttempt} />
    {error && <p className="ade-notice ade-notice--error" role="alert">{error}</p>}
  </div>;
}

// Solo nombres de etapa explícitos: una fase libre (p. ej. «lint») no se adivina.
const PHASES = [
  { label: 'Preparación', names: ['preparation', 'preparación', 'preparacion'] },
  { label: 'Ejecución', names: ['execution', 'ejecución', 'ejecucion'] },
  { label: 'Verificación', names: ['verification', 'verificación', 'verificacion'] },
  { label: 'Revisión · tú', names: ['review', 'revisión', 'revision'] },
  { label: 'Integración · tú', names: ['integration', 'integración', 'integracion'] },
];

export function AttemptPhases({ phase }) {
  const name = typeof phase?.name === 'string' ? phase.name.trim().toLowerCase() : '';
  const current = PHASES.findIndex((p) => p.names.includes(name));
  return <div className="ade-core-phasebar" aria-label="Fases del intento">{PHASES.map((p, i) => <span key={p.label} className={current >= 0 && (i < current || (i === current && phase.done === true)) ? 'is-done' : i === current ? 'is-current' : ''} aria-current={i === current && phase.done !== true ? 'step' : undefined}>{p.label}</span>)}</div>;
}
