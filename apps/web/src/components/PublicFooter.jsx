// PublicFooter.jsx — pie común de las páginas públicas: enlaces legales y soporte.
import { Link } from '../i18n/link';
import { useT } from '../i18n/useT';

export function PublicFooter() {
  const t = useT('nav');
  const tc = useT('common');
  return (
    <footer className="pubfoot">
      <span className="pubfoot__marca">© {new Date().getFullYear()} lixbon</span>
      <nav className="pubfoot__links" aria-label="Legal">
        <Link to="/guides">{t('guides')}</Link>
        <Link to="/status">{t('footerStatus')}</Link>
        <Link to="/legal/privacy">{t('footerPrivacy')}</Link>
        <Link to="/legal/terms">{t('footerTerms')}</Link>
        <Link to="/legal/refunds">{t('footerRefunds')}</Link>
        <a href="mailto:soporte@lixbon.com">{tc('support')}</a>
      </nav>
    </footer>
  );
}
