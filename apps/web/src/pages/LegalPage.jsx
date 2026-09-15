// LegalPage.jsx — /legal/:doc (privacidad, terminos, reembolsos). Pública.
import { Link, Navigate, useParams } from 'react-router-dom';
import { PublicNav } from '../components/PublicNav';
import { PublicFooter } from '../components/PublicFooter';
import { useSeo } from '../lib/seo';
import { LEGAL, VIGENCIA } from './legalContent';

export default function LegalPage() {
  const { doc } = useParams();
  const actual = LEGAL.find((d) => d.id === doc);
  useSeo({
    title: actual?.title || 'Legal',
    description: actual?.description,
    path: `/legal/${actual?.id || ''}`,
    noindex: !actual,
  });
  if (!actual) return <Navigate to="/legal/privacidad" replace />;
  const Body = actual.Body;

  return (
    <div className="page">
      <PublicNav />
      <div className="legal">
        <nav className="legal__nav" aria-label="Documentos legales">
          {LEGAL.map((d) => (
            <Link key={d.id} to={`/legal/${d.id}`} className={`legal__link ${d.id === actual.id ? 'is-active' : ''}`}>
              {d.title}
            </Link>
          ))}
        </nav>
        <article className="docs__content legal__cuerpo">
          <span className="docs__eyebrow">Legal · vigente desde el {VIGENCIA}</span>
          <Body />
        </article>
      </div>
      <PublicFooter />
    </div>
  );
}
