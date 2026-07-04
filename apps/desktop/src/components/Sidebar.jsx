import React from 'react';
import { useAppStore } from '../store/appStore';
import { useVersion } from '../hooks/useVersion';
import { 
  LuTerminal, 
  LuTrendingUp, 
  LuServer, 
  LuCommand, 
  LuSettings,
  LuPlus,
  LuLogOut,
  LuTrash2,
  LuFolderOpen
} from 'react-icons/lu';

export function Sidebar() {
  const { activeSection, setActiveSection, connectionStatus, user, logout } = useAppStore();
  const { currentVersion } = useVersion();

  const menuItems = [
    { id: 'terminal', label: 'TERMINAL', icon: LuTerminal },
    { id: 'workspace', label: 'WORKSPACE', icon: LuFolderOpen },
    { id: 'metrics', label: 'METRICS', icon: LuTrendingUp },
    { id: 'services', label: 'SERVICES', icon: LuServer },
    { id: 'commands', label: 'COMMANDS', icon: LuCommand },
    { id: 'settings', label: 'SETTINGS', icon: LuSettings },
  ];

  return (
    <div className="sidebar flex flex-col justify-between">
      <div className="flex flex-col">
        <div className="brand-section">
          <div className="brand-title">FOLAX IDE</div>
          <div className="brand-sub">
            <span className="dot"></span> v{currentVersion} CLUSTER_ID:090
          </div>
        </div>

        <nav className="nav-menu">
          {menuItems.map((item) => {
            const Icon = item.icon;
            
            if (item.id === 'workspace') {
              const isActive = useAppStore.getState().isWorkspaceVisible;
              return (
                <button
                  key={item.id}
                  onClick={() => useAppStore.getState().toggleWorkspace()}
                  className={`nav-item flex align-center gap-2 ${isActive ? 'active' : ''}`}
                >
                  <Icon size={16} />
                  <span>{item.label}</span>
                </button>
              );
            }

            const isActive = activeSection === item.id || (item.id === 'terminal' && activeSection === 'editor');
            return (
              <button
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                className={`nav-item flex align-center gap-2 ${isActive ? 'active' : ''}`}
              >
                <Icon size={16} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <div className="sidebar-footer flex flex-col gap-2">
        <button 
          onClick={() => {
            // Desencadenar una nueva sesión de chat en el Terminal
            window.dispatchEvent(new CustomEvent('new-session-click'));
          }}
          className="btn-deploy flex align-center justify-center gap-2"
        >
          <LuPlus size={16} />
          <span>NEW SESSION</span>
        </button>

        <div className="footer-actions flex align-center justify-between">
          <button 
            onClick={() => window.dispatchEvent(new CustomEvent('clear-terminal-click'))}
            className="footer-btn flex align-center gap-2"
            title="Limpia la pantalla del terminal"
          >
            <LuTrash2 size={14} />
            <span>Clear</span>
          </button>
          
          {user && (
            <button 
              onClick={logout}
              className="footer-btn flex align-center gap-2"
              title="Cerrar sesión"
            >
              <LuLogOut size={14} />
              <span>Disconnect</span>
            </button>
          )}
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .sidebar {
          width: var(--sidebar-width);
          background-color: var(--bg-secondary);
          border-right: 1px solid var(--border);
          height: 100vh;
          padding: 24px 16px;
        }
        .brand-section {
          margin-bottom: 32px;
          padding-left: 8px;
        }
        .brand-title {
          font-size: 3.25rem;
          font-weight: 800;
          color: #ffffff;
          letter-spacing: 0.05em;
        }
        .light-theme .brand-title {
          color: var(--text-primary);
        }
        .brand-sub {
          font-size: 3.25rem;
          color: var(--text-secondary);
          font-family: var(--font-mono);
          margin-top: 4px;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .brand-sub .dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background-color: var(--status-ok);
          display: inline-block;
        }
        .nav-menu {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .nav-item {
          padding: 12px 16px;
          border-radius: 2px;
          font-size: 0.85rem;
          font-weight: 500;
          color: var(--text-secondary);
          transition: all 0.2s ease;
          width: 100%;
          text-align: left;
          cursor: pointer;
        }
        .nav-item:hover {
          color: #ffffff;
          background-color: var(--bg-surface);
        }
        .light-theme .nav-item:hover {
          color: var(--text-primary);
          background-color: var(--bg-surface);
        }
        .nav-item.active {
          color: #ffffff;
          background-color: rgba(var(--accent-rgb), 0.15);
          border-left: 3px solid var(--accent);
          padding-left: 13px;
        }
        .light-theme .nav-item.active {
          color: var(--accent);
        }
        .btn-deploy {
          background-color: var(--accent);
          color: #ffffff;
          font-weight: 600;
          font-size: 0.85rem;
          padding: 12px;
          border-radius: 6px;
          width: 100%;
          cursor: pointer;
          transition: opacity 0.2s;
          box-shadow: 0 4px 12px rgba(var(--accent-rgb), 0.3);
        }
        .btn-deploy:hover {
          opacity: 0.9;
        }
        .footer-actions {
          margin-top: 12px;
          padding: 0 8px;
        }
        .footer-btn {
          font-size: 0.75rem;
          color: var(--text-secondary);
          cursor: pointer;
          transition: color 0.2s;
        }
        .footer-btn:hover {
          color: #ffffff;
        }
        .light-theme .footer-btn:hover {
          color: var(--text-primary);
        }
      `}} />
    </div>
  );
}
