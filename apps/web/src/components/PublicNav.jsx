// PublicNav.jsx — barra superior común de las páginas públicas
// (Aplicaciones, Documentación, Planes). Marca el enlace activo y adapta los
// botones de la derecha según haya sesión.
// En compacto los enlaces no desaparecen: se recogen en un menú desplegable.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Link } from '../i18n/link';
import { useAuth } from '../hooks/useAuth';
import { useDismiss } from '../hooks/useDismiss';
import { useT } from '../i18n/useT';
import { Logo } from './Logo';
import { IconMenu, IconX } from './Icons';
import { TemaBoton } from './TemaBoton';
import { LanguageSwitch } from './LanguageSwitch';

const SUPPORT_EMAIL = 'soporte@lixbon.com';

export function PublicNav() {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const t = useT('nav');
  const tc = useT('common');
  const [menuOpen, setMenuOpen] = useState(false);
  const navRef = useRef(null);

  const LINKS = [
    { to: '/docs', label: t('docs') },
    { to: '/guides', label: t('guides') },
    { to: '/apps', label: t('apps') },
    { to: '/plans', label: t('plans') },
  ];

  const close = useCallback(() => setMenuOpen(false), []);
  useDismiss(menuOpen, navRef, close);

  // Cambiar de página cierra el menú (los enlaces son SPA).
  useEffect(() => { close(); }, [pathname, close]);

  return (
    <header className="pubnav" ref={navRef}>
      <Link to="/" className="pubnav__logo" aria-label={t('home')}><Logo /></Link>

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
        {/* Estos se recogen en .pubnav__menu al pasar a compacto. Van en
            su propio contenedor porque .pubnav__btn lo reusan otras páginas
            (la conversación compartida) que no tienen menú donde recogerlos. */}
        <LanguageSwitch />
        <TemaBoton />
        <div className="pubnav__wide">
          <a href={`mailto:${SUPPORT_EMAIL}`} className="pill-btn pill-btn--outline pubnav__btn">
            {tc('support')}
          </a>
          {!user && (
            <Link to="/auth" className="pubnav__login">{tc('logIn')}</Link>
          )}
          <Link to="/chat" className="pill-btn pill-btn--primary pubnav__btn">{user ? tc('goToChat') : tc('tryLixbon')}</Link>
        </div>

        <button
          className="icon-btn pubnav__toggle"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={menuOpen ? t('closeMenu') : t('openMenu')}
          aria-expanded={menuOpen}
          aria-controls="pubnav-menu"
        >
          {menuOpen ? <IconX /> : <IconMenu />}
        </button>
      </div>

      {/* Mismo contenido que la barra ancha, apilado. Solo visible en compacto. */}
      <div id="pubnav-menu" className={`pubnav__menu ${menuOpen ? 'is-open' : ''}`} hidden={!menuOpen}>
        {LINKS.map((l) => (
          <Link
            key={l.to}
            to={l.to}
            className={`pubnav__menu-link ${pathname.startsWith(l.to) ? 'is-active' : ''}`}
          >
            {l.label}
          </Link>
        ))}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="pubnav__menu-link">{tc('support')}</a>
        {!user && <Link to="/auth" className="pubnav__menu-link">{tc('logIn')}</Link>}
        <Link to="/chat" className="pill-btn pill-btn--primary pubnav__menu-cta">{user ? tc('goToChat') : tc('tryLixbon')}</Link>
      </div>
    </header>
  );
}
