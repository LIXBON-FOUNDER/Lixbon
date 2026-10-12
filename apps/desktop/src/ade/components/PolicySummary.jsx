// PolicySummary.jsx — política efectiva de un intento: lo que la persona debe ver ANTES de aprobar.
// La interfaz no evalúa la política: muestra lo que entrega el Core (comando, estado, avisos, elevación).
import { POLICY_STATUS_LABELS } from '../vocab/vocabulario';

export function PolicySummary({ policy, compact = false }) {
  if (!policy) return null;
  return (
    <div className={`ade-policy ${policy.elevated ? 'is-elevated' : ''} ${compact ? 'is-compact' : ''}`} data-testid="policy-summary">
      <div className="ade-policy__head">
        <span>{POLICY_STATUS_LABELS[policy.status] || policy.status}</span>
        {policy.elevated && <span className="ade-tag ade-tag--warn">Política elevada</span>}
      </div>
      <code className="ade-policy__cmd mono">{(policy.command || []).join(' ')}</code>
      {policy.warnings?.length > 0 && (
        <ul className="ade-policy__warn">
          {policy.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
    </div>
  );
}
