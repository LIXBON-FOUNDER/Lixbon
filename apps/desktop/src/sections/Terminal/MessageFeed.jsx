import React, { useEffect, useRef } from 'react';
import { MessageBlock } from './MessageBlock';

export function MessageFeed({ messages, isLoading }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading]);

  return (
    <div className="message-feed flex flex-col gap-4">
      {messages.map((msg, index) => (
        <MessageBlock key={index} message={msg} />
      ))}
      
      {isLoading && (
        <div className="msg-block system loading-indicator font-mono">
          <span className="cursor-dot"></span>
          <span>Cargando respuesta clúster...</span>
        </div>
      )}
      
      <div ref={bottomRef} />

      <style dangerouslySetInnerHTML={{ __html: `
        .message-feed {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .msg-block {
          line-height: 1.6;
          font-size: var(--font-size-terminal);
        }
        .msg-block.system {
          white-space: pre-wrap;
        }
        .msg-block.welcome-block {
          background-color: rgba(255, 255, 255, 0.02);
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 16px;
          color: var(--text-secondary);
        }
        .msg-block.user {
          color: var(--text-prompt);
          font-weight: 500;
        }
        .prompt-symbol {
          color: var(--accent);
          font-weight: 700;
        }
        .msg-block.assistant {
          color: var(--text-primary);
          padding: 8px 12px;
          background-color: rgba(255, 255, 255, 0.01);
          border-left: 2px solid var(--border);
          border-radius: 0 4px 4px 0;
        }
        .assistant-content {
          white-space: pre-wrap;
        }
        .loading-indicator {
          display: flex;
          align-items: center;
          gap: 8px;
          color: var(--text-secondary);
        }
        .cursor-dot {
          width: 8px;
          height: 14px;
          background-color: var(--accent);
          animation: blink 1s step-end infinite;
          display: inline-block;
        }

        @keyframes blink {
          50% { opacity: 0; }
        }
      `}} />
    </div>
  );
}
