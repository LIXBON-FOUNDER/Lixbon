// DocsPage.jsx — lixbon Docs (/docs y /docs/:section). Índice lateral por grupos +
// contenido central. Pública. Estilo tipo code.claude.com.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Link, Navigate, useNavigate } from '../i18n/link';
import { useLocale } from '../i18n/LocaleContext';
import { useT } from '../i18n/useT';
import { PublicNav } from '../components/PublicNav';
import { PublicFooter } from '../components/PublicFooter';
import { SECTIONS } from './docsContent';
import { DocsSkeleton } from '../components/Skeleton';
import { DocsToc } from '../components/DocsToc';
import { IconChevron } from '../components/Icons';
import { useSeo } from '../lib/seo';
import { LEGACY_DOC_IDS } from '../i18n/paths';

export default function DocsPage() {
  const { section } = useParams();
  const navigate = useNavigate();
  const locale = useLocale();
  const t = useT('docsShell');
  const [menuOpen, setMenuOpen] = useState(false);
  // En el prerender no hay window ni efectos: el contenido va desde el principio.
  const enServidor = typeof window === 'undefined';
  const [contentReady, setContentReady] = useState(enServidor);
  const base = useMemo(() => (enServidor ? 'https://lixbon.com' : window.location.origin), [enServidor]);
  const cuerpoRef = useRef(null);

  const legacyTarget = section && !SECTIONS.some((s) => s.id === section) ? LEGACY_DOC_IDS[section] : null;
  const current = SECTIONS.find((s) => s.id === section) || SECTIONS[0];
  useSeo({
    title: `${current.title[locale]} · ${t('seoSuffix')}`,
    description: current.description[locale],
    path: `/docs/${current.id}`,
  });

  // Agrupa las secciones por su `group`, conservando el orden de aparición
  const groups = useMemo(() => {
    const acc = [];
    for (const s of SECTIONS) {
      const nombre = s.group[locale];
      let g = acc.find((x) => x.name === nombre);
      if (!g) { g = { name: nombre, items: [] }; acc.push(g); }
      g.items.push(s);
    }
    return acc;
  }, [locale]);

  // Skeleton breve al montar y al cambiar de sección, para una transición suave.
  useEffect(() => {
    window.scrollTo(0, 0);
    setMenuOpen(false);
    setContentReady(false);
    const timer = setTimeout(() => setContentReady(true), 220);
    return () => clearTimeout(timer);
  }, [section]);

  const Body = current.Body[locale];

  if (legacyTarget) {
    return <Navigate to={`/docs/${legacyTarget}`} replace />;
  }

  return (
    <div className="page">
      <PublicNav />
      <div className="docs">
        <button
          className="docs__menu-toggle"
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-controls="docs-nav"
        >
          {current.title[locale]} <IconChevron size={14} open={menuOpen} />
        </button>

        <aside id="docs-nav" className={`docs__nav ${menuOpen ? 'is-open' : ''}`}>
          {groups.map((g) => (
            <div key={g.name} className="docs__nav-group">
              <span className="docs__nav-title">{g.name}</span>
              {g.items.map((s) => (
                <Link
                  key={s.id}
                  to={`/docs/${s.id}`}
                  className={`docs__nav-link ${s.id === current.id ? 'is-active' : ''}`}
                  onClick={(e) => {
                    // navegación SPA sin recargar
                    e.preventDefault();
                    navigate(`/docs/${s.id}`);
                  }}
                >
                  {s.title[locale]}
                </Link>
              ))}
            </div>
          ))}
        </aside>

        <article className="docs__content" ref={cuerpoRef}>
          {contentReady ? (
            <>
              <span className="docs__eyebrow">{current.group[locale]}</span>
              <Body base={base} />
              <DocsFooter current={current} locale={locale} t={t} />
            </>
          ) : (
            <DocsSkeleton />
          )}
        </article>

        {contentReady && <DocsToc contenedor={cuerpoRef} deps={current.id} />}
      </div>
      <PublicFooter />
    </div>
  );
}

function DocsFooter({ current, locale, t }) {
  const idx = SECTIONS.findIndex((s) => s.id === current.id);
  const prev = SECTIONS[idx - 1];
  const next = SECTIONS[idx + 1];
  return (
    <nav className="docs__pager">
      {prev ? (
        <Link to={`/docs/${prev.id}`} className="docs__pager-link">
          <span>{t('previous')}</span><strong>{prev.title[locale]}</strong>
        </Link>
      ) : <span />}
      {next && (
        <Link to={`/docs/${next.id}`} className="docs__pager-link docs__pager-link--next">
          <span>{t('next')}</span><strong>{next.title[locale]}</strong>
        </Link>
      )}
    </nav>
  );
}
