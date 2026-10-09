// Con sesión no pide el correo: responde al de la cuenta.
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Link } from '../i18n/link';
import { useT } from '../i18n/useT';
import { useSeo } from '../lib/seo';
import { useLocale } from '../i18n/LocaleContext';
import { PreguntaLixbon } from '../components/PreguntaLixbon';
import { MascotaGuia } from '../components/Mascota';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import { PublicNav } from '../components/PublicNav';
import { PublicFooter } from '../components/PublicFooter';
import { IconAlert, IconCheck, IconArrowLeft } from '../components/Icons';

const SOPORTE = 'support@lixbon.com';
const MIN_MENSAJE = 20;
const MAX_MENSAJE = 5000;

const CATEGORIAS = ['account', 'billing', 'refund', 'bug', 'api', 'apps', 'privacy', 'feedback', 'other'];

const Flecha = () => <IconArrowLeft size={15} style={{ transform: 'rotate(180deg)' }} />;

export default function SupportPage() {
  const t = useT('support');
  const { user } = useAuth();
  const [params] = useSearchParams();
  const inicial = CATEGORIAS.includes(params.get('type')) ? params.get('type') : 'bug';

  const [categoria, setCategoria] = useState(inicial);
  const [asunto, setAsunto] = useState('');
  const [mensaje, setMensaje] = useState('');
  const [correo, setCorreo] = useState('');
  const [nombre, setNombre] = useState('');
  const [trampa, setTrampa] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState('');
  const [hecho, setHecho] = useState(null);

  const tl = useT('landing');
  const locale = useLocale();
  const [preguntando, setPreguntando] = useState(false);
  const jsonLd = useMemo(() => ({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: tl('faq').map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
    // eslint-disable-next-line
  }), [locale]);
  useSeo({ title: t('seoTitle'), description: t('seoDescription'), path: '/support', jsonLd });

  const pista = t(`hints.${categoria}`);
  const tienePista = pista !== `hints.${categoria}`;
  const valido = asunto.trim().length >= 3 && mensaje.trim().length >= MIN_MENSAJE && (user || correo.includes('@'));

  const enviar = async (e) => {
    e.preventDefault();
    if (!valido || enviando) return;
    setEnviando(true);
    setError('');
    try {
      const { data } = await api.post('/api/support', {
        category: categoria,
        subject: asunto.trim(),
        message: mensaje.trim(),
        email: user ? undefined : correo.trim(),
        name: user ? undefined : nombre.trim() || undefined,
        page: typeof document !== 'undefined' && document.referrer ? document.referrer.slice(0, 300) : undefined,
        website: trampa || undefined,
      });
      setHecho({ ticket: data.ticket, email: data.email || correo.trim() });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      const detalle = err.response?.data?.detail;
      setError(typeof detalle === 'string' ? detalle : t('errorGeneric'));
    } finally {
      setEnviando(false);
    }
  };

  const otroCaso = () => {
    setHecho(null);
    setAsunto('');
    setMensaje('');
  };

  return (
    <div className="page web soporte">
      <PublicNav />

      <main className="soporte__wrap">
        <header className="soporte__cabecera">
          <h1 className="soporte__titulo">{hecho ? t('doneTitle') : t('title')}</h1>
          {!hecho && <p className="soporte__lead">{t('lead')}</p>}
        </header>

        {!hecho && (
          <section className="soporte__faq" data-mascota="faq">
            <h2 className="soporte__h2">{tl('faqTitle')}</h2>
            <div className={`landing__faqbox ${preguntando ? 'is-preguntando' : ''}`}>
              <div className="landing__faq" inert={preguntando}>
                {tl('faq').map(({ q, a }) => (
                  <details key={q}>
                    <summary><h3>{q}</h3><span className="landing__faq-mas" aria-hidden="true" /></summary>
                    <p>{a}</p>
                  </details>
                ))}
              </div>
              <PreguntaLixbon abierta={preguntando} onAbrir={() => setPreguntando(true)} onCerrar={() => setPreguntando(false)} />
            </div>
          </section>
        )}

        <div className="soporte__rejilla">
          {hecho ? (
            <section className="soporte__hecho">
              <span className="soporte__hecho-icono"><IconCheck size={22} /></span>
              <p className="soporte__hecho-texto">{t('doneText', { email: hecho.email })}</p>
              <div className="soporte__ticket">
                <span>{t('doneTicket')}</span>
                <strong>{hecho.ticket}</strong>
              </div>
              <button type="button" className="pill-btn pill-btn--outline" onClick={otroCaso}>{t('doneAnother')}</button>
            </section>
          ) : (
            <form className="soporte__form" onSubmit={enviar} noValidate>
              <h2 className="soporte__h2">{t('formTitle')}</h2>
              <fieldset className="soporte__tipos">
                <legend className="soporte__etiqueta">{t('categoryLabel')}</legend>
                {CATEGORIAS.map((id) => {
                  const [titulo, desc] = t(`categories.${id}`);
                  return (
                    <label key={id} className={`soporte__tipo ${categoria === id ? 'is-on' : ''}`} title={desc}>
                      <input type="radio" name="categoria" value={id} checked={categoria === id} onChange={() => setCategoria(id)} />
                      {titulo}
                    </label>
                  );
                })}
              </fieldset>

              {tienePista && <p className="soporte__pista"><IconAlert size={15} /> {pista}</p>}

              <label className="soporte__campo">
                <span className="soporte__etiqueta">{t('subject')}</span>
                <input value={asunto} onChange={(e) => setAsunto(e.target.value)} maxLength={140} placeholder={t('subjectPh')} required />
              </label>

              <label className="soporte__campo">
                <span className="soporte__etiqueta">{t('message')}</span>
                <textarea value={mensaje} onChange={(e) => setMensaje(e.target.value)} maxLength={MAX_MENSAJE} rows={8} placeholder={t('messagePh')} required />
                <span className={`soporte__cuenta ${mensaje.trim().length && mensaje.trim().length < MIN_MENSAJE ? 'is-corto' : ''}`}>
                  {mensaje.trim().length < MIN_MENSAJE ? t('minChars') : `${mensaje.length} / ${MAX_MENSAJE} ${t('chars')}`}
                </span>
              </label>

              {user ? (
                <p className="soporte__como">{t('sendingAs')} <strong>{user.email}</strong></p>
              ) : (
                <div className="soporte__dos">
                  <label className="soporte__campo">
                    <span className="soporte__etiqueta">{t('email')}</span>
                    <input type="email" value={correo} onChange={(e) => setCorreo(e.target.value)} placeholder={t('emailPh')} autoComplete="email" required />
                  </label>
                  <label className="soporte__campo">
                    <span className="soporte__etiqueta">{t('name')}</span>
                    <input value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={80} autoComplete="name" />
                  </label>
                </div>
              )}

              {/* Trampa para bots: fuera de la vista y del tabulador. */}
              <input className="soporte__trampa" tabIndex={-1} autoComplete="off" aria-hidden="true" value={trampa} onChange={(e) => setTrampa(e.target.value)} name="website" />

              {error && <p className="page__error" role="alert">{error}</p>}

              <button type="submit" className="pill-btn pill-btn--primary soporte__enviar" disabled={!valido || enviando}>
                {enviando ? t('sending') : t('send')}
              </button>
            </form>
          )}

          <aside className="soporte__lado">
            <h2 className="soporte__lado-titulo">{t('asideTitle')}</h2>
            <nav className="soporte__atajos">
              {[
                ['/docs', 'asideDocs'],
                ['/status', 'asideStatus'],
                ['/account/billing', 'asideBilling'],
                ['/legal/refunds', 'asideRefunds'],
              ].map(([to, clave]) => {
                const [titulo, desc] = t(clave);
                return (
                  <Link key={to} to={to} className="soporte__atajo">
                    <span><strong>{titulo} <Flecha /></strong><small>{desc}</small></span>
                  </Link>
                );
              })}
            </nav>
            <p className="soporte__directo">{t('asideDirect')} <a href={`mailto:${SOPORTE}`}>{SOPORTE}</a></p>
          </aside>
        </div>
      </main>

      <PublicFooter />
      <MascotaGuia selector="[data-mascota]" />
    </div>
  );
}
