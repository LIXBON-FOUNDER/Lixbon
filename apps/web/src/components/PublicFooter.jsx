import { Link } from '../i18n/link';
import { useLocale } from '../i18n/LocaleContext';
import { useT } from '../i18n/useT';
import { urlFounder } from '../lib/founder';

// lixbon.com solo es el producto: lo de la empresa (soporte, legal, donativos)
// vive en founder.lixbon.com y aquí queda como enlace.
export function PublicFooter() {
  const t = useT('nav');
  const tc = useT('common');
  const locale = useLocale();

  const COLUMNAS = [
    {
      titulo: t('footerProduct'),
      enlaces: [
        { to: '/chat', label: t('productChat') },
        { to: '/visuals', label: 'Visuals' },
        { to: '/apps', label: t('apps') },
        { to: '/skills', label: t('skills') },
      ],
    },
    {
      titulo: t('footerDevelopers'),
      enlaces: [
        { to: '/docs', label: t('docs') },
        { to: '/docs/api', label: t('productApi') },
        { to: '/guides', label: t('guides') },
        { to: '/status', label: t('footerStatus') },
      ],
    },
    {
      titulo: t('footerHelp'),
      enlaces: [
        { to: '/support', label: tc('support') },
        { to: '/news', label: t('footerNews') },
        { to: '/legal/privacy', label: t('footerPrivacy') },
        { to: '/legal/terms', label: t('footerTerms') },
      ],
    },
  ];

  return (
    <footer className="pubfoot pubfoot--producto">
      <div className="pubfoot__in">
        <div className="pubfoot__mapa">
          {COLUMNAS.map((c) => (
            <nav key={c.titulo} className="pubfoot__col" aria-label={c.titulo}>
              <h2>{c.titulo}</h2>
              {c.enlaces.map((e) => <Link key={e.to} to={e.to}>{e.label}</Link>)}
            </nav>
          ))}
        </div>
        <div className="pubfoot__base">
          <span>© {new Date().getFullYear()} lixbon</span>
          <a href={urlFounder('/', locale)}>{t('byFounder')} ↗</a>
        </div>
      </div>
    </footer>
  );
}
