// ChatMessage.jsx — una burbuja del chat (usuario / asistente / error / herramienta).
import { ChatMarkdown } from './ChatMarkdown';
import { useChatStore } from '../store/chatStore';
import { IconGlobe, IconFileCode } from '../components/Icons';

export function ChatMessage({ message, index, streaming }) {
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
    const change = message.change;
    const hasDiff = change && (change.sampleOld?.length > 0 || change.sampleNew?.length > 0);
    const hiddenLines = change
      ? Math.max(0, change.removed - (change.sampleOld?.length || 0)) +
        Math.max(0, change.added - (change.sampleNew?.length || 0))
      : 0;
    return (
      <details className={`msg msg--toolrow ${failed ? 'is-err' : ''}`}>
        <summary className="toolrow__summary">
          <span className="toolrow__dot" aria-hidden>●</span>
          <span className="toolrow__name">{message.tool}</span>
          {target && <span className="toolrow__target">{target}</span>}
          {change && (change.added > 0 || change.removed > 0) && (
            <span className="toolrow__counts">
              {change.added > 0 && <em className="toolrow__add">+{change.added}</em>}
              {change.removed > 0 && <em className="toolrow__del">−{change.removed}</em>}
            </span>
          )}
          {failed && <span className="toolrow__err">{message.content}</span>}
        </summary>
        <div className="toolrow__body">
          {hasDiff && (
            <pre className="toolrow__diff">
              {change.sampleOld.map((line, i) => (
                <span key={`o${i}`} className="diffline diffline--del">- {line}{'\n'}</span>
              ))}
              {change.sampleNew.map((line, i) => (
                <span key={`n${i}`} className="diffline diffline--add">+ {line}{'\n'}</span>
              ))}
              {hiddenLines > 0 && (
                <span className="diffline diffline--more">… +{hiddenLines} líneas más{'\n'}</span>
              )}
            </pre>
          )}
          {!failed && message.content && <p className="toolrow__result">{message.content}</p>}
          {message.snapshot && !failed && (
            <button
              className="toolrow__revert"
              disabled={message.reverted}
              onClick={(e) => {
                e.preventDefault();
                useChatStore.getState().revertTool(index);
              }}
              title="Deshace este cambio en el disco (checkpoint)"
            >
              {message.reverted ? 'Revertido ✓' : 'Revertir este cambio'}
            </button>
          )}
        </div>
      </details>
    );
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
      ) : (
        streaming && <span className="msg__thinking">Pensando…</span>
      )}
    </div>
  );
}
