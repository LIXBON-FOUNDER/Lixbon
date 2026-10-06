// SharedVisualPage.jsx — vista pública de solo lectura de un visual (/s/v/:token).
// Sin sesión: muestra los resultados (imágenes y vídeos) y los documentos.
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Link } from '../i18n/link';
import { useT } from '../i18n/useT';
import { useSeo } from '../lib/seo';
import { getShared, getText, piezasDe, sharedFileUrl } from '../lib/visualsApi';
import { Logo } from '../components/Logo';
import { Markdown } from '../components/Markdown';
import { TemaBoton } from '../components/TemaBoton';

const esVideo = (p) => /\.(mp4|webm)$/.test(p);

export default function SharedVisualPage() {
  const t = useT('visual');
  const tc = useT('common');
  useSeo({ title: t('sharedSeoTitle'), noindex: true });
  const { token } = useParams();
  const [manifest, setManifest] = useState(null);
  const [error, setError] = useState('');
  const [docs, setDocs] = useState({});

  useEffect(() => {
    getShared(token).then(setManifest).catch(() => setError(t('linkGone')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const { pieces, docs: docFiles } = useMemo(
    () => (manifest ? piezasDe(manifest) : { pieces: [], docs: [] }), [manifest]);

  useEffect(() => {
    docFiles.forEach((d) => {
      getText(sharedFileUrl(token, d.path)).then((txt) => setDocs((prev) => ({ ...prev, [d.path]: txt }))).catch(() => {});
    });
  }, [docFiles, token]);

  const header = (
    <header className="vp__nav">
      <Link to="/" className="vp__logo"><Logo /></Link>
      <span className="shared__badge">{t('sharedBadge')}</span>
      <span className="vp__navspacer" />
      <TemaBoton />
      <Link to="/chat" className="pill-btn pill-btn--primary">{tc('tryLixbon')}</Link>
    </header>
  );

  if (error) {
    return <div className="vp">{header}<main className="vp__body"><p className="page__error" role="alert">{error}</p></main></div>;
  }
  if (!manifest) return <div className="app-loading"><span className="app-loading__logo"><Logo size={19} /></span></div>;

  return (
    <div className="vp">
      {header}
      <main className="vp__body">
        <h1 className="vp__title">{manifest.title}</h1>
        <div className="vp__shared-grid">
          {pieces.filter((p) => p.output).map((p) => (
            <figure key={p.output.path} className="vp__fig">
              {esVideo(p.output.path)
                ? <video className="vp__media" src={sharedFileUrl(token, p.output.path)} controls loop muted />
                : <img className="vp__media" src={sharedFileUrl(token, p.output.path)} alt="" loading="lazy" />}
              <figcaption>{p.output.path.split('/').pop()}</figcaption>
            </figure>
          ))}
        </div>
        {docFiles.map((d) => (
          <div key={d.path} className="vp__doc"><Markdown>{docs[d.path] || ''}</Markdown></div>
        ))}
      </main>
    </div>
  );
}
