// PublicNav.jsx — barra superior común de las páginas públicas
// (Descargas, Documentación, Planes). Marca el enlace activo.
import { Link, useLocation } from 'react-router-dom';
import { Logo } from './Logo';

const LINKS = [
  { to: '/docs', label: 'Documentación' },
  { to: '/descargas', label: 'Descargas' },
  { to: '/planes', label: 'Planes' },
];

export function PublicNav() {
  const { pathname } = useLocation();
  return (
    <header className="pubnav">
      <Link to="/" className="pubnav__logo"><Logo size={22} /></Link>
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
      <Link to="/" className="pill-btn pill-btn--primary pubnav__cta">Abrir el chat</Link>
    </header>
  );
}
