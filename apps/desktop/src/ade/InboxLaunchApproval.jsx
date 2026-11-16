import { AttemptAnswer } from './AttemptAnswer';
import { AttemptApproval } from './AttemptApproval';
import { useCoreQuery } from './useCoreQuery';

/**
 * Decidir desde la bandeja de Attention. La Attention `approval` de un Attempt es la de lanzamiento (`pending_approval`) o la de
 * una petición del proveedor (`awaiting_terminal_approval`, LXO-247) y `attention_list` no dice cuál es: se lee el estado del
 * Attempt y solo se ofrece lo que corresponde: aprobar o rechazar el lanzamiento, o responder al permiso o la pregunta del
 * proveedor. Sin lectura (modelo inactivo, error, cargando) no hay botones. La decisión es la misma que la del detalle del
 * Attempt: el Core vuelve a comprobar el estado y el plazo.
 */
export function InboxLaunchApproval({ attemptId }) {
  // Con el sondeo normal: si el intento se aprueba desde otro sitio, los botones desaparecen solos.
  const state = useCoreQuery('attempt_detail', { attempt_id: attemptId });
  const status = state.data?.attempt?.status;
  if (status === 'pending_approval') return <AttemptApproval attemptId={attemptId} />;
  if (status === 'awaiting_terminal_approval') return <AttemptAnswer attemptId={attemptId} />;
  return null;
}
