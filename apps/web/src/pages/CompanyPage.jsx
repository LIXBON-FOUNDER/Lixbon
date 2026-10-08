import { Link } from '../i18n/link';
import { useT } from '../i18n/useT';
import { PublicNav } from '../components/PublicNav';
import { PublicFooter } from '../components/PublicFooter';
import { useSeo } from '../lib/seo';
import { RESPONSABLE } from './legalShared';
import { EQUIPO } from './companyShared';

const FOUNDER_EMAIL = 'founder@lixbon.com';

export default function CompanyPage() {
  const t = useT('company');
  const tl = useT('landing');
  useSeo({ title: t('seoTitle'), description: t('seoDescription'), path: '/about' });

  const datos = [
    [t('started'), t('startedValue')],
    [t('location'), RESPONSABLE.direccion],
    [t('founders'), EQUIPO.map((p) => p.nombre).join(' · ')],
    [t('legal'), `${RESPONSABLE.nombre} (${RESPONSABLE.nit})`],
    [t('domain'), <a href="https://lixbon.com">lixbon.com</a>],
    [t('github'), <a href="https://github.com/LIXBON-FOUNDER" target="_blank" rel="noopener noreferrer">github.com/LIXBON-FOUNDER ↗</a>],
    [t('contact'), (
      <>
        <a href={`mailto:${FOUNDER_EMAIL}`}>{FOUNDER_EMAIL}</a>
        {' · '}
        <a href={`mailto:${RESPONSABLE.soporte}`}>{RESPONSABLE.soporte}</a>
      </>
    )],
  ];

  return (
    <div className="page web">
      <PublicNav />
      <main className="empresa">
        <header className="empresa__hero">
          <h1 className="empresa__titulo">{t('title')}</h1>
          <p className="empresa__lead">{t('lead')}</p>
          <Link to="/team" className="pill-btn pill-btn--primary empresa__cta">{t('meetTeam')}</Link>
        </header>

        <section className="empresa__seccion empresa__seccion--partida">
          <h2 className="empresa__h2">{t('purposeTitle')}</h2>
          <div>
            <p className="empresa__intro">{t('purposeLead')}</p>
            <div className="empresa__puntos">
              {t('purpose').map(([titulo, texto]) => (
                <div key={titulo}>
                  <h3>{titulo}</h3>
                  <p>{texto}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="empresa__seccion">
          <h2 className="empresa__h2">{t('productsTitle')}</h2>
          <div className="empresa__tarjetas">
            {tl('products').map((p) => (
              <Link key={p.title} to={p.href} className="empresa__tarjeta">
                <h3>{p.title}</h3>
                <p>{p.text}</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="empresa__seccion">
          <h2 className="empresa__h2">{t('valuesTitle')}</h2>
          <ol className="empresa__valores">
            {t('values').map(([titulo, texto], i) => (
              <li key={titulo} className="empresa__valor">
                <span className="empresa__num">{String(i + 1).padStart(2, '0')}</span>
                <h3>{titulo}</h3>
                <p>{texto}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="empresa__seccion empresa__seccion--partida">
          <h2 className="empresa__h2">{t('companyTitle')}</h2>
          <div>
            <p className="empresa__intro">{t('companyLead')}</p>
            <dl className="empresa__datos">
              {datos.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="empresa__seccion empresa__seccion--partida">
          <h2 className="empresa__h2">{t('buildTitle')}</h2>
          <p className="empresa__intro">{t('buildText')}</p>
        </section>

        <section className="empresa__banda">
          <p className="empresa__banda-titulo">{t('ctaTitle')}</p>
          <Link to="/team" className="pill-btn pill-btn--primary">{t('ctaLink')}</Link>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
