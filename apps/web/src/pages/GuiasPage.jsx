// GuiasPage.jsx — /guides (índice) y /guides/:slug (artículo). Pública.
import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { Link, Navigate } from '../i18n/link';
import { useLocale } from '../i18n/LocaleContext';
import { useT } from '../i18n/useT';
import { PublicNav } from '../components/PublicNav';
import { PublicFooter } from '../components/PublicFooter';
import { SITE_URL, useSeo } from '../lib/seo';
import { GUIAS } from './guiasContent';
import { LEGACY_GUIDE_IDS, withLocale } from '../i18n/paths';

export default function GuiasPage() {
  const { slug } = useParams();
  const locale = useLocale();
  const t = useT('guiasShell');
  const guia = slug ? GUIAS.find((g) => g.id === slug) : null;

  const jsonLd = useMemo(() => (guia ? {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: guia.title[locale],
    description: guia.description[locale],
    datePublished: guia.fecha,
    dateModified: guia.fecha,
    inLanguage: locale,
    author: { '@type': 'Organization', name: 'lixbon', url: SITE_URL },
    publisher: { '@type': 'Organization', name: 'lixbon', url: SITE_URL, logo: { '@type': 'ImageObject', url: `${SITE_URL}/icon-512.png` } },
    mainEntityOfPage: `${SITE_URL}${withLocale(`/guides/${guia.id}`, locale)}`,
  } : {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: `${t('title')} lixbon`,
    url: `${SITE_URL}${withLocale('/guides', locale)}`,
  }), [guia, locale, t]);

  useSeo({
    title: guia ? guia.title[locale] : t('title'),
    description: guia ? guia.description[locale] : t('seoDescription'),
    path: guia ? `/guides/${guia.id}` : '/guides',
    noindex: Boolean(slug && !guia),
    jsonLd,
  });

  if (slug && !guia) {
    if (LEGACY_GUIDE_IDS[slug]) return <Navigate to={`/guides/${LEGACY_GUIDE_IDS[slug]}`} replace />;
    return <Navigate to="/guides" replace />;
  }

  return (
    <div className="page">
      <PublicNav />
      {guia ? <Articulo guia={guia} locale={locale} t={t} /> : <Indice locale={locale} t={t} />}
      <PublicFooter />
    </div>
  );
}

function fmtFecha(iso, locale, t) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString(t('dateLocale'), { day: 'numeric', month: 'long', year: 'numeric' });
}

function Indice({ locale, t }) {
  return (
    <main className="guias">
      <header className="guias__cabecera">
        <h1 className="page__title">{t('title')}</h1>
        <p className="guias__lead">{t('lead')}</p>
      </header>
      <div className="guias__lista">
        {GUIAS.map((g) => (
          <Link key={g.id} to={`/guides/${g.id}`} className="guias__item">
            <span className="guias__meta">{fmtFecha(g.fecha, locale, t)} · {g.minutos} {t('minRead')}</span>
            <h2>{g.title[locale]}</h2>
            <p>{g.description[locale]}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}

function Articulo({ guia, locale, t }) {
  const Body = guia.Body[locale];
  const otras = GUIAS.filter((g) => g.id !== guia.id).slice(0, 3);
  return (
    <main className="guias guias--articulo">
      <article className="docs__content guias__cuerpo">
        <Link to="/guides" className="docs__eyebrow">{t('title')}</Link>
        <h1>{guia.title[locale]}</h1>
        <p className="guias__meta">{fmtFecha(guia.fecha, locale, t)} · {guia.minutos} {t('minRead')}</p>
        <Body />
      </article>
      <aside className="guias__mas">
        <span className="docs__nav-title">{t('otherGuides')}</span>
        {otras.map((g) => <Link key={g.id} to={`/guides/${g.id}`}>{g.title[locale]}</Link>)}
      </aside>
    </main>
  );
}
