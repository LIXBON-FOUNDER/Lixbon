import { useState } from 'react';
import { answerQuestion, describeCommandError } from './attemptCommands';

/**
 * Responder la pregunta abierta de un agente desde el ADE. Solo una hija pregunta (a su padre): la respuesta la manda la
 * persona EN NOMBRE del destinatario de la pregunta, y así se dice antes de enviar. Va por `reply` con la identidad autenticada
 * de Desktop; el Core vuelve a comprobar que la pregunta existe y no tiene ya respuesta. Tras enviar se pide al detalle que
 * vuelva a leer.
 */
export const MAX_ANSWER_CHARS = 4000;

export function AnswerQuestion({ question, onAnswered }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  const id = question?.id;
  if (!Number.isSafeInteger(id)) return null;

  const body = text.trim();
  const send = async () => {
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await answerQuestion(id, body);
      setSent(true);
      setOpen(false);
      onAnswered?.();
    } catch (failure) {
      setError(describeCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  if (sent) return <p className="twk__hint" role="status" data-testid="answer-sent">Respuesta enviada.</p>;
  return (
    <div className="twk__answer" data-testid={`answer-${id}`}>
      {!open ? (
        <button type="button" className="twk__action" onClick={() => setOpen(true)} data-testid="answer-open">Responder</button>
      ) : (
        <>
          <p className="twk__hint">Respondes como <code className="twk__mono">{question.to}</code>: le llega a <code className="twk__mono">{question.from}</code>.</p>
          <textarea
            className="twk__answer-text"
            aria-label={`Respuesta a la pregunta ${id}`}
            rows={3}
            maxLength={MAX_ANSWER_CHARS}
            value={text}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
            data-testid="answer-text"
          />
          <div className="twk__answer-actions">
            <button type="button" className="twk__action" disabled={busy || !body} onClick={send} data-testid="answer-send">{busy ? 'Enviando…' : 'Enviar respuesta'}</button>
            <button type="button" className="twk__action" disabled={busy} onClick={() => { setOpen(false); setError(null); }}>Cancelar</button>
          </div>
        </>
      )}
      {error && (
        <div className="ade-notice ade-notice--error" role="alert" data-testid="answer-error">
          <span>{error.message}</span>
          {error.detail !== error.message && (
            <details><summary>Detalle técnico</summary><code>{error.detail}</code></details>
          )}
        </div>
      )}
    </div>
  );
}
