import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Link } from '../i18n/link';
import { stripLocale } from '../i18n/paths';
import { useAuth } from '../hooks/useAuth';
import { useDismiss } from '../hooks/useDismiss';
import { useT } from '../i18n/useT';
import { useLocale } from '../i18n/LocaleContext';
import { urlFounder } from '../lib/founder';
import { LogoFounderScroll } from './LogoFounder';
import { IconChevron, IconMenu, IconX } from './Icons';
import { LanguageSwitch } from './LanguageSwitch';

function useMenu(t) {
  return [
    {
      id: 'product',
      label: t('menuProduct'),
      items: [
        { to: '/chat', label: t('itemChat'), desc: t('itemChatDesc') },
        { to: '/visuals', label: t('itemVisuals'), desc: t('itemVisualsDesc') },
        { to: '/apps', label: t('itemApps'), desc: t('itemAppsDesc') },
        { to: '/skills', label: t('itemSkills'), desc: t('itemSkillsDesc') },
      ],
    },
    {
      id: 'developers',
      label: t('menuDevelopers'),
      items: [
        { to: '/docs', label: t('itemDocs'), desc: t('itemDocsDesc') },
        { to: '/docs/using-your-api-key', label: t('itemApi'), desc: t('itemApiDesc') },
        { to: '/guides', label: t('itemGuides'), desc: t('itemGuidesDesc') },
        { to: '/status', label: t('itemStatus'), desc: t('itemStatusDesc') },
      ],
    },
    {
      id: 'company',
      label: t('menuCompany'),
      items: [
        { to: '/about', label: t('itemAbout'), desc: t('itemAboutDesc') },
        { to: '/team', label: t('itemLeadership'), desc: t('itemLeadershipDesc') },
        { to: '/news', label: t('itemNews'), desc: t('itemNewsDesc') },
        { to: '/support', label: t('itemSupport'), desc: t('itemSupportDesc') },
        { to: '/legal/terms', label: t('itemLegal'), desc: t('itemLegalDesc') },
      ],
    },
    { id: 'donate', label: t('donate'), to: '/donate' },
  ];
}

const coincide = (ruta, to) => ruta === to || (to.startsWith('/legal/') && ruta.startsWith('/legal/')) ||(to !== '/docs' && ruta.startsWith(`${to}/`)) || (to === '/docs' && ruta.startsWith('/docs') && !ruta.startsWith('/docs/using-your-api-key'));

export function PublicNav() {
  const { pathname } = useLocation();
  const ruta = stripLocale(pathname);
  const { user } = useAuth();
  const t = useT('nav');
  const locale = useLocale();
  const tc = useT('common');
  const [menuOpen, setMenuOpen] = useState(false);
  const [abierto, setAbierto] = useState(null);
  const navRef = useRef(null);
  const [scrolled, setScrolled] = useState(false);
  const menu = useMenu(t);

  useEffect(() => {
    const alMover = () => setScrolled(window.scrollY > 8);
    alMover();
    window.addEventListener('scroll', alMover, { passive: true });
    return () => window.removeEventListener('scroll', alMover);
  }, []);

  const close = useCallback(() => { setMenuOpen(false); setAbierto(null); }, []);
  useDismiss(menuOpen || abierto !== null, navRef, close);
  useEffect(() => { close(); }, [pathname, close]);

  const grupoActivo = (g) => (g.to ? coincide(ruta, g.to) : g.items.some((i) => coincide(ruta, i.to)));

  return (
    <header className={`pubnav ${scrolled ? 'is-scrolled' : ''}`} ref={navRef}>
      <div className="pubnav__in">
        <a href={urlFounder('/', locale)} className="pubnav__logo" aria-label={t('home')}><LogoFounderScroll /></a>

        <nav className="pubnav__links" aria-label={t('home')}>
          {menu.map((g) => (g.to ? (
            <Link key={g.id} to={g.to} className={`pubnav__link ${grupoActivo(g) ? 'is-active' : ''}`}>{g.label}</Link>
          ) : (
            <div
              key={g.id}
              className={`pubnav__grupo ${abierto === g.id ? 'is-open' : ''}`}
              onMouseEnter={() => setAbierto(g.id)}
              onMouseLeave={() => setAbierto((a) => (a === g.id ? null : a))}
            >
              <button
                type="button"
                className={`pubnav__link ${grupoActivo(g) ? 'is-active' : ''}`}
                aria-expanded={abierto === g.id}
                aria-controls={`pubnav-${g.id}`}
                onClick={() => setAbierto((a) => (a === g.id ? null : g.id))}
              >
                {g.label}<IconChevron size={13} open={abierto === g.id} />
              </button>
              <div id={`pubnav-${g.id}`} className="pubnav__panel" hidden={abierto !== g.id}>
                {g.items.map((i) => (
                  <Link key={i.to} to={i.to} className={`pubnav__item ${coincide(ruta, i.to) ? 'is-active' : ''}`}>
                    <strong>{i.label}</strong>
                    <span>{i.desc}</span>
                  </Link>
                ))}
              </div>
            </div>
          )))}
        </nav>

        <div className="pubnav__actions">
          <div className="btn-grupo pubnav__cta">
            <LanguageSwitch className="btn-grupo__item btn-grupo__item--sec pubnav__idioma" conCodigo />
            <Link to="/chat" className="btn-grupo__item">{user ? tc('goToChat') : tc('tryLixbon')}</Link>
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
      </div>

      <div id="pubnav-menu" className={`pubnav__menu ${menuOpen ? 'is-open' : ''}`} hidden={!menuOpen}>
        {menu.map((g) => (g.to ? (
          <Link key={g.id} to={g.to} className="pubnav__menu-solo">{g.label}</Link>
        ) : (
          <div key={g.id} className="pubnav__menu-grupo">
            <span className="pubnav__menu-titulo">{g.label}</span>
            {g.items.map((i) => (
              <Link key={i.to} to={i.to} className={`pubnav__menu-link ${coincide(ruta, i.to) ? 'is-active' : ''}`}>{i.label}</Link>
            ))}
          </div>
        )))}
      </div>
    </header>
  );
}
