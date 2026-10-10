import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { TerminalApprovalNotice, TerminalApprovalBadge } from './TerminalApproval';
import { FAILURE_REASONS, FAILURE_REASON_TEXT, failureReasonText, TERMINAL_APPROVAL, TERMINAL_APPROVAL_TEXT as TXT, countdown, toMs } from './terminalApprovalContract';
import { STATUS_LABELS, isFinal } from '../store/orchStore';

afterEach(cleanup);
const NOW = 1_800_000_000_000;
const waiting = (extra = {}) => ({ id: 't1', status: TERMINAL_APPROVAL.status, ...extra });

describe('espera de aprobación en la terminal', () => {
  it('contrato: nombres propuestos', () => {
    expect(TERMINAL_APPROVAL).toEqual({ status: 'awaiting_terminal_approval', deadlineField: 'approval_deadline', failureField: 'failure_reason', timeoutReason: 'terminal_approval_timeout' });
    expect(STATUS_LABELS.awaiting_terminal_approval).toBe(TXT.waiting);
    expect(isFinal('awaiting_terminal_approval')).toBe(false);
  });

  it('con approval_deadline: indicador, cuenta atrás y pista para ir a la terminal', () => {
    let went = 0;
    render(<TerminalApprovalNotice task={waiting({ approval_deadline: NOW + 95_000 })} now={NOW} onGoToTerminal={() => { went += 1; }} />);
    expect(screen.getByTestId('terminal-approval').textContent).toContain(TXT.waiting);
    expect(screen.getByTestId('terminal-approval-countdown').textContent).toBe('vence en 1:35');
    expect(screen.getByText(TXT.hint, { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ir a la terminal' }));
    expect(went).toBe(1);
  });

  it('sin approval_deadline: indicador sin cuenta atrás', () => {
    render(<TerminalApprovalNotice task={waiting()} now={NOW} />);
    expect(screen.getByTestId('terminal-approval').textContent).toContain(TXT.waiting);
    expect(screen.queryByTestId('terminal-approval-countdown')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('deadline ISO o vencido', () => {
    expect(countdown(new Date(NOW + 5_000).toISOString(), NOW)).toBe('vence en 0:05');
    expect(countdown(NOW - 1, NOW)).toBe('vencido');
    expect(countdown(null, NOW)).toBe('');
    expect(countdown('basura', NOW)).toBe('');
    expect(toMs(String(NOW))).toBe(NOW);
  });

  it('fallo por terminal_approval_timeout: "Nadie aprobó en la terminal a tiempo"', () => {
    render(<><TerminalApprovalNotice task={{ status: 'failed', failure_reason: 'terminal_approval_timeout' }} now={NOW} />
      <TerminalApprovalBadge task={{ status: 'failed', failure_reason: 'terminal_approval_timeout' }} now={NOW} /></>);
    expect(screen.getByRole('alert').textContent).toBe(TXT.timeout);
    expect(screen.getByTestId('failure-reason-badge')).toBeTruthy();
  });

  it('otro motivo de fallo o snapshot viejo sin campos: no pinta nada', () => {
    const { container } = render(<>
      <TerminalApprovalNotice task={{ status: 'failed', failure_reason: 'otro' }} now={NOW} />
      <TerminalApprovalNotice task={{ status: 'failed' }} now={NOW} />
      <TerminalApprovalNotice task={{ status: 'running' }} now={NOW} />
      <TerminalApprovalBadge task={{ status: 'done' }} now={NOW} />
      <TerminalApprovalNotice task={undefined} now={NOW} />
    </>);
    expect(container.textContent).toBe('');
  });

  it('badge de la fila con cuenta atrás', () => {
    render(<TerminalApprovalBadge task={waiting({ approval_deadline: NOW + 61_000 })} now={NOW} />);
    const b = screen.getByTestId('terminal-approval-badge');
    expect(b.textContent).toBe('aprobar en terminal · vence en 1:01');
    expect(b.getAttribute('title')).toContain(TXT.waiting);
  });

  it('agent_idle_timeout: "El agente no escribió nada durante demasiado tiempo"', () => {
    expect(FAILURE_REASONS.agentIdleTimeout).toBe('agent_idle_timeout');
    const t = { status: 'failed', failure_reason: 'agent_idle_timeout' };
    render(<><TerminalApprovalNotice task={t} now={NOW} /><TerminalApprovalBadge task={t} now={NOW} /></>);
    expect(screen.getByRole('alert').textContent).toBe('El agente no escribió nada durante demasiado tiempo');
    expect(screen.getByTestId('failure-reason-badge').textContent).toBe('sin actividad');
    expect(FAILURE_REASON_TEXT.terminal_approval_timeout).toBe(TXT.timeout);
    expect(failureReasonText({ status: 'running', failure_reason: 'agent_idle_timeout' })).toBeNull();
  });
});
