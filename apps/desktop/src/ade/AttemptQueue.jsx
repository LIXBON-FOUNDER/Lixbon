import { useEffect, useRef, useState } from 'react';
import { cancelQueued, describeCommandError, newRequestId, queueInstruction, steerAttempt, stopAndSend } from './attemptCommands';
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

/**
 * Las tres formas de hablar con un intento ocupado (LXO-144). Son comandos DISTINTOS del Core y ninguno cae a otro: cada modo exige sus
 * capabilities y, si el proveedor no las ofrece, se muestra desactivado con la razón que da el Core.
 */
const MODES = {
  queue: {
    id: 'queue',
    testid: 'aq-mode-queue',
    label: 'Encolar',
    why: 'para el siguiente turno',
    needs: ['resume'],
    action: 'Encolar',
    working: 'Encolando…',
    hint: 'Enter encola la instrucción; Shift+Enter inserta un salto de línea. Se entrega cuando el turno en curso termine, nunca en mitad de él.',
  },
  steer: {
    id: 'steer',
    testid: 'aq-mode-steer',
    label: 'Steer',
    why: 'dentro del turno en curso',
    needs: ['steer'],
    action: 'Steer',
    working: 'Inyectando…',
    hint: 'Enter inyecta la instrucción en el turno en curso, ya; Shift+Enter inserta un salto de línea. No pasa por la cola.',
  },
  stop_send: {
    id: 'stop_send',
    testid: 'aq-mode-stop-send',
    label: 'Detener y enviar',
    why: 'interrumpe el turno y envía como turno nuevo',
    needs: ['interrupt', 'resume'],
    action: 'Detener y enviar',
    working: 'Deteniendo…',
    hint: 'Enter pide detener el turno en curso y enviar la instrucción como turno nuevo (antes pide confirmación); Shift+Enter inserta un salto de línea.',
  },
};
const MODE_ORDER = ['queue', 'steer', 'stop_send'];

const COMMAND = { queue: queueInstruction, steer: steerAttempt, stop_send: stopAndSend };
const DONE_TEXT = {
  steer: 'Instrucción inyectada en el turno en curso.',
  stop_send: 'Turno detenido e instrucción enviada como turno nuevo.',
};
/** Errores que el Core da por RESUELTOS: repetir la misma clave repetiría el mismo fallo, así que el siguiente envío lleva clave nueva. */
const SETTLED_FAILURE = /steer_failed|stop_failed|stop_timeout|send_failed/;

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

/** Qué modos puede usar este intento ahora, con la razón del primero que falta. Sin el dato del Core no se habilita nada. */
function availability(caps, attempt) {
  if (caps.unsupported) return { reason: 'Este Core no informa de lo que ofrece cada proveedor: no se puede enviar nada.', modes: {} };
  if (!caps.snapshot) return { reason: caps.status === 'error' ? 'No se pudo comprobar lo que ofrece el proveedor: no se puede enviar nada.' : 'Comprobando lo que ofrece el proveedor…', modes: {} };
  const provider = providerOf(caps.snapshot, attempt.provider);
  const modes = {};
  for (const id of MODE_ORDER) {
    const missing = MODES[id].needs.map((need) => describeCapability(provider, need, attempt.provider)).find((info) => !info.enabled);
    modes[id] = missing ? { enabled: false, reason: missing.reason } : { enabled: true, reason: null };
  }
  return { reason: null, modes };
}

/**
 * Enviar instrucciones a un intento OCUPADO y ver su cola (LXO-151/152). El modo elegido se dice siempre y es explícito: **encolar**
 * (siguiente turno), **steer** (dentro del turno en curso) o **detener y enviar** (interrumpe y envía como turno nuevo). Un modo que el
 * proveedor no ofrece se muestra desactivado con su razón y NUNCA cae a otro en silencio. Detener y enviar pide confirmación. El
 * borrador se conserva si el Core rechaza el envío y la clave de idempotencia se reutiliza mientras el texto y el modo no cambien. El
 * dock muestra lo que el Core dice: nada se da por entregado hasta que el Core lo confirma.
 */
export function AttemptQueue({ attempt }) {
  const [draft, setDraft] = useState('');
  const [chosen, setChosen] = useState('queue');
  const [confirming, setConfirming] = useState(false);
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

  // El modo en uso: el elegido si el proveedor lo ofrece; si no, el primero que sí (nunca uno que no se eligió y se haga en silencio
  // distinto: el modo activo se ve marcado y el botón lleva su nombre).
  const { reason: unknownReason, modes } = running ? availability(caps, attempt) : { reason: null, modes: {} };
  const firstEnabled = MODE_ORDER.find((id) => modes[id]?.enabled);
  const mode = modes[chosen]?.enabled ? chosen : firstEnabled ?? chosen;
  const blocked = running && !firstEnabled
    ? unknownReason ?? `${attempt.provider} no puede recibir instrucciones con un intento en marcha: ${modes.queue?.reason ?? ''}`.trim()
    : null;
  const spec = MODES[mode];

  const body = draft.trim();
  const reset = () => { setConfirming(false); setSent(null); };
  const choose = (id) => { setChosen(id); reset(); };

  const doSend = async () => {
    if (!body || busy || blocked || !modes[mode]?.enabled) return;
    // Misma instrucción y mismo modo tras un error: misma clave (el Core devuelve el mismo resultado, no duplica). Otro texto u otro
    // modo: clave nueva.
    if (!pending.current || pending.current.body !== body || pending.current.mode !== mode) pending.current = { key: newRequestId(), body, mode };
    setBusy(true);
    setConfirming(false);
    setError(null);
    try {
      const result = await COMMAND[mode](attempt.id, pending.current.key, body);
      if (result?.status === 'Replayed') setSent(mode === 'queue' ? 'Esta instrucción ya estaba en la cola.' : 'Esta instrucción ya se había enviado.');
      else if (mode === 'queue') setSent(`Encolada${Number.isInteger(result?.position) ? ` (posición ${result.position})` : ''}: se entregará en el siguiente turno.`);
      else setSent(DONE_TEXT[mode]);
      setDraft('');
      pending.current = null;
      queue.retry?.();
    } catch (failure) {
      // El borrador se conserva: el usuario no pierde lo que escribió.
      const described = describeCommandError(failure);
      setError(described);
      if (SETTLED_FAILURE.test(described.detail)) pending.current = null;
    } finally {
      setBusy(false);
    }
  };

  // Detener y enviar interrumpe el turno en curso: antes de hacerlo se pide confirmación explícita.
  const send = () => {
    if (!body || busy || blocked) return;
    if (mode === 'stop_send' && !confirming) { setConfirming(true); return; }
    doSend();
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
    // Enter envía en el modo activo; Shift+Enter inserta un salto de línea. No se actúa mientras se compone con un IME.
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
            {MODE_ORDER.map((id) => {
              const info = modes[id];
              const enabled = Boolean(info?.enabled);
              return (
                <label key={id} className={`aq__mode${enabled ? '' : ' aq__mode--off'}`} title={enabled ? undefined : info?.reason ?? unknownReason ?? undefined}>
                  <input
                    type="radio"
                    name={`aq-mode-${attempt.id}`}
                    checked={mode === id}
                    disabled={!enabled || busy}
                    onChange={() => choose(id)}
                    aria-describedby={enabled ? undefined : `aq-why-${id}-${attempt.id}`}
                    data-testid={MODES[id].testid}
                  />
                  {MODES[id].label} <span className="aq__why" id={enabled ? undefined : `aq-why-${id}-${attempt.id}`}>{enabled ? MODES[id].why : info?.reason ?? unknownReason}</span>
                </label>
              );
            })}
          </div>
          <textarea
            className="aq__text"
            aria-label="Instrucción para el intento"
            rows={3}
            maxLength={MAX_QUEUE_CHARS}
            value={draft}
            disabled={busy || Boolean(blocked)}
            onChange={(event) => { setDraft(event.target.value); reset(); }}
            onKeyDown={onKeyDown}
            data-testid="aq-text"
          />
          <p className="aq__hint" data-testid="aq-enter-hint">{spec.hint}</p>
          {blocked && <p className="cap-note cap-note--warn" role="status" data-testid="aq-blocked">{blocked}</p>}
          {confirming && (
            <div className="ade-notice ade-notice--warn" role="alertdialog" aria-label="Confirmar detener y enviar" data-testid="aq-confirm">
              <span>Esto interrumpe el turno en curso. El Core solo enviará la instrucción cuando el proveedor confirme la parada; si no la confirma, no se envía nada y el intento sigue.</span>
              <div className="nat__actions">
                <button type="button" className="btn btn--primary btn--sm" onClick={doSend} data-testid="aq-confirm-yes">Detener y enviar</button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirming(false)} data-testid="aq-confirm-no">Cancelar</button>
              </div>
            </div>
          )}
          <div className="nat__actions">
            <button type="button" className="btn btn--primary btn--sm" disabled={busy || !body || Boolean(blocked) || confirming} onClick={send} data-testid="aq-send">{busy ? spec.working : spec.action}</button>
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
