// LandingPage.jsx — la portada pública de lixbon.com (/). Minimalista y
// cálida: titulares en Lancelot, mucho aire, secciones numeradas y cuatro
// paisajes pintados (Paisajes.jsx) que se mueven despacio con el scroll. Es
// la página que posiciona: todo el texto va en HTML, con FAQPage.
import { useMemo } from 'react';
import { Link } from '../i18n/link';
import { useLocale } from '../i18n/LocaleContext';
import { useT } from '../i18n/useT';
import { PublicNav } from '../components/PublicNav';
import { PublicFooter } from '../components/PublicFooter';
import { IconArrowLeft } from '../components/Icons';
import { PaisajeAmanecer, PaisajeCosta, PaisajeCrepusculo, PaisajeValle } from '../components/Paisajes';
import { useRevelar } from '../hooks/useRevelar';
import { ORGANIZACION, SITE_URL, useSeo } from '../lib/seo';
import { useAuth } from '../hooks/useAuth';

const CODIGO = `from openai import OpenAI

client = OpenAI(
    base_url="https://lixbon.com/v1",
    api_key="lixbon_sk_tu_clave",
)

resp = client.chat.completions.create(
    model="lixbon-1",
    messages=[{"role": "user", "content": "Hola"}],
)
print(resp.choices[0].message.content)`;

const Flecha = () => <IconArrowLeft size={15} style={{ transform: 'rotate(180deg)' }} />;

export default function LandingPage() {
  const { user } = useAuth();
  const locale = useLocale();
  const t = useT('landing');
  const revelar = useRevelar();

  const jsonLd = useMemo(() => [
    ORGANIZACION,
    { '@context': 'https://schema.org', '@type': 'WebSite', name: 'lixbon', url: SITE_URL, inLanguage: locale },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: t('faq').map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
    },
    // eslint-disable-next-line
  ], [locale]);

  useSeo({
    title: t('seoTitle'),
    description: t('seoDescription'),
    path: '/',
    jsonLd,
  });

  return (
    <div className="page landing" ref={revelar}>
      <PublicNav />

      <main>
        <section className="landing__hero landing__wrap">
          <p className="landing__eyebrow">{t('heroEyebrow')}</p>
          <h1 className="landing__h1">{t('heroTitle')}</h1>
          <div className="landing__hero-pie">
            <p className="landing__lead">{t('heroLead')}</p>
            <div>
              <div className="landing__cta">
                {user ? (
                  <Link to="/chat" className="pill-btn pill-btn--primary landing__btn">{t('ctaGoToChat')}</Link>
                ) : (
                  <>
                    <Link to="/auth?mode=register" className="pill-btn pill-btn--primary landing__btn">{t('ctaStartFree')}</Link>
                    <Link to="/chat" className="landing__enlace">{t('ctaTryChat')} <Flecha /></Link>
                  </>
                )}
              </div>
              {!user && <p className="landing__nota">{t('freeNote')}</p>}
            </div>
          </div>
        </section>

        <figure className="landing__lienzo landing__lienzo--hero">
          <PaisajeAmanecer />
          <figcaption>{t('paintingHero')}</figcaption>
        </figure>

        <section className="landing__fila landing__wrap">
          <div data-revelar>
            <span className="landing__num">{t('section1Num')}</span>
            <h2 className="landing__h2">{t('section1Title')}</h2>
            <p className="landing__p">{t('section1P1')}</p>
            <p className="landing__p">{t('section1P2')}</p>
          </div>
          <figure className="landing__lienzo landing__lienzo--retrato" data-revelar>
            <PaisajeCosta />
            <figcaption>{t('paintingCoast')}</figcaption>
          </figure>
        </section>

        <section className="landing__bloque landing__wrap">
          <div data-revelar>
            <span className="landing__num">{t('section2Num')}</span>
            <h2 className="landing__h2 landing__h2--ancho">{t('section2Title')}</h2>
          </div>
          <figure className="landing__lienzo landing__lienzo--banda" data-revelar>
            <PaisajeValle />
            <figcaption>{t('paintingValley')}</figcaption>
          </figure>
          <ul className="landing__productos">
            {t('products').map(({ title, text, href }, i) => (
              <li key={title} data-revelar style={{ '--retraso': `${i * 90}ms` }}>
                <h3><Link to={href}>{title} <Flecha /></Link></h3>
                <p>{text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="landing__fila landing__wrap">
          <div data-revelar>
            <span className="landing__num">{t('section3Num')}</span>
            <h2 className="landing__h2">{t('section3Title')}</h2>
            <p className="landing__p">{t('section3P')}</p>
            <Link to="/docs/using-your-api-key" className="landing__enlace">{t('section3Link')} <Flecha /></Link>
          </div>
          <pre className="landing__codigo" data-revelar><code>{CODIGO}</code></pre>
        </section>

        <section className="landing__bloque landing__wrap">
          <div data-revelar>
            <span className="landing__num">{t('section4Num')}</span>
            <h2 className="landing__h2">{t('section4Title')}</h2>
            <p className="landing__p">{t('section4P')}</p>
          </div>
          <div className="landing__precios">
            {t('plans').map(({ name, price, period, lines }, i) => (
              <div key={name} className="landing__precio" data-revelar style={{ '--retraso': `${i * 90}ms` }}>
                <h3>{name}</h3>
                <p className="landing__cifra">{price}{period && <span> {period}</span>}</p>
                <ul>{lines.map((l) => <li key={l}>{l}</li>)}</ul>
              </div>
            ))}
          </div>
          <p className="landing__enlaces"><Link to="/plans" className="landing__enlace">{t('seePlans')} <Flecha /></Link><Link to="/docs/api-pricing" className="landing__enlace">{t('apiPricingLink')} <Flecha /></Link></p>
        </section>

        <section className="landing__fila landing__fila--faq landing__wrap">
          <div data-revelar>
            <span className="landing__num">{t('section5Num')}</span>
            <h2 className="landing__h2">{t('faqTitle')}</h2>
          </div>
          <div className="landing__faq" data-revelar>
            {t('faq').map(({ q, a }) => (
              <details key={q}>
                <summary><h3>{q}</h3><span className="landing__faq-mas" aria-hidden="true" /></summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="landing__final" data-revelar>
          <PaisajeCrepusculo className="landing__final-fondo" />
          <div className="landing__final-texto">
            <h2 className="landing__h2">{t('finalTitle')}</h2>
            <p className="landing__p">{t('finalP')}</p>
            <Link to={user ? '/chat' : '/auth?mode=register'} className="landing__btn landing__btn--claro">{user ? t('ctaGoToChat') : t('ctaCreateAccount')}</Link>
          </div>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}
