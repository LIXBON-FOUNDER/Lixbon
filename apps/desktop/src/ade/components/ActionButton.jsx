// ActionButton.jsx — botón de un intent. La disponibilidad la manda la capacidad, no el componente.
//
//  - available   -> botón normal.
//  - simulated   -> botón normal con marca «sim.» (la acción solo cambia la memoria del mock).
//  - unavailable -> deshabilitado, con el slice que lo habilitará escrito en el propio botón y el motivo
//                   en el tooltip. Jamás se finge.
// Si el intent pide confirmación (`requiresConfirmation` de la capacidad), el primer clic la pide.
import { useState } from 'react';
import { useAde, useCapability } from '../state/AdeProvider';

/**
 * @param {{intent: string, args?: object, label?: string, variant?: 'primary'|'ghost'|'accent', size?: 'sm'|'md',
 *          confirm?: boolean, onDone?: (r: {ok: boolean}) => void, onClick?: () => void, disabled?: boolean}} props
 * Con `onClick` el botón no despacha nada (lo gestiona quien lo usa, p. ej. un formulario en línea).
 */
export function ActionButton({ intent, args = {}, label, variant = 'ghost', size = 'sm', confirm, onDone, onClick, disabled = false }) {
  const cap = useCapability(intent);
  const { run, runHost } = useAde();
  const [pidiendo, setPidiendo] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const texto = label || cap.label;
  const necesitaConfirmar = confirm ?? cap.requiresConfirmation;
  const clases = `btn ${variant === 'primary' ? 'btn--primary' : variant === 'accent' ? 'btn--accent' : 'btn--ghost'} ${size === 'sm' ? 'btn--sm' : ''} ade-action`;

  if (!cap.usable) {
    return (
      <button type="button" className={`${clases} is-unavailable`} disabled data-intent={intent} data-availability="unavailable" title={cap.reason || 'No disponible'}>
        <span>{texto}</span>
        {cap.slice && <span className="ade-action__slice">{cap.slice}</span>}
      </button>
    );
  }

  async function ejecutar() {
    if (onClick) { onClick(); return; }
    setOcupado(true);
    const r = await (cap.owner === 'host' ? runHost({ type: intent, ...args }) : run({ type: intent, ...args }));
    setOcupado(false);
    setPidiendo(false);
    onDone?.(r);
  }

  if (pidiendo) {
    return (
      <span className="ade-confirm" role="group" aria-label={`Confirmar: ${texto}`}>
        <button type="button" className="btn btn--primary btn--sm ade-action" onClick={ejecutar} disabled={ocupado} data-intent={intent} data-confirm="yes">Confirmar {texto.toLowerCase()}</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPidiendo(false)}>Cancelar</button>
      </span>
    );
  }

  return (
    <button
      type="button" className={clases} disabled={disabled || ocupado} data-intent={intent} data-availability={cap.availability}
      title={cap.availability === 'simulated' ? `${cap.reason} Slice que la hará real: ${cap.slice ?? 'ninguno (ya existe en el Desktop)'}.` : cap.reason || undefined}
      onClick={() => (necesitaConfirmar && !onClick ? setPidiendo(true) : ejecutar())}
    >
      <span>{texto}</span>
      {cap.availability === 'simulated' && <span className="ade-action__sim" aria-label="simulado">sim.</span>}
    </button>
  );
}
