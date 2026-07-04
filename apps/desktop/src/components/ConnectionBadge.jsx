import React from 'react';
import { useAppStore } from '../store/appStore';

export function ConnectionBadge() {
  const { connectionStatus, latency, serverUrl } = useAppStore();

  let text = 'Disconnected';
  let color = 'var(--status-error)';
  let dotClass = 'disconnected';

  if (connectionStatus === 'connected') {
    text = `Connected — ${latency}ms`;
    color = 'var(--status-ok)';
    dotClass = 'connected';
  } else if (connectionStatus === 'connecting') {
    text = 'Connecting...';
    color = 'var(--status-warn)';
    dotClass = 'connecting';
  }

  return (
    <div className="connection-badge flex align-center gap-2" style={{ color }} title={serverUrl}>
      <span className={`status-dot ${dotClass}`}></span>
      <span>{text}</span>

      <style dangerouslySetInnerHTML={{ __html: `
        .connection-badge {
          font-family: var(--font-mono);
          font-size: 0.75rem;
          font-weight: 500;
          background-color: var(--bg-surface);
          padding: 6px 12px;
          border-radius: 20px;
          border: 1px solid var(--border);
        }
        .status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          display: inline-block;
        }
        .status-dot.connected {
          background-color: var(--status-ok);
          box-shadow: 0 0 8px var(--status-ok);
        }
        .status-dot.connecting {
          background-color: var(--status-warn);
          animation: pulse 1.5s infinite;
        }
        .status-dot.disconnected {
          background-color: var(--status-error);
          box-shadow: 0 0 8px var(--status-error);
        }

        @keyframes pulse {
          0% { opacity: 0.3; }
          50% { opacity: 1; }
          100% { opacity: 0.3; }
        }
      `}} />
    </div>
  );
}
