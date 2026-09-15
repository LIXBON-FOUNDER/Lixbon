// GuiasPage.jsx — /guias (índice) y /guias/:slug (artículo). Pública.
import { useMemo } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { PublicNav } from '../components/PublicNav';
import { PublicFooter } from '../components/PublicFooter';
import { SITE_URL, useSeo } from '../lib/seo';
import { GUIAS } from './guiasContent';

const fmtFecha = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' });

export default function GuiasPage() {
  const { slug } = useParams();
  const guia = slug ? GUIAS.find((g) => g.id === slug) : null;

  const jsonLd = useMemo(() => (guia ? {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: guia.title,
    description: guia.description,
    datePublished: guia.fecha,
    dateModified: guia.fecha,
    inLanguage: 'es',
    author: { '@type': 'Organization', name: 'lixbon', url: SITE_URL },
    publisher: { '@type': 'Organization', name: 'lixbon', url: SITE_URL, logo: { '@type': 'ImageObject', url: `${SITE_URL}/icon-512.png` } },
    mainEntityOfPage: `${SITE_URL}/guias/${guia.id}`,
  } : {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Guías de lixbon',
    url: `${SITE_URL}/guias`,
  }), [guia]);

  useSeo({
    title: guia ? guia.title : 'Guías',
    description: guia ? guia.description : 'Guías prácticas para usar lixbon: la API compatible con OpenAI, Qwen 3.5 desde Python, el agente de código en la terminal y la privacidad de tus datos.',
    path: guia ? `/guias/${guia.id}` : '/guias',
    noindex: Boolean(slug && !guia),
    jsonLd,
  });

  if (slug && !guia) return <Navigate to="/guias" replace />;

  return (
    <div className="page">
      <PublicNav />
      {guia ? <Articulo guia={guia} /> : <Indice />}
      <PublicFooter />
    </div>
  );
}

function Indice() {
  return (
    <main className="guias">
      <header className="guias__cabecera">
        <h1 className="page__title">Guías</h1>
        <p className="guias__lead">Artículos cortos y prácticos para sacarle partido a lixbon. Cada uno resuelve una cosa.</p>
      </header>
      <div className="guias__lista">
        {GUIAS.map((g) => (
          <Link key={g.id} to={`/guias/${g.id}`} className="guias__item">
            <span className="guias__meta">{fmtFecha(g.fecha)} · {g.minutos} min</span>
            <h2>{g.title}</h2>
            <p>{g.description}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}

function Articulo({ guia }) {
  const Body = guia.Body;
  const otras = GUIAS.filter((g) => g.id !== guia.id).slice(0, 3);
  return (
    <main className="guias guias--articulo">
      <article className="docs__content guias__cuerpo">
        <Link to="/guias" className="docs__eyebrow">Guías</Link>
        <h1>{guia.title}</h1>
        <p className="guias__meta">{fmtFecha(guia.fecha)} · {guia.minutos} min de lectura</p>
        <Body />
      </article>
      <aside className="guias__mas">
        <span className="docs__nav-title">Otras guías</span>
        {otras.map((g) => <Link key={g.id} to={`/guias/${g.id}`}>{g.title}</Link>)}
      </aside>
    </main>
  );
}
