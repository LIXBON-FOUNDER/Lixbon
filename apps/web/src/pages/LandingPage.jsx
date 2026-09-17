// LandingPage.jsx — la portada pública de lixbon.com (/). Minimalista: una
// columna, titulares grandes, secciones numeradas y dos dibujos de línea. Es
// la página que posiciona: todo el texto va en HTML, con FAQPage.
import { useMemo } from 'react';
import { Link } from '../i18n/link';
import { useLocale } from '../i18n/LocaleContext';
import { useT } from '../i18n/useT';
import { PublicNav } from '../components/PublicNav';
import { Logo } from '../components/Logo';
import { IconArrowLeft } from '../components/Icons';
import { IlustracionCluster, IlustracionPrivacidad } from '../components/IlustracionesLanding';
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
  const nav = useT('nav');
  const common = useT('common');

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
    <div className="page landing">
      <PublicNav />

      <main className="landing__wrap">
        <section className="landing__hero">
          <h1 className="landing__h1">{t('heroTitle')}</h1>
          <p className="landing__lead">{t('heroLead')}</p>
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
        </section>

        <section className="landing__banda"><IlustracionCluster /></section>

        <section className="landing__fila">
          <div>
            <span className="landing__num">{t('section1Num')}</span>
            <h2 className="landing__h2">{t('section1Title')}</h2>
            <p className="landing__p">{t('section1P1')}</p>
            <p className="landing__p">{t('section1P2')}</p>
          </div>
          <div><IlustracionPrivacidad /></div>
        </section>

        <section className="landing__fila landing__fila--inv">
          <div>
            <span className="landing__num">{t('section2Num')}</span>
            <h2 className="landing__h2">{t('section2Title')}</h2>
          </div>
          <ul className="landing__lista">
            {t('products').map(({ title, text, href }) => (
              <li key={title}>
                <h3><Link to={href}>{title}</Link></h3>
                <p>{text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="landing__fila">
          <div>
            <span className="landing__num">{t('section3Num')}</span>
            <h2 className="landing__h2">{t('section3Title')}</h2>
            <p className="landing__p">{t('section3P')}</p>
            <Link to="/docs/using-your-api-key" className="landing__enlace">{t('section3Link')} <Flecha /></Link>
          </div>
          <pre className="landing__codigo"><code>{CODIGO}</code></pre>
        </section>

        <section className="landing__bloque">
          <span className="landing__num">{t('section4Num')}</span>
          <h2 className="landing__h2">{t('section4Title')}</h2>
          <p className="landing__p">{t('section4P')}</p>
          <div className="landing__precios">
            {t('plans').map(({ name, price, period, lines }) => (
              <div key={name} className="landing__precio">
                <h3>{name}</h3>
                <p className="landing__cifra">{price}{period && <span> {period}</span>}</p>
                <p>{lines.map((l) => <span key={l}>{l}<br /></span>)}</p>
              </div>
            ))}
          </div>
          <p className="landing__nota landing__enlaces"><Link to="/plans" className="landing__enlace">{t('seePlans')} <Flecha /></Link><Link to="/docs/api-pricing" className="landing__enlace">{t('apiPricingLink')} <Flecha /></Link></p>
        </section>

        <section className="landing__bloque">
          <span className="landing__num">{t('section5Num')}</span>
          <ul className="landing__faq">
            {t('faq').map(({ q, a }) => <li key={q}><h3>{q}</h3><p>{a}</p></li>)}
          </ul>
        </section>

        <section className="landing__final">
          <h2 className="landing__h2">{t('finalTitle')}</h2>
          <p className="landing__p">{t('finalP')}</p>
          <Link to={user ? '/chat' : '/auth?mode=register'} className="pill-btn pill-btn--primary landing__btn">{user ? t('ctaGoToChat') : t('ctaCreateAccount')}</Link>
        </section>

        <footer className="landing__pie">
          <div><Logo /><p>{t('footerLocation')} · © {new Date().getFullYear()}</p></div>
          <nav><Link to="/docs">{nav('docs')}</Link><Link to="/guides">{nav('guides')}</Link><Link to="/apps">{nav('apps')}</Link><Link to="/plans">{nav('plans')}</Link></nav>
          <nav><Link to="/legal/privacy">{nav('footerPrivacy')}</Link><Link to="/legal/terms">{nav('footerTerms')}</Link><Link to="/legal/refunds">{nav('footerRefunds')}</Link><Link to="/status">{nav('footerStatus')}</Link><a href="mailto:soporte@lixbon.com">{common('support')}</a></nav>
        </footer>
      </main>
    </div>
  );
}
