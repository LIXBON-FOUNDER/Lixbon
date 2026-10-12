// InlineAnswer.jsx — campo para responder a la pregunta pendiente de un intento (intent answer_question).
import { useState } from 'react';
import { ActionButton } from './ActionButton';

export function InlineAnswer({ attemptId, onDone }) {
  const [texto, setTexto] = useState('');
  return (
    <form className="ade-answer" onSubmit={(e) => e.preventDefault()} aria-label="Responder al agente">
      <label className="ade-sr" htmlFor={`resp-${attemptId}`}>Tu respuesta</label>
      <input
        id={`resp-${attemptId}`} className="field ade-answer__input" value={texto} onChange={(e) => setTexto(e.target.value)}
        placeholder="Escribe tu respuesta…"
      />
      <ActionButton
        intent="answer_question" args={{ attemptId, text: texto }} label="Enviar respuesta" variant="primary" disabled={!texto.trim()}
        onDone={(r) => { if (r.ok) { setTexto(''); onDone?.(); } }}
      />
    </form>
  );
}
