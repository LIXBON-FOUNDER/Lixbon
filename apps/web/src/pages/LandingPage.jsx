import { useMemo, useState } from 'react';
import { Link } from '../i18n/link';
import { useLocale } from '../i18n/LocaleContext';
import { useT } from '../i18n/useT';
import { PublicNav } from '../components/PublicNav';
import { PublicFooter } from '../components/PublicFooter';
import { IconArrowLeft } from '../components/Icons';
import { PaisajeAmanecer, PaisajeCosta, PaisajeCrepusculo } from '../components/Paisajes';
import { useRevelar } from '../hooks/useRevelar';
import { ORGANIZACION, SITE_URL, useSeo } from '../lib/seo';
import { useAuth } from '../hooks/useAuth';
import { MascotaGuia } from '../components/Mascota';

const Flecha = () => <IconArrowLeft size={15} style={{ transform: 'rotate(180deg)' }} />;

// Los videos se suben a apps/web/public/landing/; hasta entonces queda el hueco vacío.
function VideoProducto({ src }) {
  const [falta, setFalta] = useState(false);
  return (
    <div className="landing__video">
      {!falta && <video src={src} autoPlay muted loop playsInline preload="metadata" onError={() => setFalta(true)} />}
    </div>
  );
}

export default function LandingPage() {
  const { user } = useAuth();
  const locale = useLocale();
  const t = useT('landing');
  const revelar = useRevelar();

  const jsonLd = useMemo(() => [
    ORGANIZACION,
    { '@context': 'https://schema.org', '@type': 'WebSite', name: 'lixbon', url: SITE_URL, inLanguage: locale },
  ], [locale]);

  useSeo({
    title: t('seoTitle'),
    description: t('seoDescription'),
    path: '/',
    jsonLd,
  });

  return (
    <div className="page web landing" ref={revelar}>
      <PublicNav />

      <main>
        <section className="landing__hero landing__wrap" data-mascota="hero">
          <h1 className="landing__h1">{t('heroTitle')}</h1>
          <div className="landing__hero-pie">
            <p className="landing__lead">{t('heroLead')}</p>
            <div>
              {user ? (
                <Link to="/chat" className="btn-negro landing__btn">{t('ctaGoToChat')}</Link>
              ) : (
                <div className="btn-grupo btn-grupo--grande">
                  <Link to="/auth?mode=register" className="btn-grupo__item">{t('ctaStartFree')}</Link>
                </div>
              )}
              {!user && <p className="landing__nota">{t('freeNote')}</p>}
            </div>
          </div>
        </section>

        <figure className="landing__lienzo landing__lienzo--hero">
          <PaisajeAmanecer />
          <figcaption>{t('paintingHero')}</figcaption>
        </figure>

        <section className="landing__fila landing__wrap">
          <div data-revelar data-mascota="private">
            <h2 className="landing__h2">{t('section1Title')}</h2>
            <p className="landing__p">{t('section1P1')}</p>
          </div>
          <figure className="landing__lienzo landing__lienzo--retrato" data-revelar>
            <PaisajeCosta />
            <figcaption>{t('paintingCoast')}</figcaption>
          </figure>
        </section>

        <section className="landing__bloque landing__wrap">
          <h2 className="landing__h2" data-revelar data-mascota="products">{t('section2Title')}</h2>
          <ul className="landing__productos">
            {t('products').map(({ title, text, href, video }, i) => (
              <li key={title} data-revelar style={{ '--retraso': `${i * 70}ms` }}>
                <Link to={href}>
                  <VideoProducto src={video} />
                  <h3>{title}<Flecha /></h3>
                  <p>{text}</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section className="landing__final" data-revelar data-mascota="final">
          <PaisajeCrepusculo className="landing__final-fondo" />
          <div className="landing__final-texto">
            <h2 className="landing__h2">{t('finalTitle')}</h2>
            <p className="landing__p">{t('finalP')}</p>
            <Link to={user ? '/chat' : '/auth?mode=register'} className="landing__btn landing__btn--claro">{user ? t('ctaGoToChat') : t('ctaCreateAccount')}</Link>
          </div>
        </section>
      </main>

      <PublicFooter />
      <MascotaGuia selector="[data-mascota]" />
    </div>
  );
}
