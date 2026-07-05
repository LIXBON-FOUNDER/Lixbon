// ChatMessage.jsx — una burbuja del chat (usuario / asistente / error).
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
        {message.content}
      </div>
    );
  }

  if (message.role === 'error') {
    return <div className="msg msg--error">{message.content}</div>;
  }

  return (
    <div className="msg msg--assistant">
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
      ) : (
        streaming && <span className="msg__thinking">Pensando…</span>
      )}
    </div>
  );
}
