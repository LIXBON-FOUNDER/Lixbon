import { Link } from '../i18n/link';
import { useLocale } from '../i18n/LocaleContext';
import { useT } from '../i18n/useT';
import { useRevelar } from '../hooks/useRevelar';
import { urlFounder } from '../lib/founder';
import { useDonaciones } from '../lib/donaciones';
import { Enfasis } from './Enfasis';

const SOPORTE = 'support@lixbon.com';

// El mismo pie que founder.lixbon.com. Lo de la empresa (soporte, legal,
// donativos) vive allí y aquí queda como enlace.
export function PublicFooter() {
  const t = useT('nav');
  const tc = useT('common');
  const locale = useLocale();
  const founder = (ruta) => urlFounder(ruta, locale);
  const revelar = useRevelar();
  const donar = useDonaciones()?.enabled;

  const COLUMNAS = [
    {
      titulo: t('footerProduct'),
      enlaces: [
        { to: '/chat', label: t('productChat') },
        { to: '/visuals', label: 'Visuals' },
        { to: '/apps', label: t('apps') },
        { to: '/docs/api', label: t('productApi') },
      ],
    },
    {
      titulo: t('footerDevelopers'),
      enlaces: [
        { to: '/docs', label: t('docs') },
        { to: '/guides', label: t('guides') },
        { to: '/skills', label: t('skills') },
        { to: '/status', label: t('footerStatus') },
      ],
    },
    {
      titulo: t('footerCompany'),
      enlaces: [
        { href: founder('/about'), label: t('footerAbout') },
        { href: founder('/news'), label: t('footerNews') },
        { href: founder('/donate'), label: t('donate') },
        { href: founder('/support'), label: tc('support') },
      ],
    },
    {
      titulo: t('footerHelp'),
      enlaces: [
        { href: founder('/legal/privacy'), label: t('footerPrivacy') },
        { href: founder('/legal/terms'), label: t('footerTerms') },
      ],
    },
  ];

  return (
    <footer className="pubfoot" ref={revelar}>
      <div className="pubfoot__in">
        <div className="pubfoot__arriba">
          <p className="pubfoot__frase"><Enfasis texto={t('footerTagline')} /></p>
          <div className="pubfoot__botones">
            <Link to="/chat" className="pill pill--crema">{tc('tryLixbon')}</Link>
            {donar && <a href={founder('/donate')} className="pill pill--oliva">{t('donate')}</a>}
          </div>
        </div>
        <div className="pubfoot__mapa">
          {COLUMNAS.map((c) => (
            <nav key={c.titulo} className="pubfoot__col" aria-label={c.titulo}>
              <h2>{c.titulo}</h2>
              {c.enlaces.map((e) => (e.to
                ? <Link key={e.label} to={e.to}>{e.label}</Link>
                : <a key={e.label} href={e.href}>{e.label}</a>))}
            </nav>
          ))}
          <div className="pubfoot__col">
            <h2>{t('footerContact')}</h2>
            <a href={`mailto:${SOPORTE}`}>{SOPORTE}</a>
            <span>{t('footerLocation')}</span>
          </div>
        </div>
        <p className="pubfoot__wordmark" aria-hidden="true" data-revelar>
          {[...'lixbon'].map((l, i) => <span key={i} style={{ '--i': i }}>{l}</span>)}
        </p>
        <div className="pubfoot__base">
          <span>© {new Date().getFullYear()} lixbon</span>
          <a href={founder('/')}>{t('byFounder')} ↗</a>
        </div>
      </div>
    </footer>
  );
}
