// ChatPanel.jsx — panel central: conversación con streaming. El historial
// vive siempre visible en el sidebar (Recientes); nueva conversación es
// Ctrl+N o /clear — aquí no hay cabecera flotante, como en el diseño.
import { useEffect, useRef } from 'react';
import { useChatStore } from '../store/chatStore';
import { ChatMessage } from './ChatMessage';
import { ToolGroup } from './ToolGroup';
import { ChatInputBar } from './ChatInputBar';
import { ApprovalCard } from './ApprovalCard';

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
export function ChatPanel() {
  const { messages, streaming } = useChatStore();
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
      <div className="chatpanel__feed" ref={feedRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <div className="chatpanel__empty">
            <p>¿En qué trabajamos hoy?</p>
            <p className="chatpanel__empty-hint">
              Con el agente activo, el modelo puede crear y editar archivos de tu
              carpeta de trabajo (cada cambio te pide aprobación). Menciona un
              archivo con @ para dárselo como referencia.
            </p>
          </div>
        ) : (
          renderMessages(messages, streaming)
        )}
      </div>
      <ApprovalCard />
      <ChatInputBar />
    </div>
  );
}
