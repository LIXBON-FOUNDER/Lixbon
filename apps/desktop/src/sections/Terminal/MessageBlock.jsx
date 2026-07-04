import React from 'react';

export function MessageBlock({ message }) {
  const { role, content, type } = message;

  if (role === 'system') {
    let color = 'var(--text-secondary)';
    let prefix = '';

    if (type === 'welcome') {
      return (
        <div className="msg-block system welcome-block font-mono">
          {content}
        </div>
      );
    }

    if (type === 'ok') {
      color = 'var(--text-terminal)';
      prefix = '';
    } else if (type === 'error') {
      color = 'var(--text-error)';
      prefix = '';
    } else if (type === 'info') {
      color = 'var(--text-info)';
      prefix = '';
    }

    return (
      <div className="msg-block system font-mono" style={{ color }}>
        {prefix}{content}
      </div>
    );
  }

  if (role === 'user') {
    return (
      <div className="msg-block user font-mono">
        <span className="prompt-symbol">&gt;</span> {content}
      </div>
    );
  }

  // Assistant response
  return (
    <div className="msg-block assistant">
      <div className="assistant-content">{content}</div>
    </div>
  );
}
