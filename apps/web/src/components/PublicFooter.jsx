// PublicFooter.jsx — pie común de las páginas públicas. Oscuro en los dos
// temas: cierra la página como la noche cierra el paisaje. Arriba una frase y
// la llamada, en medio el mapa del sitio y abajo el wordmark a todo lo ancho,
// que se monta letra a letra al entrar en vista.
import { Link } from '../i18n/link';
import { useAuth } from '../hooks/useAuth';
import { useRevelar } from '../hooks/useRevelar';
import { useT } from '../i18n/useT';
import { Logo } from './Logo';

const SOPORTE = 'support@lixbon.com';

export function PublicFooter() {
  const t = useT('nav');
  const tc = useT('common');
  const { user } = useAuth();
  const ref = useRevelar();

  const COLUMNAS = [
    {
      titulo: t('footerProduct'),
      enlaces: [
        { to: '/docs/chat', label: t('productChat') },
        { to: '/docs/visuals', label: 'Visuals' },
        { to: '/docs/cli', label: t('productCli') },
        { to: '/docs/api', label: t('productApi') },
        { to: '/plans', label: t('plans') },
      ],
    },
    {
      titulo: t('footerResources'),
      enlaces: [
        { to: '/docs', label: t('docs') },
        { to: '/guides', label: t('guides') },
        { to: '/apps', label: t('apps') },
        { to: '/news', label: t('footerNews') },
        { to: '/status', label: t('footerStatus') },
      ],
    },
    {
      titulo: t('footerLegal'),
      enlaces: [
        { to: '/legal/privacy', label: t('footerPrivacy') },
        { to: '/legal/terms', label: t('footerTerms') },
        { to: '/legal/refunds', label: t('footerRefunds') },
        { to: '/support', label: tc('support') },
      ],
    },
  ];

  return (
    <footer className="pubfoot" ref={ref}>
      <div className="pubfoot__in">
        <div className="pubfoot__arriba" data-revelar>
          <p className="pubfoot__frase">{t('footerTagline')}</p>
          <Link to={user ? '/chat' : '/auth?mode=register'} className="pubfoot__cta">
            {user ? tc('goToChat') : tc('tryLixbon')}
          </Link>
        </div>

        <div className="pubfoot__mapa">
          {COLUMNAS.map((c, i) => (
            <nav key={c.titulo} className="pubfoot__col" aria-label={c.titulo} data-revelar style={{ '--retraso': `${i * 80}ms` }}>
              <h2>{c.titulo}</h2>
              {c.enlaces.map((e) => (e.href
                ? <a key={e.label} href={e.href}>{e.label}</a>
                : <Link key={e.label} to={e.to}>{e.label}</Link>))}
            </nav>
          ))}
          <div className="pubfoot__contacto" data-revelar style={{ '--retraso': '240ms' }}>
            <h2>{t('footerContact')}</h2>
            <a href={`mailto:${SOPORTE}`}>{SOPORTE}</a>
            <span>{t('footerLocation')}</span>
          </div>
        </div>

        <div className="pubfoot__marca" data-revelar>
          <Logo animado size={null} mark={false} className="pubfoot__wordmark" />
        </div>

        <div className="pubfoot__base">
          <span>© {new Date().getFullYear()} lixbon</span>
          <span>{t('footerMade')}</span>
        </div>
      </div>
    </footer>
  );
}
