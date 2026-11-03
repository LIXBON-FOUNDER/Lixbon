import { AttemptApproval } from './AttemptApproval';
import { useCoreQuery } from './useCoreQuery';

/**
 * Aprobar o rechazar el primer Attempt desde la bandeja de Attention. La Attention `approval` de un Attempt es la de
 * lanzamiento (`pending_approval`) o la de una petición de terminal (`awaiting_terminal_approval`, que no se responde
 * desde aquí) y `attention_list` no dice cuál es: se lee el estado del Attempt y solo se ofrece la decisión mientras
 * espera su aprobación. Sin lectura (modelo inactivo, error, cargando) no hay botones. La decisión es la misma que la del
 * detalle del Attempt: el Core vuelve a comprobar el estado y el plazo.
 */
export function InboxLaunchApproval({ attemptId }) {
  // Con el sondeo normal: si el intento se aprueba desde otro sitio, los botones desaparecen solos.
  const state = useCoreQuery('attempt_detail', { attempt_id: attemptId });
  if (state.data?.attempt?.status !== 'pending_approval') return null;
  return <AttemptApproval attemptId={attemptId} />;
}
