// ChatMessage.jsx — una burbuja del chat (usuario / asistente / error).
// Las filas de herramienta se agrupan aparte en ToolGroup (las llama ChatPanel).
import { ChatMarkdown } from './ChatMarkdown';
import { IconGlobe, IconFileCode } from '../components/Icons';

/** Línea "en vivo" del agente entre acciones: punto pulsante + texto mono +
    cursor parpadeante, como la última línea del mockup. */
function LiveStatus({ text }) {
  return (
    <div className="msg__live">
      <span className="activity-row__dot" aria-hidden />
      <span className="msg__live-text">{text}</span>
      <span className="msg__caret" aria-hidden="true" />
    </div>
  );
}

export function ChatMessage({ message, streaming }) {
  if (message.role === 'user') {
    return (
      <div className="msg msg--user">
        {message.context && (
          <span className="msg__ctx" title="Se adjuntó como contexto">
            <IconFileCode size={12} />
            {message.context.name}
            {message.context.selection ? ' (selección)' : ''}
          </span>
        )}
        {message.images?.length > 0 && (
          <div className="msg__images">
            {message.images.map((src, i) => (
              <img key={i} src={src} alt={`adjunto ${i + 1}`} />
            ))}
          </div>
        )}
        {message.content}
      </div>
    );
  }

  if (message.role === 'error') {
    return <div className="msg msg--error">{message.content}</div>;
  }

  // Aviso del propio IDE (contexto recortado, tope de pasos…): no es del
  // modelo ni un error, pero el usuario tiene que verlo — sin esto el agente
  // se paraba y no había ninguna pista de por qué.
  if (message.role === 'note') {
    return <div className="msg msg--note">{message.content}</div>;
  }

  return (
    <div className="msg msg--assistant">
      <div className="msg__agent">
        <img src="/favicon.svg" alt="" className="msg__agent-logo" draggable={false} />
        <span className="msg__agent-name">Agente</span>
      </div>
      {message.thinking && (
        <details className="msg-think">
          <summary className="msg-think__summary">✻ Pensamiento</summary>
          <div className="msg-think__body">{message.thinking}</div>
        </details>
      )}
      {message.sources?.length > 0 && (
        <div className="msg-sources">
          <span className="msg-sources__title"><IconGlobe size={13} /> Fuentes</span>
          <ol className="msg-sources__list">
            {message.sources.map((s, i) => (
              <li key={i}><a href={s.url} target="_blank" rel="noreferrer">{s.title || s.url}</a></li>
            ))}
          </ol>
        </div>
      )}
      {message.content ? (
        <>
          <ChatMarkdown>{message.content}</ChatMarkdown>
          {streaming && <span className="msg__caret" aria-hidden="true" />}
        </>
      ) : message.vision ? (
        <LiveStatus text="Analizando la imagen…" />
      ) : message.generating ? (
        <LiveStatus text={`Generando cambio… (${(message.generating / 1000).toFixed(1)}k caracteres)`} />
      ) : (
        streaming && <LiveStatus text="Pensando…" />
      )}
    </div>
  );
}
