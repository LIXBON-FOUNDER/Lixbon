// ClaudeDock.jsx — lo que Claude Code tiene pendiente sobre la caja: los
// mensajes en cola mientras trabaja y la respuesta de /btw.
import { useEffect } from 'react';
import { useChatStore } from '../store/chatStore';
import { ChatMarkdown } from './ChatMarkdown';
import { IconX, IconPencil } from '../components/Icons';

function BtwCard({ btw, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="ccdock__btw" role="status">
      <div className="ccdock__head">
        <span className="ccdock__tag">/btw</span>
        <span className="ccdock__question">{btw.question}</span>
        <button className="ic ccdock__close" onClick={onClose} title="Cerrar (Esc)"><IconX size={12} /></button>
      </div>
      <div className="ccdock__answer">
        {btw.error ? <p className="ccdock__error">{btw.error}</p>
          : btw.answer ? <ChatMarkdown>{btw.answer}</ChatMarkdown>
            : <span className="ccdock__wait">Pensando la respuesta<span className="ccdock__dots" /></span>}
      </div>
      <div className="ccdock__foot">Al margen: no entra en la conversación ni interrumpe a Claude · Esc para cerrar</div>
    </div>
  );
}

export function ClaudeDock() {
  const queue = useChatStore((s) => s.ccQueue);
  const btw = useChatStore((s) => s.ccBtw);
  const closeBtw = useChatStore((s) => s.closeBtw);
  const unqueue = useChatStore((s) => s.unqueue);
  if (!btw && !queue?.length) return null;

  return (
    <div className="ccdock">
      {btw && <BtwCard btw={btw} onClose={closeBtw} />}
      {queue?.length > 0 && (
        <div className="ccdock__queue">
          <div className="ccdock__label">En cola · {queue.length}</div>
          {queue.map((q) => (
            <div key={q.uuid} className={`ccdock__item${q.command ? ' ccdock__item--cmd' : ''}${q.sent ? ' is-sent' : ''}`}>
              <span className="ccdock__text">{q.shown.content || '(imagen)'}</span>
              <span className="ccdock__when">{q.sent ? 'entregado, Claude lo lee ahora' : q.command ? 'al terminar el turno' : 'en la próxima pausa'}</span>
              {!q.sent && (
                <span className="ccdock__acts">
                  <button className="ic" onClick={() => unqueue(q.uuid, true)} title="Editar (vuelve a la caja)"><IconPencil size={12} /></button>
                  <button className="ic" onClick={() => unqueue(q.uuid)} title="Quitar de la cola"><IconX size={12} /></button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
