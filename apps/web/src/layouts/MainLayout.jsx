import React, { useState, useEffect, useRef } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { Sidebar } from '../components/ui/Sidebar';
import { LuMenu, LuBell, LuUser, LuLogOut, LuPlus, LuCircleAlert } from 'react-icons/lu';
import { useAuth } from '../features/auth/AuthContext';
import '../style/MainLayout.css';

export function MainLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const notificationsRef = useRef(null);
  const profileRef = useRef(null);

  // Colapsar sidebar en móviles por defecto
  useEffect(() => {
    if (window.innerWidth <= 768) {
      setSidebarOpen(false);
    }
  }, []);

  // Cerrar dropdowns al hacer click afuera
  useEffect(() => {
    function handleClickOutside(event) {
      if (notificationsRef.current && !notificationsRef.current.contains(event.target)) {
        setNotificationsOpen(false);
      }
      if (profileRef.current && !profileRef.current.contains(event.target)) {
        setProfileOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleConnectNodeClick = () => {
    alert("Para conectar un nuevo nodo, copia y ejecuta el instalador CLI de la pestaña 'Instalador CLI' en el otro PC.");
    navigate('/installer');
  };

  return (
    <div className="app-layout">
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <main className={`main-content ${sidebarOpen ? '' : 'expanded'}`} id="main-content">
        <header className="top-header">
          <div className="header-left">
            <button 
              className="toggle-sidebar toggle-sidebar-btn" 
              id="toggle-sidebar-btn" 
              title="Toggle menú"
              onClick={() => setSidebarOpen(prev => !prev)}
            >
              <LuMenu size={20} />
            </button>
            <span className="cluster-status-text">
              Cluster Status: <strong className="cluster-status-online">ONLINE</strong>
            </span>
          </div>

          <div className="header-right">
            <button 
              onClick={handleConnectNodeClick}
              className="secondary btn-connect-node" 
            >
              <LuPlus size={14} /> Connect Node
            </button>

            {/* NOTIFICACIONES */}
            <div ref={notificationsRef} className="notifications-wrapper">
              <button 
                onClick={() => { setNotificationsOpen(!notificationsOpen); setProfileOpen(false); }}
                className="notifications-trigger"
                title="Notificaciones"
              >
                <div className="notifications-icon-wrapper">
                  <LuBell size={18} />
                  <span className="notifications-badge"></span>
                </div>
              </button>

              {notificationsOpen && (
                <div className="dropdown-menu notifications-dropdown">
                  <div className="dropdown-header notifications-header">
                    <strong>Notificaciones del sistema</strong>
                    <span className="notifications-new-badge">3 nuevas</span>
                  </div>
                  <ul className="dropdown-list">
                    <li className="notification-item">
                      <div className="notification-content">
                        <LuCircleAlert size={14} className="notification-icon-success" />
                        <div>
                          <p className="notification-title">Nodo C conectado</p>
                          <span className="notification-time">Hace 5 minutos</span>
                        </div>
                      </div>
                    </li>
                    <li className="notification-item">
                      <div className="notification-content">
                        <LuCircleAlert size={14} className="notification-icon-error" />
                        <div>
                          <p className="notification-title">Fallo de conexión al modelo</p>
                          <span className="notification-time">Hace 15 minutos</span>
                        </div>
                      </div>
                    </li>
                    <li className="notification-item-last">
                      <div className="notification-content">
                        <LuCircleAlert size={14} className="notification-icon-warning" />
                        <div>
                          <p className="notification-title">API Key de durangogabriel... activa</p>
                          <span className="notification-time">Hace 1 hora</span>
                        </div>
                      </div>
                    </li>
                  </ul>
                </div>
              )}
            </div>

            {/* PERFIL */}
            <div ref={profileRef} className="profile-wrapper">
              <button 
                onClick={() => { setProfileOpen(!profileOpen); setNotificationsOpen(false); }}
                className="profile-trigger"
                title="Mi Cuenta"
              >
                <LuUser size={16} />
              </button>

              {profileOpen && (
                <div className="dropdown-menu profile-dropdown">
                  <div className="dropdown-header">
                    <p className="profile-name">{user?.username || 'Usuario'}</p>
                    <p className="profile-email">{user?.email || 'admin@datacentgbx.online'}</p>
                  </div>
                  <ul className="dropdown-list profile-dropdown-list">
                    <li>
                      <button 
                        onClick={() => { setProfileOpen(false); navigate('/dashboard'); }}
                        className="dropdown-btn"
                      >
                        Dashboard
                      </button>
                    </li>
                    <li>
                      <button 
                        onClick={() => { setProfileOpen(false); navigate('/keys'); }}
                        className="dropdown-btn"
                      >
                        Mis Claves API
                      </button>
                    </li>
                    <li className="dropdown-divider">
                      <button 
                        onClick={() => { setProfileOpen(false); logout(); }}
                        className="btn-logout"
                      >
                        <LuLogOut size={12} /> Cerrar sesión
                      </button>
                    </li>
                  </ul>
                </div>
              )}
            </div>
          </div>
        </header>
        <div className="container">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
