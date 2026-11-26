import { AttemptAnswer } from './AttemptAnswer';
import { AttemptApproval } from './AttemptApproval';
import { useCoreQuery } from './useCoreQuery';
import { CoreModelNotice } from './CoreModelNotice';
import { attemptLetter } from './attemptFormat';
import { ProviderMark } from '../orch/agent/ProviderMark';
import { providerName } from '../orch/agent/agentIdentity';

/**
 * Decidir desde la bandeja de Attention. La Attention `approval` de un Attempt es la de lanzamiento (`pending_approval`) o la de
 * una petición del proveedor (`awaiting_terminal_approval`, LXO-247) y `attention_list` no dice cuál es: se lee el estado del
 * Attempt y solo se ofrece lo que corresponde: aprobar o rechazar el lanzamiento, o responder al permiso o la pregunta del
 * proveedor. Sin lectura (modelo inactivo, error, cargando) no hay botones. La decisión es la misma que la del detalle del
 * Attempt: el Core vuelve a comprobar el estado y el plazo.
 */
export function InboxLaunchApproval({ attemptId, onDecided, active = true }) {
  // Con el sondeo normal: si el intento se aprueba desde otro sitio, los botones desaparecen solos.
  const state = useCoreQuery('attempt_detail', { attempt_id: attemptId }, { enabled: active });
  const attempt = state.data?.attempt?.id === attemptId && ['ready', 'refreshing'].includes(state.status) ? state.data.attempt : null;
  const status = attempt?.status;
  if (!active) return null;
  const decided = () => { state.retry(); onDecided?.(); };
  if (state.error) return <CoreModelNotice error={state.error} onRetry={state.retry} />;
  if (!attempt) return <p role="status" className="nat__hint">Leyendo el estado del intento.</p>;
  return <>
    <p className="attention-attempt-origin"><ProviderMark provider={attempt.provider} size={16}/><span>{providerName(attempt.provider)} · Intento {attemptLetter(attempt.n)}{attempt.worktree?.machine ? ` · ${attempt.worktree.machine}` : ''}</span></p>
    {status === 'pending_approval' && <AttemptApproval key={attemptId} attemptId={attemptId} onDecided={decided} />}
    {status === 'awaiting_terminal_approval' && <AttemptAnswer attemptId={attemptId} onAnswered={decided} inbox />}
    {!['pending_approval', 'awaiting_terminal_approval'].includes(status) && <p className="nat__hint" role="status">Este intento ya no espera esa decisión.</p>}
  </>;
}
