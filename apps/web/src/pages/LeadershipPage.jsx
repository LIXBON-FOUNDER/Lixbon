import { Link } from '../i18n/link';
import { useT } from '../i18n/useT';
import { PublicNav } from '../components/PublicNav';
import { PublicFooter } from '../components/PublicFooter';
import { useSeo } from '../lib/seo';
import { EQUIPO, Retrato } from './companyShared';

export default function LeadershipPage() {
  const t = useT('company');
  useSeo({ title: t('leadershipSeoTitle'), description: t('leadershipSeoDescription'), path: '/team' });

  return (
    <div className="page web">
      <PublicNav />
      <main className="empresa">
        <header className="empresa__hero">
          <h1 className="empresa__titulo">{t('leadershipTitle')}</h1>
          <p className="empresa__lead">{t('leadershipLead')}</p>
        </header>

        <section className="empresa__seccion">
          <h2 className="empresa__h2">{t('foundersTitle')}</h2>
          <div className="empresa__personas">
            {EQUIPO.map((p) => (
              <article key={p.nombre} className="empresa__persona">
                <Retrato persona={p} />
                <h3>{p.nombre}</h3>
                <span className="empresa__rol">{t(p.rol)}</span>
                <p>{t(p.bio)}</p>
                {p.enlaces.length > 0 && (
                  <span className="empresa__enlaces">
                    {p.enlaces.map((e) => (
                      <a key={e.label} href={e.href} target="_blank" rel="noopener noreferrer">{e.label} ↗</a>
                    ))}
                  </span>
                )}
              </article>
            ))}
          </div>
        </section>

        <Link to="/about" className="pill-btn pill-btn--outline empresa__volver">{t('backToCompany')}</Link>
      </main>
      <PublicFooter />
    </div>
  );
}
