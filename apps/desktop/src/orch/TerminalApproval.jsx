// TerminalApproval.jsx — indicador de espera de aprobación en la terminal del agente.
// Solo pinta lo que trae el snapshot; nombres en ./terminalApprovalContract.js.
import { TERMINAL_APPROVAL_TEXT as TXT, isAwaitingTerminalApproval, failureReasonText, isTerminalApprovalTimeout, approvalDeadline, countdown } from './terminalApprovalContract';

/** Aviso para la cabecera de la tarea. `onGoToTerminal` opcional abre la pestaña Terminal. */
export function TerminalApprovalNotice({ task, now, onGoToTerminal }) {
  if (isAwaitingTerminalApproval(task)) {
    const left = countdown(approvalDeadline(task), now);
    return (
      <div role="status" className="orch__approval" data-testid="terminal-approval">
        <strong>{TXT.waiting}</strong>
        {left && <> · <span className="mono" data-testid="terminal-approval-countdown">{left}</span></>}
        <div className="orch__approval-hint">
          {TXT.hint}
          {onGoToTerminal && <> <button type="button" className="lk" onClick={onGoToTerminal}>Ir a la terminal</button></>}
        </div>
      </div>
    );
  }
  const failure = failureReasonText(task);
  if (failure) return <div role="alert" className="orch__approval is-failed" data-testid="failure-reason">{failure}</div>;
  return null;
}

/** Marca compacta para la fila de la tarea. */
export function TerminalApprovalBadge({ task, now }) {
  if (isAwaitingTerminalApproval(task)) {
    const left = countdown(approvalDeadline(task), now);
    return (
      <span className="orch__badge orch__badge--warn" data-testid="terminal-approval-badge" title={`${TXT.waiting}. ${TXT.hint}`}>
        aprobar en terminal{left ? ` · ${left}` : ''}
      </span>
    );
  }
  const failure = failureReasonText(task);
  if (failure) {
    const label = isTerminalApprovalTimeout(task) ? 'sin aprobación' : 'sin actividad';
    return <span className="orch__badge orch__badge--warn" data-testid="failure-reason-badge" title={failure}>{label}</span>;
  }
  return null;
}
