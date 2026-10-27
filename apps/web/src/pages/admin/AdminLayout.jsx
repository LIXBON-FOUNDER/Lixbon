// El acceso lo decide el backend en cada endpoint; esto solo evita pintar un
// panel vacío a quien no es admin.
import { TemaBoton } from '../../components/TemaBoton';
import { useSeo } from '../../lib/seo';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useConfirmar } from '../../hooks/useConfirmar';
import { useDismiss } from '../../hooks/useDismiss';
import { Logo } from '../../components/Logo';
import {
  IconApps, IconArrowDown, IconBag, IconBolt, IconBook, IconCard, IconCaret, IconChart, IconChat, IconCorazon,
  IconDownload, IconGear, IconHome, IconLayers, IconLink, IconLogout, IconNodes, IconRows, IconCorreo, IconShield,
  IconTerminal, IconTrend, IconUser, IconUsers,
} from '../../components/Icons';
import { inicialDe } from './comunes';

const AREAS = [
  { to: '/admin', end: true, icon: IconHome, label: 'Inicio' },
  {
    grupo: '/admin/ia',
    icon: IconApps,
    label: 'IA',
    hijos: [
      { to: '/admin/ia/modelos', icon: IconLayers, label: 'Modelos y costo' },
      { to: '/admin/ia/roles', icon: IconUser, label: 'Roles' },
      { to: '/admin/ia/alias', icon: IconLink, label: 'Alias' },
      { to: '/admin/ia/tarifas', icon: IconChart, label: 'Tarifas' },
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
      { to: '/admin/pagos/donaciones', icon: IconCorazon, label: 'Donaciones' },
      { to: '/admin/pagos/transacciones', icon: IconRows, label: 'Transacciones' },
      { to: '/admin/pagos/liquidaciones', icon: IconArrowDown, label: 'Liquidaciones' },
      { to: '/admin/pagos/pasarela', icon: IconGear, label: 'Configuración' },
    ],
  },
  { to: '/admin/usuarios', icon: IconUsers, label: 'Usuarios' },
  { to: '/admin/chat', icon: IconChat, label: 'Chat web' },
  { to: '/admin/correos', icon: IconCorreo, label: 'Correos' },
  { to: '/admin/releases', icon: IconDownload, label: 'Releases' },
  { to: '/admin/skills', icon: IconTerminal, label: 'Skills' },
  { to: '/admin/auditoria', icon: IconShield, label: 'Auditoría' },
];

const claseLink = ({ isActive }) => `adm-link ${isActive ? 'is-active' : ''}`;
const claseSub = ({ isActive }) => `adm-sublink ${isActive ? 'is-active' : ''}`;

export default function AdminLayout() {
  useSeo({ title: 'Administración', noindex: true });
  const { user, loading, logout } = useAuth();
  const confirmar = useConfirmar();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [menuPerfil, setMenuPerfil] = useState(false);
  const perfilRef = useRef(null);

  const cerrarMenu = useCallback(() => setMenuPerfil(false), []);
  useDismiss(menuPerfil, perfilRef, cerrarMenu);
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
    navigate('/chat');
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
          <Logo size={15} />
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
                  <NavLink key={h.to} to={h.to} className={claseSub}>
                    <h.icon size={15} />
                    <span>{h.label}</span>
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>

        <div className="adm__util">
          <Link to="/chat" className="adm-link adm__back">
            <IconChat size={18} />
            <span className="adm-link__txt">Volver al chat</span>
          </Link>
          <TemaBoton className="icon-btn adm__tema" />
        </div>

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
