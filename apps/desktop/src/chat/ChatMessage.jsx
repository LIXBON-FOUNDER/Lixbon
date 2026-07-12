// ChatMessage.jsx — una burbuja del chat (usuario / asistente / error).
// Las filas de herramienta se agrupan aparte en ToolGroup (las llama ChatPanel).
import { ChatMarkdown } from './ChatMarkdown';
import { IconGlobe, IconFileCode } from '../components/Icons';

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

  return (
    <div className="msg msg--assistant">
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
        <ChatMarkdown>{message.content}</ChatMarkdown>
      ) : message.vision ? (
        <span className="msg__thinking">👁 Analizando la imagen…</span>
      ) : message.generating ? (
        <span className="msg__thinking">
          ✍️ Generando cambio… ({(message.generating / 1000).toFixed(1)}k caracteres)
        </span>
      ) : (
        streaming && <span className="msg__thinking">Pensando…</span>
      )}
    </div>
  );
}
