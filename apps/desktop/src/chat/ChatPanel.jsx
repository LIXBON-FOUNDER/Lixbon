// ChatPanel.jsx — panel derecho del IDE: conversación con streaming + historial.
import { useEffect, useRef } from 'react';
import { useChatStore } from '../store/chatStore';
import { ChatMessage } from './ChatMessage';
import { ToolGroup } from './ToolGroup';
import { ChatInputBar } from './ChatInputBar';
import { ApprovalCard } from './ApprovalCard';
import { HistoryList } from './HistoryList';

/** Agrupa las filas de herramienta CONSECUTIVAS en un ToolGroup plegable;
    el resto se renderiza como mensajes normales. */
function renderMessages(messages, streaming) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') {
      const start = i;
      const run = [];
      while (i < messages.length && messages[i].role === 'tool') { run.push(messages[i]); i++; }
      i--; // el for vuelve a incrementar
      out.push(<ToolGroup key={`g${start}`} messages={run} startIndex={start} />);
    } else {
      out.push(
        <ChatMessage
          key={i}
          message={messages[i]}
          index={i}
          streaming={streaming && i === messages.length - 1}
        />,
      );
    }
  }
  return out;
}
import { IconPlus, IconChevron, IconDots } from '../components/Icons';

export function ChatPanel() {
  const { messages, streaming, view, setView, newConversation, conversationTitle } = useChatStore();
  const feedRef = useRef(null);
  const stickToBottom = useRef(true);

  // Autoscroll solo si el usuario ya estaba abajo
  useEffect(() => {
    const el = feedRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const onScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  return (
    <div className="chatpanel">
      <div className="chatpanel__header">
        {/* La conversación se titula sola tras el primer intercambio: verlo
            aquí evita el "¿cuál de todas era esta?" al volver del historial. */}
        <span className="chatpanel__title" title={conversationTitle || 'Chat'}>
          {view === 'history' ? 'Historial' : conversationTitle || 'Chat'}
        </span>
        <span className="chatpanel__actions">
          <button className="icon-btn" title="Nueva conversación" onClick={newConversation}>
            <IconPlus size={16} />
          </button>
          <button
            className={`icon-btn ${view === 'history' ? 'is-active' : ''}`}
            title={view === 'history' ? 'Volver al chat' : 'Historial'}
            onClick={() => setView(view === 'history' ? 'chat' : 'history')}
          >
            {view === 'history' ? <IconChevron size={16} open /> : <IconDots size={16} />}
          </button>
        </span>
      </div>

      {view === 'history' ? (
        <HistoryList />
      ) : (
        <>
          <div className="chatpanel__feed" ref={feedRef} onScroll={onScroll}>
            {messages.length === 0 ? (
              <div className="chatpanel__empty">
                <p>¿En qué trabajamos hoy?</p>
                <p className="chatpanel__empty-hint">
                  Con el agente activo, el modelo puede crear y editar archivos de tu
                  carpeta de trabajo (cada cambio te pide aprobación). El archivo abierto
                  se adjunta como contexto automáticamente.
                </p>
              </div>
            ) : (
              renderMessages(messages, streaming)
            )}
          </div>
          <ApprovalCard />
          <ChatInputBar />
        </>
      )}
    </div>
  );
}
