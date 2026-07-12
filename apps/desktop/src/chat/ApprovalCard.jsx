// ApprovalCard.jsx — aprobación de un cambio del agente (crear/editar/eliminar).
// Aparece sobre la caja de entrada mientras el turno del agente espera.
import { useChatStore } from '../store/chatStore';

const KIND_LABEL = {
  create: 'Crear archivo',
  update: 'Modificar archivo',
  delete: 'Eliminar',
  rename: 'Mover / renombrar',
  mkdir: 'Nueva carpeta',
  command: 'Ejecutar comando',
};

export function ApprovalCard() {
  const pending = useChatStore((s) => s.pendingApproval);
  const resolveApproval = useChatStore((s) => s.resolveApproval);
  if (!pending) return null;

  const { tool, args, change } = pending;
  const label = (change && KIND_LABEL[change.kind]) || tool;
  const path = change?.path || args?.path || '';
  const hasDiff = change && (change.sampleOld?.length > 0 || change.sampleNew?.length > 0);
  const hiddenLines = change
    ? Math.max(0, change.removed - (change.sampleOld?.length || 0)) +
      Math.max(0, change.added - (change.sampleNew?.length || 0))
    : 0;

  return (
    <div className="approval">
      <div className="approval__head">
        <span className="approval__kind">{label}</span>
        <span className="approval__path">{path}</span>
        {change && (change.added > 0 || change.removed > 0) && (
          <span className="approval__counts">
            {change.added > 0 && <em className="toolrow__add">+{change.added}</em>}
            {change.removed > 0 && <em className="toolrow__del">−{change.removed}</em>}
          </span>
        )}
      </div>

      {hasDiff && (
        <pre className="approval__diff">
          {change.sampleOld.map((line, i) => (
            <span key={`o${i}`} className="approval__line approval__line--del">- {line}{'\n'}</span>
          ))}
          {change.sampleNew.map((line, i) => (
            <span key={`n${i}`} className="approval__line approval__line--add">+ {line}{'\n'}</span>
          ))}
          {hiddenLines > 0 && (
            <span className="approval__line approval__line--more">… +{hiddenLines} líneas más{'\n'}</span>
          )}
        </pre>
      )}

      <div className="approval__actions">
        <button className="approval__btn approval__btn--primary" onClick={() => resolveApproval('yes')}>
          Aplicar
        </button>
        <button className="approval__btn" onClick={() => resolveApproval('always')} title="Auto-aprobar el resto de la conversación">
          Aplicar todo
        </button>
        <button className="approval__btn approval__btn--danger" onClick={() => resolveApproval('no')}>
          Rechazar
        </button>
      </div>
    </div>
  );
}
