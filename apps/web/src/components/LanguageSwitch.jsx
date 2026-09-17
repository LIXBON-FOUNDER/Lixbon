// LanguageSwitch.jsx — alterna es/en manteniendo la misma página: el slug es
// igual en los dos idiomas, así que solo hace falta añadir o quitar /en.
import { useLocation, useNavigate } from 'react-router-dom';
import { useLocale } from '../i18n/LocaleContext';
import { otherLocalePath } from '../i18n/paths';
import { IconGlobe } from './Icons';

export function LanguageSwitch({ className = 'icon-btn', showLabel = false }) {
  const locale = useLocale();
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();

  const go = () => navigate(`${otherLocalePath(pathname)}${search}${hash}`);
  const next = locale === 'es' ? 'EN' : 'ES';

  return (
    <button
      type="button"
      className={className}
      onClick={go}
      aria-label={locale === 'es' ? 'Switch to English' : 'Cambiar a español'}
      title={locale === 'es' ? 'Switch to English' : 'Cambiar a español'}
    >
      <IconGlobe size={16} />
      {showLabel && <span>{next}</span>}
      {!showLabel && <span aria-hidden="true" className="lang-switch__code">{next}</span>}
    </button>
  );
}
