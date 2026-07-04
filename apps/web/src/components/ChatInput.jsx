// ChatInput.jsx — caja de input del chat (fondo crema, pill, mockups 2.1–2.2).
// Micrófono: oculto en v1 (decisión). Adjuntar/web: decorativos por ahora.
import { useRef } from 'react';
import { IconClip, IconGlobe, IconSend } from './Icons';

export function ChatInput({ onSend, busy, models, model, onModelChange }) {
  const ref = useRef(null);

  const send = () => {
    const text = ref.current.value.trim();
    if (!text || busy) return;
    ref.current.value = '';
    ref.current.style.height = 'auto';
    onSend(text);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const autoGrow = (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
  };

  return (
    <div className="chat-input">
      <textarea
        ref={ref}
        className="chat-input__text"
        placeholder="Pregunta lo que quieras"
        rows={1}
        onKeyDown={onKeyDown}
        onInput={autoGrow}
        aria-label="Mensaje"
      />
      <div className="chat-input__bar">
        <div className="chat-input__left">
          <button className="icon-btn" type="button" title="Adjuntar (próximamente)" disabled>
            <IconClip />
          </button>
          <button className="icon-btn" type="button" title="Buscar en la web (próximamente)" disabled>
            <IconGlobe />
          </button>
          {models.length > 0 && (
            <select
              className="chat-input__model"
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
              aria-label="Modelo"
            >
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          )}
        </div>
        <button
          className="chat-input__send"
          type="button"
          onClick={send}
          disabled={busy}
          aria-label="Enviar"
        >
          <IconSend size={16} />
        </button>
      </div>
    </div>
  );
}
