// LegalPage.jsx — /legal/:doc (privacy, terms, refunds). Pública.
import { useParams } from 'react-router-dom';
import { Link, Navigate } from '../i18n/link';
import { useLocale } from '../i18n/LocaleContext';
import { useT } from '../i18n/useT';
import { PublicNav } from '../components/PublicNav';
import { PublicFooter } from '../components/PublicFooter';
import { useSeo } from '../lib/seo';
import { LEGAL, VIGENCIA } from './legalContent';
import { LEGACY_LEGAL_IDS } from '../i18n/paths';

export default function LegalPage() {
  const { doc } = useParams();
  const locale = useLocale();
  const t = useT('legalShell');
  const actual = LEGAL.find((d) => d.id === doc);
  useSeo({
    title: actual?.title[locale] || t('fallbackTitle'),
    description: actual?.description[locale],
    path: `/legal/${actual?.id || ''}`,
    noindex: !actual,
  });

  if (!actual) {
    if (doc && LEGACY_LEGAL_IDS[doc]) return <Navigate to={`/legal/${LEGACY_LEGAL_IDS[doc]}`} replace />;
    return <Navigate to="/legal/privacy" replace />;
  }
  const Body = actual.Body[locale];

  return (
    <div className="page">
      <PublicNav />
      <div className="legal">
        <nav className="legal__nav" aria-label={t('ariaLabel')}>
          {LEGAL.map((d) => (
            <Link key={d.id} to={`/legal/${d.id}`} className={`legal__link ${d.id === actual.id ? 'is-active' : ''}`}>
              {d.title[locale]}
            </Link>
          ))}
        </nav>
        <article className="docs__content legal__cuerpo">
          <span className="docs__eyebrow">{t('eyebrow')} {VIGENCIA[locale]}</span>
          <Body />
        </article>
      </div>
      <PublicFooter />
    </div>
  );
}
