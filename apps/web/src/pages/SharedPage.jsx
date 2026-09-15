// SharedPage.jsx — vista pública de solo lectura de una conversación compartida
// (/s/:token). Sin sesión; muestra el hilo y un CTA para probar lixbon.
import { TemaBoton } from '../components/TemaBoton';
import { useSeo } from '../lib/seo';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Logo } from '../components/Logo';
import { Markdown } from '../components/Markdown';
import { construirVersiones, documentoPreview, extraerImagen } from '../lib/visuals';

export default function SharedPage() {
  useSeo({ title: 'Diseño compartido', noindex: true });
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/api/shared/${token}`)
      .then((res) => setData(res.data))
      .catch(() => setError('Este enlace no existe o fue revocado.'));
  }, [token]);

  if (error) {
    return (
      <div className="page">
        <header className="pubnav">
          <Link to="/" className="pubnav__logo"><Logo /></Link>
          <div className="pubnav__actions">
          <TemaBoton />
            <Link to="/chat" className="pill-btn pill-btn--primary pubnav__btn">Probar lixbon</Link>
          </div>
        </header>
        <main className="page__body">
          <p className="page__error" role="alert">{error}</p>
        </main>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="app-loading">
        <span className="app-loading__logo"><Logo size={19} /></span>
        <span className="app-loading__bar"><span /></span>
      </div>
    );
  }

  if (data.source === 'visuals') return <DisenoCompartido data={data} />;

  return (
    <div className="page">
      <header className="pubnav">
        <Link to="/" className="pubnav__logo"><Logo /></Link>
        <span className="shared__badge">Conversación compartida</span>
        <div className="pubnav__actions">
          <TemaBoton />
          <Link to="/chat" className="pill-btn pill-btn--primary pubnav__btn">Probar lixbon</Link>
        </div>
      </header>

      <main className="shared">
        <h1 className="shared__title">{data.title}</h1>
        <div className="shared__thread">
          {data.messages.map((m, i) => (
            m.role === 'user' ? (
              <div key={i} className="msg msg--user">{m.content}</div>
            ) : (
              <div key={i} className="msg msg--assistant"><Markdown>{m.content}</Markdown></div>
            )
          ))}
        </div>
        <div className="shared__cta">
          <p>Creado con lixbon — chat con IA sobre un clúster de GPUs propio.</p>
          <Link to="/auth?mode=register" className="pill-btn pill-btn--primary">Crea tu cuenta gratis</Link>
        </div>
      </main>
    </div>
  );
}

/** Un diseño de Visuals compartido: la última versión, página a página. */
function DisenoCompartido({ data }) {
  const versiones = useMemo(() => construirVersiones(data.messages), [data.messages]);
  const ultima = versiones[versiones.length - 1];
  const [pagina, setPagina] = useState(null);
  const paginas = useMemo(() => (ultima?.kind === 'file' ? ultima.files : []), [ultima]);
  const actual = paginas.find((f) => f.name === pagina) || paginas[0];
  const imagen = ultima?.kind === 'image' ? extraerImagen(data.messages[ultima.indice].content) : null;

  useEffect(() => {
    const onMessage = (e) => {
      const m = e.data || {};
      if (m.type === 'lixbon:navigate' && paginas.some((f) => f.name === m.page)) setPagina(m.page);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [paginas]);

  return (
    <div className="vis-page vis-compartido">
      <header className="vis-top">
        <Link to="/" className="vis-top__logo"><Logo /></Link>
        <span className="vis-titulo__nombre">{data.title}</span>
        {paginas.length > 1 && (
          <div className="vis-top__right vis-compartido__paginas">
            {paginas.map((f) => (
              <button key={f.name} className={`vis-tool ${actual?.name === f.name ? 'is-active' : ''}`} onClick={() => setPagina(f.name)}>{f.name.replace(/\.(html?|svg)$/, '')}</button>
            ))}
          </div>
        )}
        <div className="vis-top__right">
          <Link to="/visuals" className="pill-btn pill-btn--primary pubnav__btn">Crea el tuyo con Lixbon</Link>
        </div>
      </header>
      <div className="vis-stage vis-compartido__stage">
        {imagen ? <img className="vis-imagen" src={imagen.src} alt={imagen.alt} />
          : actual ? <div className="vis-frame"><iframe title={actual.name} sandbox="allow-scripts allow-forms allow-popups allow-modals" srcDoc={documentoPreview(actual)} /></div>
          : <div className="vis-stage__empty">Este diseño no tiene páginas.</div>}
      </div>
    </div>
  );
}
