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

  if (message.role === 'tool') {
    const a = message.args || {};
    const target = a.path || a.pattern || (a.src ? `${a.src} → ${a.dst}` : '');
    const failed = message.ok === false;
    return (
      <div className={`msg msg--toolrow ${failed ? 'is-err' : ''}`} title={message.content}>
        <span className="toolrow__dot" aria-hidden>●</span>
        <span className="toolrow__name">{message.tool}</span>
        {target && <span className="toolrow__target">{target}</span>}
        {message.change && (message.change.added > 0 || message.change.removed > 0) && (
          <span className="toolrow__counts">
            {message.change.added > 0 && <em className="toolrow__add">+{message.change.added}</em>}
            {message.change.removed > 0 && <em className="toolrow__del">−{message.change.removed}</em>}
          </span>
        )}
        {failed && <span className="toolrow__err">{message.content}</span>}
      </div>
    );
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
