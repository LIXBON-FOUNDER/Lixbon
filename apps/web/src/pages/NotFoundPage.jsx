// NotFoundPage.jsx — la ruta que no existe (comodín `*` en App.jsx).
// El 404 gigante es relleno, no texto: la jerarquía la hace la superficie.
import { useSeo } from '../lib/seo';
import { useLocation } from 'react-router-dom';
import { Link } from '../i18n/link';
import { useT } from '../i18n/useT';
import { PublicNav } from '../components/PublicNav';
import { ClusterCaido } from '../components/ClusterCaido';

export default function NotFoundPage() {
  const t = useT('notFound');
  useSeo({ title: t('seoTitle'), noindex: true });
  const { pathname } = useLocation();

  return (
    <div className="page notfound">
      <ClusterCaido />
      <PublicNav />

      <main className="notfound__body">
        <div className="notfound__numeral" aria-hidden="true">404</div>

        <div className="notfound__row">
          <div className="notfound__text">
            <h1 className="page__title">{t('title')}</h1>
            <p className="notfound__lead">
              {t('leadBefore')} <code className="mono notfound__ruta">{pathname}</code> {t('leadAfter')}
            </p>
          </div>

          <div className="notfound__actions">
            <Link to="/docs" className="pill-btn pill-btn--outline">{t('docs')}</Link>
            <Link to="/chat" className="pill-btn pill-btn--primary">{t('goToChat')}</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
