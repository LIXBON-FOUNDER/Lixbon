import { useEffect, useRef, useState } from 'react';
import { cancelQueued, describeCommandError, newRequestId, queueInstruction } from './attemptCommands';
import { formatUtc } from './attemptFormat';
import { describeCapability, providerOf } from './capabilityModel';
import { useCoreQuery } from './useCoreQuery';
import { useProviderCapabilities } from './useProviderCapabilities';

/** El cuerpo de una instrucción admite hasta 20 000 caracteres (el Core lo vuelve a comprobar). */
export const MAX_QUEUE_CHARS = 20000;
const PREVIEW_CHARS = 280;
const HOT_POLL_MS = 3000;

const STATUS_TEXT = { queued: 'En cola', delivering: 'Entregando', delivered: 'Entregada', cancelled: 'Cancelada', failed: 'No se entregó' };
const AUTHOR_TEXT = { person: 'Tú', agent: 'Un agente', system: 'El Core' };
/** Por qué no se entregó una instrucción, en llano y con qué hacer. Conjunto cerrado del Core: nunca el error crudo del proveedor. */
const FAILURE_TEXT = {
  unsupported: 'El proveedor no puede entregar instrucciones entre turnos.',
  environment_blocked: 'El entorno del proveedor está bloqueado: arréglalo fuera de Lixbon y vuelve a enviarla.',
  adapter_unavailable: 'No llegó al proveedor (la ejecución o la capacidad no estaba disponible). Puedes volver a enviarla.',
  adapter_error: 'El proveedor devolvió un error al entregarla. Puedes volver a enviarla.',
  attempt_ended: 'El intento terminó antes de entregarla. Si sigue haciendo falta, continúa la sesión con ella.',
  interrupted: 'Se interrumpió en vuelo: no se sabe si llegó y no se reintenta. Reenvíala solo si hace falta.',
};
const STEER_WHY = 'Steer (inyectar en el turno en curso) todavía no existe en el Core (LXO-144).';
const STOP_SEND_WHY = 'Detener y enviar todavía no existe en el Core (LXO-144). Para parar el intento usa «Detener».';

const preview = (body) => (body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS)}…` : body);

function When({ ms }) {
  const time = formatUtc(ms);
  return time ? <time dateTime={time.iso}>{time.label}</time> : null;
}

function ItemMeta({ item, position }) {
  return (
    <span className="aq__meta">
      {position ? <strong>#{position}</strong> : null}
      <span className="aq__state" data-status={item.status}>{STATUS_TEXT[item.status]}</span>
      <span>{AUTHOR_TEXT[item.author_kind] ?? item.author_kind}</span>
      <When ms={item.created_at} />
    </span>
  );
}

/**
 * Enviar instrucciones a un intento OCUPADO y ver su cola (LXO-151/152). Lo que hace Enter se dice siempre: **encolar**, para el
 * siguiente turno (nunca en mitad del turno en curso). Steer y Detener y enviar se muestran desactivados con su razón (el Core aún no
 * los ofrece) y NUNCA caen a encolar en silencio. El borrador se conserva si el Core rechaza el envío y la clave de idempotencia se
 * reutiliza mientras el texto no cambie. El dock muestra lo que el Core dice: nada se da por entregado hasta que el Core lo confirma.
 */
export function AttemptQueue({ attempt }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null);
  const [error, setError] = useState(null);
  const [cancelling, setCancelling] = useState(null);
  const [cancelError, setCancelError] = useState(null);
  const pending = useRef(null);
  const running = attempt?.status === 'running';
  const live = Boolean(attempt?.id) && attempt.status !== 'pending_approval';
  // Con el intento en marcha o con algo pendiente la cola se relee deprisa: ver la entrega «en vivo» no puede tardar 15 s.
  const [hot, setHot] = useState(false);
  const queue = useCoreQuery('pending_queue', { attempt_id: attempt?.id ?? null }, { enabled: live, pollMs: hot ? HOT_POLL_MS : undefined });
  const pendingCount = queue.data?.items?.length ?? 0;
  useEffect(() => { setHot(running || pendingCount > 0); }, [running, pendingCount]);
  const caps = useProviderCapabilities({ enabled: running && Boolean(attempt?.provider) });
  if (!live) return null;

  const data = queue.data ?? null;
  const items = data?.items ?? [];
  const finished = data?.finished ?? [];
  if (!running && items.length === 0 && finished.length === 0) return null;

  // «Encolar» necesita que el proveedor pueda reanudar la sesión (así entrega el Core el siguiente turno).
  let blocked = null;
  if (running) {
    if (caps.unsupported) blocked = 'Este Core no informa de lo que ofrece cada proveedor: no se puede encolar.';
    else if (!caps.snapshot) blocked = caps.status === 'error' ? 'No se pudo comprobar lo que ofrece el proveedor: no se puede encolar.' : 'Comprobando lo que ofrece el proveedor…';
    else {
      const info = describeCapability(providerOf(caps.snapshot, attempt.provider), 'resume', attempt.provider);
      if (!info.enabled) blocked = `${attempt.provider} no puede entregar instrucciones entre turnos (no ofrece reanudar sesiones): ${info.reason}`;
    }
  }

  const body = draft.trim();
  const send = async () => {
    if (!body || busy || blocked) return;
    // Misma instrucción tras un error: misma clave (el Core devuelve el mismo item, no duplica). Texto distinto: clave nueva.
    if (!pending.current || pending.current.body !== body) pending.current = { key: newRequestId(), body };
    setBusy(true);
    setError(null);
    try {
      const result = await queueInstruction(attempt.id, pending.current.key, body);
      setSent(result?.status === 'Replayed' ? 'Esta instrucción ya estaba en la cola.' : `Encolada${Number.isInteger(result?.position) ? ` (posición ${result.position})` : ''}: se entregará en el siguiente turno.`);
      setDraft('');
      pending.current = null;
      queue.retry?.();
    } catch (failure) {
      // El borrador se conserva: el usuario no pierde lo que escribió.
      setError(describeCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (queueId) => {
    setCancelling(queueId);
    setCancelError(null);
    try {
      await cancelQueued(queueId);
    } catch (failure) {
      setCancelError(describeCommandError(failure));
    } finally {
      setCancelling(null);
      queue.retry?.();
    }
  };

  const onKeyDown = (event) => {
    // Enter encola; Shift+Enter inserta un salto de línea. No se actúa mientras se compone con un IME.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
      event.preventDefault();
      send();
    }
  };

  return (
    <section className="aq" aria-label="Instrucciones en cola" data-testid="attempt-queue">
      <div className="aq__head">
        <h4 className="ssec__label">Instrucciones en cola</h4>
        <span className="aq__count" data-testid="aq-count" aria-live="polite">{items.length === 1 ? '1 pendiente' : `${items.length} pendientes`}</span>
      </div>

      {running && (
        <div className="aq__composer" data-testid="aq-composer">
          <div className="aq__modes" role="radiogroup" aria-label="Qué hace enviar">
            <label className="aq__mode"><input type="radio" name={`aq-mode-${attempt.id}`} checked readOnly data-testid="aq-mode-queue" />Encolar <span className="aq__why">para el siguiente turno</span></label>
            <label className="aq__mode aq__mode--off" title={STEER_WHY}><input type="radio" name={`aq-mode-${attempt.id}`} disabled aria-describedby={`aq-steer-${attempt.id}`} data-testid="aq-mode-steer" />Steer <span className="aq__why" id={`aq-steer-${attempt.id}`}>{STEER_WHY}</span></label>
            <label className="aq__mode aq__mode--off" title={STOP_SEND_WHY}><input type="radio" name={`aq-mode-${attempt.id}`} disabled aria-describedby={`aq-stop-${attempt.id}`} data-testid="aq-mode-stop-send" />Detener y enviar <span className="aq__why" id={`aq-stop-${attempt.id}`}>{STOP_SEND_WHY}</span></label>
          </div>
          <textarea
            className="aq__text"
            aria-label="Instrucción para el siguiente turno"
            rows={3}
            maxLength={MAX_QUEUE_CHARS}
            value={draft}
            disabled={busy || Boolean(blocked)}
            onChange={(event) => { setDraft(event.target.value); setSent(null); }}
            onKeyDown={onKeyDown}
            data-testid="aq-text"
          />
          <p className="aq__hint" data-testid="aq-enter-hint">Enter encola la instrucción; Shift+Enter inserta un salto de línea. Se entrega cuando el turno en curso termine, nunca en mitad de él.</p>
          {blocked && <p className="cap-note cap-note--warn" role="status" data-testid="aq-blocked">{blocked}</p>}
          <div className="nat__actions">
            <button type="button" className="btn btn--primary btn--sm" disabled={busy || !body || Boolean(blocked)} onClick={send} data-testid="aq-send">{busy ? 'Encolando…' : 'Encolar'}</button>
          </div>
          {sent && <p role="status" data-testid="aq-sent">{sent}</p>}
          {error && (
            <div className="ade-notice ade-notice--error" role="alert" data-testid="aq-error">
              <span>{error.message}</span>
              {error.detail !== error.message && <details><summary>Detalle técnico</summary><code>{error.detail}</code></details>}
            </div>
          )}
        </div>
      )}

      {queue.error && !data && <p className="cap-note cap-note--warn" role="status" data-testid="aq-read-error">No se pudo leer la cola del Core; se reintentará.</p>}

      {items.length > 0 && (
        <ol className="aq__list" aria-label="Pendientes, en el orden en que se entregarán" data-testid="aq-pending">
          {items.map((item) => (
            <li key={item.queue_id} className="aq__item" data-testid={`aq-item-${item.queue_id}`} data-status={item.status}>
              <ItemMeta item={item} position={item.position} />
              <pre className="aq__body">{preview(item.body)}</pre>
              {item.status === 'queued' ? (
                <button type="button" className="btn btn--ghost btn--sm" disabled={cancelling === item.queue_id} onClick={() => cancel(item.queue_id)} aria-label={`Cancelar la instrucción ${item.position}`} data-testid={`aq-cancel-${item.queue_id}`}>{cancelling === item.queue_id ? 'Cancelando…' : 'Cancelar'}</button>
              ) : (
                <span className="aq__why">Se está entregando: ya no se puede cancelar.</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {cancelError && (
        <div className="ade-notice ade-notice--error" role="alert" data-testid="aq-cancel-error">
          <span>{cancelError.message}</span>
          {cancelError.detail !== cancelError.message && <details><summary>Detalle técnico</summary><code>{cancelError.detail}</code></details>}
        </div>
      )}

      {finished.length > 0 && (
        <details className="aq__finished" data-testid="aq-finished">
          <summary>Historial ({finished.length})</summary>
          <ol className="aq__list" aria-label="Instrucciones ya resueltas">
            {finished.map((item) => (
              <li key={item.queue_id} className={`aq__item aq__item--${item.status}`} data-testid={`aq-item-${item.queue_id}`} data-status={item.status}>
                <ItemMeta item={item} position={null} />
                <pre className="aq__body">{preview(item.body)}</pre>
                {item.status === 'failed' && <p className="aq__why" data-testid={`aq-reason-${item.queue_id}`}>{FAILURE_TEXT[item.failure] ?? 'No se entregó.'}</p>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
