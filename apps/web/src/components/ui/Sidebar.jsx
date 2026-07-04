import React from 'react';
import { NavLink } from 'react-router-dom';
import { 
  LuLayoutDashboard, 
  LuServer, 
  LuCpu, 
  LuRouter, 
  LuTerminal, 
  LuSettings, 
  LuCircleHelp, 
  LuUsers,
  LuSparkles 
} from 'react-icons/lu';
import '../../style/Sidebar.css';

const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: LuLayoutDashboard },
  { name: 'Active Nodes', href: '/nodes', icon: LuServer },
  { name: 'Interactive Chat', href: '/chat', icon: LuCpu },
  { name: 'AI Delegation', href: '/delegation', icon: LuRouter },
  { name: 'CLI Installer', href: '/installer', icon: LuTerminal },
  { name: 'App Releases', href: '/releases', icon: LuSparkles },
  { name: 'API Keys', href: '/keys', icon: LuSettings },
];

export function Sidebar({ isOpen, onClose }) {
  const handleNavLinkClick = () => {
    if (window.innerWidth <= 768) {
      onClose();
    }
  };

  return (
    <aside className={`sidebar ${isOpen ? 'open' : 'collapsed'}`} id="sidebar">
      {/* Brand / Logo */}
      <div className="brand">
        <div className="brand-info">
          <div className="brand-logo">F</div>
          <div>
            <h1 className="brand-title">
              FOLAX DTC
            </h1>
            <p className="brand-subtitle">Local Cluster</p>
          </div>
        </div>
        <button className="close-sidebar" id="close-sidebar-btn" title="Cerrar menú" onClick={onClose}>
          <span>✕</span>
        </button>
      </div>

      {/* CTA Button: Deploy Model */}
      <div className="sidebar-cta-wrapper">
        <button
          onClick={() => window.location.href = '/delegation'}
          className="btn-deploy-model"
        >
          <LuSparkles size={14} /> Deploy Model
        </button>
      </div>

      {/* Navigation Links */}
      <nav className="side-nav" id="main-nav">
        {navigation.map((item) => (
          <NavLink
            key={item.name}
            to={item.href}
            className={({ isActive }) => isActive ? 'active' : ''}
            onClick={handleNavLinkClick}
          >
            <item.icon className="h-5 w-5 shrink-0" />
            {item.name}
          </NavLink>
        ))}

        {/* Spacer to push footer links to the bottom */}
        <div className="nav-spacer"></div>

        {/* Divider line */}
        <div className="nav-divider"></div>

        {/* Footer links mapping to Integrations (Docs) and Teams (Support) */}
        <NavLink
          to="/integrations"
          className={({ isActive }) => isActive ? 'active' : ''}
          onClick={handleNavLinkClick}
        >
          <LuCircleHelp className="h-5 w-5 shrink-0" />
          Docs
        </NavLink>
        <NavLink
          to="/teams"
          className={({ isActive }) => isActive ? 'active' : ''}
          onClick={handleNavLinkClick}
        >
          <LuUsers className="h-5 w-5 shrink-0" />
          Support
        </NavLink>
      </nav>
    </aside>
  );
}
