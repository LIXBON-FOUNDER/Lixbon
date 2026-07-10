// PublicNav.jsx — barra superior común de las páginas públicas
// (Aplicaciones, Documentación, Planes). Marca el enlace activo y adapta los
// botones de la derecha según haya sesión.
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../lib/theme';
import { Logo } from './Logo';
import { IconSun, IconMoon } from './Icons';

const LINKS = [
  { to: '/docs', label: 'Documentación' },
  { to: '/aplicaciones', label: 'Aplicaciones' },
  { to: '/planes', label: 'Planes' },
];

const SUPPORT_EMAIL = 'soporte@lixbon.com';

export function PublicNav() {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const [theme, toggleTheme] = useTheme();

  return (
    <header className="pubnav">
      <Link to="/" className="pubnav__logo"><Logo size={30} /></Link>

      <nav className="pubnav__links">
        {LINKS.map((l) => (
          <Link
            key={l.to}
            to={l.to}
            className={`pubnav__link ${pathname.startsWith(l.to) ? 'is-active' : ''}`}
          >
            {l.label}
          </Link>
        ))}
      </nav>

      <div className="pubnav__actions">
        <button
          className="icon-btn"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
        >
          {theme === 'dark' ? <IconSun /> : <IconMoon />}
        </button>
        <a href={`mailto:${SUPPORT_EMAIL}`} className="pill-btn pill-btn--outline pubnav__btn">
          Soporte
        </a>
        {!user && (
          <Link to="/auth" className="pubnav__login">Iniciar sesión</Link>
        )}
        <Link to="/" className="pill-btn pill-btn--primary pubnav__btn">Probar lixbon</Link>
      </div>
    </header>
  );
}
