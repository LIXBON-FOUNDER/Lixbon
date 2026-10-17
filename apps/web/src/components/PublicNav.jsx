import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Link } from '../i18n/link';
import { stripLocale } from '../i18n/paths';
import { useAuth } from '../hooks/useAuth';
import { useDismiss } from '../hooks/useDismiss';
import { useT } from '../i18n/useT';
import { useLocale } from '../i18n/LocaleContext';
import { urlFounder } from '../lib/founder';
import { Logo } from './Logo';
import { IconChevron, IconCorazon, IconMenu, IconX } from './Icons';
import { LanguageSwitch } from './LanguageSwitch';
import { useDonaciones } from '../lib/donaciones';

const CLAVE_FRANJA = 'lixbon-franja-cerrada';

// La misma franja que founder.lixbon.com. Empieza visible para que el
// prerender y la primera pintura coincidan; se oculta tras montar si el
// visitante ya la cerró.
function Franja() {
  const t = useT('nav');
  const donaciones = useDonaciones();
  const locale = useLocale();
  const [cerrada, setCerrada] = useState(false);
  useEffect(() => {
    try { if (localStorage.getItem(CLAVE_FRANJA) === '1') setCerrada(true); } catch { /* sin almacenamiento */ }
  }, []);
  if (cerrada || !donaciones?.enabled) return null;
  const cerrar = () => {
    setCerrada(true);
    try { localStorage.setItem(CLAVE_FRANJA, '1'); } catch { /* sin almacenamiento */ }
  };
  return (
    <div className="franja">
      <p>{t('bannerText')}</p>
      <a href={urlFounder('/donate', locale)}>{t('bannerLink')}</a>
      <button type="button" className="franja__cerrar" onClick={cerrar} aria-label={t('bannerClose')}>
        <IconX size={14} />
      </button>
    </div>
  );
}

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
  ];
}

const coincide = (ruta, to) => ruta === to || (to.startsWith('/legal/') && ruta.startsWith('/legal/')) ||(to !== '/docs' && ruta.startsWith(`${to}/`)) || (to === '/docs' && ruta.startsWith('/docs') && !ruta.startsWith('/docs/using-your-api-key'));

export function PublicNav() {
  const { pathname } = useLocation();
  const ruta = stripLocale(pathname);
  const { user } = useAuth();
  const t = useT('nav');
  const tc = useT('common');
  const locale = useLocale();
  const [menuOpen, setMenuOpen] = useState(false);
  const [abierto, setAbierto] = useState(null);
  const navRef = useRef(null);
  const [scrolled, setScrolled] = useState(false);
  const menu = useMenu(t);
  // Donar solo aparece mientras el admin tenga las donaciones activas.
  const donar = useDonaciones()?.enabled;

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
    <>
    <Franja />
    <header className={`pubnav ${scrolled ? 'is-scrolled' : ''}`} ref={navRef}>
      <div className="pubnav__in">
        <Link to="/chat" className="pubnav__logo" aria-label={t('home')}><Logo /></Link>

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
          <LanguageSwitch className="pubnav__icono pubnav__idioma" conCodigo />
          <Link to="/chat" className="pill pill--tinta pubnav__cta">{user ? tc('goToChat') : tc('tryLixbon')}</Link>
          {donar && <a href={urlFounder('/donate', locale)} className="pill pill--oliva pubnav__donar"><IconCorazon size={16} />{t('donate')}</a>}

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
        <div className="pubnav__menu-botones">
          <Link to="/chat" className="pill pill--tinta">{user ? tc('goToChat') : tc('tryLixbon')}</Link>
          {donar && <a href={urlFounder('/donate', locale)} className="pill pill--oliva"><IconCorazon size={16} />{t('donate')}</a>}
        </div>
      </div>
    </header>
    </>
  );
}
