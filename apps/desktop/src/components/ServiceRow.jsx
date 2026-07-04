import React from 'react';
import { LuCircleCheck, LuTriangleAlert, LuCircleX, LuCpu } from 'react-icons/lu';

export function ServiceRow({ name, status, details, latency }) {
  let icon = <LuCircleX size={18} style={{ color: 'var(--status-error)' }} />;
  let badgeText = 'Offline';
  let badgeColor = 'rgba(239, 68, 68, 0.1)';
  let textColor = 'var(--status-error)';

  if (status === 'online') {
    icon = <LuCircleCheck size={18} style={{ color: 'var(--status-ok)' }} />;
    badgeText = 'Online';
    badgeColor = 'rgba(34, 197, 94, 0.1)';
    textColor = 'var(--status-ok)';
  } else if (status === 'degraded') {
    icon = <LuTriangleAlert size={18} style={{ color: 'var(--status-warn)' }} />;
    badgeText = 'Degraded';
    badgeColor = 'rgba(245, 158, 11, 0.1)';
    textColor = 'var(--status-warn)';
  }

  return (
    <div className="service-row flex align-center justify-between">
      <div className="flex align-center gap-4">
        {icon}
        <div className="flex flex-col">
          <span className="service-name font-mono">{name}</span>
          <span className="service-details">{details}</span>
        </div>
      </div>

      <div className="flex align-center gap-4">
        {latency !== undefined && latency > 0 && (
          <span className="service-latency font-mono">{latency}ms</span>
        )}
        <div className="status-badge" style={{ backgroundColor: badgeColor, color: textColor }}>
          {badgeText.toUpperCase()}
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .service-row {
          background-color: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 16px 20px;
          margin-bottom: 12px;
          transition: border-color 0.2s;
        }
        .service-row:hover {
          border-color: var(--border-focus);
        }
        .service-name {
          font-weight: 700;
          color: #fff;
          font-size: 0.9rem;
        }
        .light-theme .service-name {
          color: var(--text-primary);
        }
        .service-details {
          font-size: 0.75rem;
          color: var(--text-secondary);
          margin-top: 2px;
        }
        .service-latency {
          font-size: 0.75rem;
          color: var(--text-muted);
        }
        .status-badge {
          font-size: 0.7rem;
          font-weight: 700;
          padding: 4px 10px;
          border-radius: 4px;
          letter-spacing: 0.05em;
        }
      `}} />
    </div>
  );
}
