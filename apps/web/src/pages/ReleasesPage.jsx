// ReleasesPage.jsx — novedades públicas (/news): historial de versiones de
// la app de escritorio con su changelog. La app enlaza aquí con #v<version>.
import { useSeo } from '../lib/seo';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Link } from '../i18n/link';
import { useT } from '../i18n/useT';
import { PublicNav } from '../components/PublicNav';
import { PublicFooter } from '../components/PublicFooter';

function formatDate(raw, dateLocale) {
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString(dateLocale, { day: 'numeric', month: 'long', year: 'numeric' });
}

export default function ReleasesPage() {
  const t = useT('releases');
  const nav = useT('nav');
  useSeo({ title: t('seoTitle'), description: t('seoDescription'), path: '/news' });
  const [versions, setVersions] = useState(null);

  useEffect(() => {
    api.get('/api/versions')
      .then((res) => setVersions(Array.isArray(res.data) ? res.data : []))
      .catch(() => setVersions([]));
  }, []);

  // Al llegar con un ancla (#v0.3.2), desplazar hasta esa versión.
  useEffect(() => {
    if (versions && window.location.hash) {
      const el = document.getElementById(window.location.hash.slice(1));
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [versions]);

  return (
    <div className="page">
      <PublicNav />
      <main className="page__body page__body--wide">
        <h1 className="page__title page__title--center">{t('seoTitle')}</h1>
        <p className="plans__sub">{t('subtitle')}</p>

        {versions === null ? (
          <p className="releases__empty">{t('loading')}</p>
        ) : versions.length === 0 ? (
          <p className="releases__empty">{t('empty')}</p>
        ) : (
          <ol className="releases">
            {versions.map((v) => (
              <li key={`${v.version}-${v.channel}`} id={`v${v.version}`} className="release">
                <div className="release__head">
                  <div className="release__title-wrap">
                    <span className="release__version">v{v.version}</span>
                    {v.channel && v.channel !== 'stable' && (
                      <span className="release__channel">{v.channel}</span>
                    )}
                    <h2 className="release__title">{v.title}</h2>
                  </div>
                  <span className="release__date">{formatDate(v.release_date, t('dateLocale'))}</span>
                </div>
                {Array.isArray(v.changelog) && v.changelog.length > 0 && (
                  <ul className="release__changelog">
                    {v.changelog.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}

        <p className="downloads__foot">
          {t('footBefore')} <Link to="/apps">{nav('apps')}</Link>{t('footAfter')}
        </p>
      </main>
      <PublicFooter />
    </div>
  );
}
