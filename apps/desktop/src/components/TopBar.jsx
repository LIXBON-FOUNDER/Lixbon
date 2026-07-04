import React from 'react';
import { useAppStore } from '../store/appStore';
import { ConnectionBadge } from './ConnectionBadge';
import { 
  LuSlidersHorizontal, 
  LuBell, 
  LuMaximize2, 
  LuPlay,
  LuSparkles
} from 'react-icons/lu';

export function TopBar({ activeTab, setActiveTab }) {
  const { activeSection, user } = useAppStore();

  // Nombres descriptivos para la UI
  const sectionTitles = {
    terminal: 'FOLAX CLI',
    workspace: 'WORKSPACE EDITOR',
    metrics: 'METRICS & ANALYTICS',
    services: 'SERVICE RUNTIME STATUS',
    commands: 'CLI COMMAND DATABASE',
    settings: 'SYSTEM SETTINGS',
  };

  const showTerminalTabs = activeSection === 'terminal';

  return (
    <div className="topbar flex align-center justify-between">
      <div className="flex align-center gap-4">
        <div className="section-title-label">
          {sectionTitles[activeSection]}
        </div>

        {showTerminalTabs && (
          <div className="tab-group flex">
            {['Cluster', 'Logs', 'Metrics'].map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab.toLowerCase())}
                className={`tab-btn ${activeTab === tab.toLowerCase() ? 'active' : ''}`}
              >
                {tab}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex align-center gap-4">
        <ConnectionBadge />

        <div className="actions flex align-center gap-2">
          <button className="action-icon-btn" title="Pantalla completa">
            <LuMaximize2 size={16} />
          </button>
          <button className="action-icon-btn" title="Ajustes rápidos">
            <LuSlidersHorizontal size={16} />
          </button>
          <button className="action-icon-btn" title="Notificaciones">
            <LuBell size={16} />
          </button>
          
          <button 
            onClick={() => window.dispatchEvent(new CustomEvent('execute-command-click'))}
            className="btn-execute flex align-center gap-2"
          >
            <LuPlay size={12} fill="currentColor" />
            <span>Execute</span>
          </button>
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .topbar {
          height: var(--header-height);
          background-color: var(--bg-secondary);
          border-bottom: 1px solid var(--border);
          padding: 0 24px;
        }
        .section-title-label {
          font-family: var(--font-mono);
          font-size: 1.1rem;
          font-weight: 700;
          color: #ffffff;
          letter-spacing: 0.05em;
        }
        .light-theme .section-title-label {
          color: var(--text-primary);
        }
        .tab-group {
          margin-left: 24px;
          border-bottom: 2px solid transparent;
          gap: 16px;
        }
        .tab-btn {
          font-size: 0.85rem;
          color: var(--text-secondary);
          padding: 6px 4px;
          cursor: pointer;
          transition: all 0.2s;
          font-weight: 500;
          position: relative;
        }
        .tab-btn:hover {
          color: #ffffff;
        }
        .light-theme .tab-btn:hover {
          color: var(--text-primary);
        }
        .tab-btn.active {
          color: var(--accent);
          font-weight: 600;
        }
        .tab-btn.active::after {
          content: '';
          position: absolute;
          bottom: -15px;
          left: 0;
          width: 100%;
          height: 2px;
          background-color: var(--accent);
        }
        .action-icon-btn {
          color: var(--text-secondary);
          cursor: pointer;
          padding: 8px;
          border-radius: 4px;
          transition: all 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .action-icon-btn:hover {
          color: #ffffff;
          background-color: var(--bg-surface);
        }
        .light-theme .action-icon-btn:hover {
          color: var(--text-primary);
        }
        .btn-execute {
          background-color: var(--accent);
          color: #ffffff;
          font-weight: 600;
          font-size: 0.8rem;
          padding: 8px 16px;
          border-radius: 4px;
          cursor: pointer;
          transition: opacity 0.2s;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .btn-execute:hover {
          opacity: 0.9;
        }
      `}} />
    </div>
  );
}
