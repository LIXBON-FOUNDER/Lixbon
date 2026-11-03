import { COPY } from './adeLabels';

const filled = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * La línea de contexto del Attempt: con qué agente y perfil corre y dónde (rama, base, host). Todo viene de `attempt_detail`;
 * lo que el Core no informa se dice, nunca se rellena. Es la cabecera de una línea de la maqueta del ADE.
 */
export function AttemptContextLine({ attempt }) {
  const agent = [filled(attempt.provider), filled(attempt.model)].filter(Boolean).join(' · ');
  const worktree = attempt.worktree;
  const branch = filled(worktree?.branch);
  const base = filled(worktree?.base_branch);
  const machine = filled(worktree?.machine);
  return (
    <p className="ade-attempt__context" data-testid="attempt-context">
      <span className="ade-attempt__ctx-item" data-part="agent">{agent || COPY.notAvailable}</span>
      <span className="ade-attempt__ctx-item" data-part="profile">{filled(attempt.profile) ?? 'sin perfil'}</span>
      <span className="ade-attempt__ctx-item mono" data-part="branch">
        {branch ? `${branch}${base ? ` ← ${base}` : ''}` : 'sin worktree'}
      </span>
      <span className="ade-attempt__ctx-item" data-part="host" title={machine ?? undefined}>
        {machine ? `host ${machine.slice(0, 8)}` : 'host no informado'}
      </span>
    </p>
  );
}
