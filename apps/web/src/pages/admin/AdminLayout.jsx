// El acceso lo decide el backend en cada endpoint; esto solo evita pintar un
// panel vacío a quien no es admin.
import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { Logo, LogoMark } from '../../components/Logo';
import {
  IconApps, IconBag, IconCaret, IconChat, IconDownload, IconGear,
  IconHome, IconNodes, IconShield, IconTrend, IconUsers,
} from '../../components/Icons';
import { inicialDe } from './comunes';

const AREAS = [
  { to: '/admin', end: true, icon: IconHome, label: 'Inicio' },
  {
    grupo: 'ia',
    icon: IconApps,
    label: 'IA',
    hijos: [
      { to: '/admin/ia/modelos', label: 'Modelos y costo' },
      { to: '/admin/ia/roles', label: 'Roles' },
      { to: '/admin/ia/tarifas', label: 'Tarifas' },
    ],
  },
  { to: '/admin/proveedores', icon: IconBag, label: 'Proveedores' },
  { to: '/admin/nodos', icon: IconNodes, label: 'Nodos' },
  { to: '/admin/ingresos', icon: IconTrend, label: 'Ingresos' },
  { to: '/admin/usuarios', icon: IconUsers, label: 'Usuarios' },
  { to: '/admin/releases', icon: IconDownload, label: 'Releases' },
  { to: '/admin/auditoria', icon: IconShield, label: 'Auditoría' },
];

const claseLink = ({ isActive }) => `adm-link ${isActive ? 'is-active' : ''}`;
const claseSub = ({ isActive }) => `adm-sublink ${isActive ? 'is-active' : ''}`;

export default function AdminLayout() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const dentroDeIA = pathname.startsWith('/admin/ia');
  const [abierto, setAbierto] = useState(dentroDeIA);

  useEffect(() => {
    if (dentroDeIA) setAbierto(true);
  }, [dentroDeIA]);

  useEffect(() => {
    if (loading) return;
    if (!user) navigate('/auth', { replace: true });
    else if (user.role !== 'admin') navigate('/', { replace: true });
  }, [user, loading, navigate]);

  if (loading || !user || user.role !== 'admin') {
    return (
      <div className="app-loading">
        <span className="app-loading__logo"><Logo size={19} /></span>
        <span className="app-loading__bar"><span /></span>
      </div>
    );
  }

  const nombre = [user.first_name, user.last_name].filter(Boolean).join(' ')
    || user.username || user.email;

  return (
    <div className="adm">
      <aside className="adm__nav">
        <div className="adm__brand">
          <LogoMark size={26} />
          <span className="brand">LIXBON</span>
          <span className="adm__brand-tag">Admin</span>
        </div>

        <nav className="adm__links" aria-label="Áreas del panel">
          {AREAS.map((a) => {
            if (!a.grupo) {
              const Icono = a.icon;
              return (
                <NavLink key={a.to} to={a.to} end={a.end} className={claseLink}>
                  <Icono size={18} />
                  <span className="adm-link__txt">{a.label}</span>
                </NavLink>
              );
            }
            const Icono = a.icon;
            return (
              <div key={a.grupo}>
                <button
                  type="button"
                  className={`adm-link ${dentroDeIA ? 'is-active' : ''}`}
                  onClick={() => setAbierto((v) => !v)}
                  aria-expanded={abierto}
                >
                  <Icono size={18} />
                  <span className="adm-link__txt">{a.label}</span>
                  <IconCaret size={14} className={`adm-link__caret ${abierto ? 'is-open' : ''}`} />
                </button>
                {abierto && a.hijos.map((h) => (
                  <NavLink key={h.to} to={h.to} className={claseSub}>{h.label}</NavLink>
                ))}
              </div>
            );
          })}
        </nav>

        <Link to="/" className="adm__back">
          <IconChat size={17} />
          <span>Volver al chat</span>
        </Link>

        <div className="adm__foot">
          <span className="tab" />
          <div className="adm__who">
            <span className="adm__avatar">{inicialDe(nombre)}</span>
            <div className="adm__id">
              <span className="adm__name">{nombre}</span>
              <span className="adm__role">Administrador</span>
            </div>
            <Link to="/account" className="icon-btn" aria-label="Ajustes de la cuenta">
              <IconGear size={17} />
            </Link>
          </div>
        </div>
      </aside>

      <main className="adm__main">
        <Outlet />
      </main>
    </div>
  );
}
