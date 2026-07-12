// ChatPanel.jsx — panel derecho del IDE: conversación con streaming + historial.
import { useEffect, useRef } from 'react';
import { useChatStore } from '../store/chatStore';
import { ChatMessage } from './ChatMessage';
import { ChatInputBar } from './ChatInputBar';
import { ApprovalCard } from './ApprovalCard';
import { HistoryList } from './HistoryList';
import { IconPlus, IconChevron, IconDots } from '../components/Icons';

export function ChatPanel() {
  const { messages, streaming, view, setView, newConversation } = useChatStore();
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
        <span className="chatpanel__title">Chat</span>
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
              messages.map((m, i) => (
                <ChatMessage
                  key={i}
                  message={m}
                  index={i}
                  streaming={streaming && i === messages.length - 1}
                />
              ))
            )}
          </div>
          <ApprovalCard />
          <ChatInputBar />
        </>
      )}
    </div>
  );
}
