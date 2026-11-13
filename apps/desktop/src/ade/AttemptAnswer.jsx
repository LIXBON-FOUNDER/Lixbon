import { useCallback, useEffect, useRef, useState } from 'react';
import { answerProviderRequest, describeCommandError, pendingProviderRequests } from './attemptCommands';

/** El Core admite hasta 4 000 caracteres en la respuesta a una pregunta. */
export const MAX_ANSWER_CHARS = 4000;
/** Mientras el intento espera, la lista se relee a menudo: una petición nueva o ya respondida desde otro sitio cambia sola. */
const POLL_MS = 3000;

const KIND_LABEL = Object.freeze({ permission: 'Permiso', question: 'Pregunta' });

function ErrorNotice({ error, testId }) {
  return (
    <div className="ade-notice ade-notice--error" role="alert" data-testid={testId}>
      <span>{error.message}</span>
      {error.detail !== error.message && (
        <details><summary>Detalle técnico</summary><code>{error.detail}</code></details>
      )}
    </div>
  );
}

/**
 * LXO-247 · Responder a lo que el proveedor le pide a la persona mientras el intento espera (`awaiting_terminal_approval`): un permiso
 * (permitir o denegar) o una pregunta (texto libre). Lo que se muestra es lo que el Core ya acotó y redactó (`attempt_pending_requests`);
 * aquí no se decide nada: el Core valida la respuesta, se la entrega al proveedor y, con la última, el intento vuelve a correr. Si el
 * proveedor no la acepta, la petición sigue pendiente y se puede reintentar. Todo es texto, nunca HTML ni enlaces.
 */
export function AttemptAnswer({ attemptId, onAnswered }) {
  const [state, setState] = useState({ requests: null, live: true, error: null });
  const [drafts, setDrafts] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [failures, setFailures] = useState({});
  const [sent, setSent] = useState({});
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const result = await pendingProviderRequests(attemptId);
      if (!alive.current) return;
      setState({ requests: Array.isArray(result?.requests) ? result.requests : [], live: result?.live !== false, error: null });
    } catch (failure) {
      if (alive.current) setState((current) => ({ ...current, error: describeCommandError(failure) }));
    }
  }, [attemptId]);

  useEffect(() => {
    alive.current = true;
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { alive.current = false; clearInterval(timer); };
  }, [load]);

  const send = async (request, answer, options) => {
    const id = request.request_id;
    setBusyId(id);
    setFailures((current) => ({ ...current, [id]: null }));
    try {
      const result = await answerProviderRequest(attemptId, id, answer, options);
      if (!alive.current) return;
      setSent((current) => ({ ...current, [id]: result?.status === 'Replayed' ? 'Ya estaba respondida.' : 'Respuesta enviada al proveedor.' }));
      onAnswered?.(result);
    } catch (failure) {
      if (alive.current) setFailures((current) => ({ ...current, [id]: describeCommandError(failure) }));
    } finally {
      if (alive.current) setBusyId(null);
      load();
    }
  };

  const { requests, live, error } = state;
  const answeredNow = Object.keys(sent);

  return (
    <div className="nat-answer" role="group" aria-label="Responder al proveedor" data-testid="attempt-answer">
      <p className="nat__hint">El proveedor espera tu respuesta. Si no respondes dentro del plazo, el intento se detiene.</p>
      {requests === null && !error && <p role="status">Leyendo lo que el proveedor espera.</p>}
      {error && <ErrorNotice error={error} testId="attempt-answer-load-error" />}
      {requests !== null && requests.length === 0 && answeredNow.length === 0 && (
        <p role="status" className="ade-missing" data-testid="attempt-answer-empty">
          {live ? 'El proveedor no tiene ninguna petición pendiente ahora mismo.' : 'Ya no hay una ejecución viva a la que responder.'}
        </p>
      )}
      {(requests ?? []).map((request) => {
        const id = request.request_id;
        const isPermission = request.kind === 'permission';
        const draft = drafts[id] ?? '';
        const busy = busyId === id;
        return (
          <section key={id} className="nat-answer__request" aria-label={`${KIND_LABEL[request.kind] ?? 'Petición'} del proveedor`} data-testid="attempt-answer-request" data-request-id={id} data-kind={request.kind}>
            <h5 className="nat-answer__title">{KIND_LABEL[request.kind] ?? 'Petición'}</h5>
            {isPermission ? (
              <p className="nat-answer__subject">Quiere usar <code className="mono">{request.subject}</code>{request.summary ? <>: <span>{request.summary}</span></> : null}</p>
            ) : (
              <p className="nat-answer__subject">{request.subject}</p>
            )}
            {isPermission ? (
              <div className="nat__actions">
                <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => send(request, 'allow', { confirm: true })} data-testid="attempt-answer-allow">Permitir</button>
                <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => send(request, 'deny')} data-testid="attempt-answer-deny">Denegar</button>
              </div>
            ) : (
              <>
                <label className="nat-answer__label">
                  Tu respuesta
                  <textarea
                    className="nat-answer__text"
                    rows={3}
                    maxLength={MAX_ANSWER_CHARS}
                    value={draft}
                    disabled={busy}
                    onChange={(event) => setDrafts((current) => ({ ...current, [id]: event.target.value }))}
                    data-testid="attempt-answer-text"
                  />
                </label>
                <div className="nat__actions">
                  <button type="button" className="btn btn--primary btn--sm" disabled={busy || !draft.trim()} onClick={() => send(request, draft)} data-testid="attempt-answer-send">{busy ? 'Enviando…' : 'Responder'}</button>
                </div>
              </>
            )}
            {failures[id] && <ErrorNotice error={failures[id]} testId="attempt-answer-error" />}
          </section>
        );
      })}
      {answeredNow.length > 0 && (
        <p role="status" data-testid="attempt-answer-outcome">{sent[answeredNow[answeredNow.length - 1]]}</p>
      )}
    </div>
  );
}
