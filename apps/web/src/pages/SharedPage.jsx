// SharedPage.jsx — vista pública de solo lectura de una conversación compartida
// (/s/:token). Sin sesión; muestra el hilo y un CTA para probar lixbon.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Logo } from '../components/Logo';
import { Markdown } from '../components/Markdown';

export default function SharedPage() {
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
            <Link to="/" className="pill-btn pill-btn--primary pubnav__btn">Probar lixbon</Link>
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

  return (
    <div className="page">
      <header className="pubnav">
        <Link to="/" className="pubnav__logo"><Logo /></Link>
        <span className="shared__badge">Conversación compartida</span>
        <div className="pubnav__actions">
          <Link to="/" className="pill-btn pill-btn--primary pubnav__btn">Probar lixbon</Link>
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
