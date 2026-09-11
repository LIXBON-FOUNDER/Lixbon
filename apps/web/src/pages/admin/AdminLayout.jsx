// El acceso lo decide el backend en cada endpoint; esto solo evita pintar un
// panel vacío a quien no es admin.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useConfirmar } from '../../hooks/useConfirmar';
import { useDismiss } from '../../hooks/useDismiss';
import { Logo, LogoMark } from '../../components/Logo';
import {
  IconApps, IconBag, IconBolt, IconBook, IconCard, IconCaret, IconChat, IconDownload,
  IconGear, IconHome, IconLogout, IconNodes, IconShield, IconTrend, IconUsers,
} from '../../components/Icons';
import { inicialDe } from './comunes';

const AREAS = [
  { to: '/admin', end: true, icon: IconHome, label: 'Inicio' },
  {
    grupo: '/admin/ia',
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
  {
    grupo: '/admin/pagos',
    icon: IconCard,
    label: 'Pagos',
    hijos: [
      { to: '/admin/pagos/transacciones', label: 'Transacciones' },
      { to: '/admin/pagos/liquidaciones', label: 'Liquidaciones' },
      { to: '/admin/pagos/pasarela', label: 'Configuración' },
    ],
  },
  { to: '/admin/usuarios', icon: IconUsers, label: 'Usuarios' },
  { to: '/admin/releases', icon: IconDownload, label: 'Releases' },
  { to: '/admin/auditoria', icon: IconShield, label: 'Auditoría' },
];

const claseLink = ({ isActive }) => `adm-link ${isActive ? 'is-active' : ''}`;
const claseSub = ({ isActive }) => `adm-sublink ${isActive ? 'is-active' : ''}`;

export default function AdminLayout() {
  const { user, loading, logout } = useAuth();
  const confirmar = useConfirmar();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [menuPerfil, setMenuPerfil] = useState(false);
  const perfilRef = useRef(null);

  const cerrarMenu = useCallback(() => setMenuPerfil(false), []);
  useDismiss(menuPerfil, perfilRef, cerrarMenu);
  // Un grupo se abre solo cuando estás dentro, y se puede plegar a mano.
  const [abiertos, setAbiertos] = useState(
    () => AREAS.filter((a) => a.grupo && pathname.startsWith(a.grupo)).map((a) => a.grupo),
  );

  useEffect(() => {
    const dentro = AREAS.find((a) => a.grupo && pathname.startsWith(a.grupo));
    if (dentro) setAbiertos((v) => (v.includes(dentro.grupo) ? v : [...v, dentro.grupo]));
  }, [pathname]);

  const alternar = (grupo) => setAbiertos(
    (v) => (v.includes(grupo) ? v.filter((g) => g !== grupo) : [...v, grupo]),
  );

  const ir = (ruta) => { setMenuPerfil(false); navigate(ruta); };

  const cerrarSesion = async () => {
    setMenuPerfil(false);
    const ok = await confirmar({
      titulo: '¿Cerrar sesión?',
      texto: 'Se cerrará tu sesión en este navegador.',
      etiqueta: 'Cerrar sesión',
      peligro: false,
    });
    if (!ok) return;
    await logout();
    navigate('/');
  };

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
            const dentro = pathname.startsWith(a.grupo);
            const abierto = abiertos.includes(a.grupo);
            return (
              <div key={a.grupo}>
                <button
                  type="button"
                  className={`adm-link ${dentro ? 'is-active' : ''}`}
                  onClick={() => alternar(a.grupo)}
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
          <div className="adm__who" ref={perfilRef}>
            {user.avatar_url ? (
              <img className="adm__avatar adm__avatar--img" src={user.avatar_url} alt="" />
            ) : (
              <span className="adm__avatar">{inicialDe(nombre)}</span>
            )}
            <div className="adm__id">
              <span className="adm__name">{nombre}</span>
              <span className="adm__role">Administrador</span>
            </div>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setMenuPerfil((v) => !v)}
              aria-label="Opciones de la cuenta"
              aria-expanded={menuPerfil}
            >
              <IconGear size={17} />
            </button>
            {menuPerfil && (
              <div className="sb-menu sb-menu--profile" role="menu">
                <button onClick={() => ir('/planes')}><IconBolt size={14} /> Planes</button>
                <button onClick={() => ir('/account')}><IconGear size={14} /> Ajustes</button>
                <button onClick={() => ir('/docs')}><IconBook size={14} /> Documentación</button>
                <button onClick={cerrarSesion}><IconLogout size={14} /> Cerrar sesión</button>
              </div>
            )}
          </div>
        </div>
      </aside>

      <main className="adm__main">
        <Outlet />
      </main>
    </div>
  );
}
