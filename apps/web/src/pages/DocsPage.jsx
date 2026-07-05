// DocsPage.jsx — Folax Docs (/docs y /docs/:section). Índice lateral por grupos +
// contenido central. Pública. Estilo tipo code.claude.com.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PublicNav } from '../components/PublicNav';
import { SECTIONS } from './docsContent';
import { IconChevron } from '../components/Icons';

export default function DocsPage() {
  const { section } = useParams();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const base = useMemo(() => window.location.origin, []);

  const current = SECTIONS.find((s) => s.id === section) || SECTIONS[0];

  // Agrupa las secciones por su `group`, conservando el orden de aparición
  const groups = useMemo(() => {
    const acc = [];
    for (const s of SECTIONS) {
      let g = acc.find((x) => x.name === s.group);
      if (!g) { g = { name: s.group, items: [] }; acc.push(g); }
      g.items.push(s);
    }
    return acc;
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
    setMenuOpen(false);
  }, [section]);

  const Body = current.Body;

  return (
    <div className="page">
      <PublicNav />
      <div className="docs">
        <button className="docs__menu-toggle" onClick={() => setMenuOpen((v) => !v)}>
          {current.title} <IconChevron size={14} open={menuOpen} />
        </button>

        <aside className={`docs__nav ${menuOpen ? 'is-open' : ''}`}>
          {groups.map((g) => (
            <div key={g.name} className="docs__nav-group">
              <span className="docs__nav-title">{g.name}</span>
              {g.items.map((s) => (
                <Link
                  key={s.id}
                  to={`/docs/${s.id}`}
                  className={`docs__nav-link ${s.id === current.id ? 'is-active' : ''}`}
                  onClick={(e) => {
                    // navegación SPA sin recargar
                    e.preventDefault();
                    navigate(`/docs/${s.id}`);
                  }}
                >
                  {s.title}
                </Link>
              ))}
            </div>
          ))}
        </aside>

        <article className="docs__content">
          <Body base={base} />
          <DocsFooter current={current} />
        </article>
      </div>
    </div>
  );
}

function DocsFooter({ current }) {
  const idx = SECTIONS.findIndex((s) => s.id === current.id);
  const prev = SECTIONS[idx - 1];
  const next = SECTIONS[idx + 1];
  return (
    <nav className="docs__pager">
      {prev ? (
        <Link to={`/docs/${prev.id}`} className="docs__pager-link">
          <span>Anterior</span><strong>{prev.title}</strong>
        </Link>
      ) : <span />}
      {next && (
        <Link to={`/docs/${next.id}`} className="docs__pager-link docs__pager-link--next">
          <span>Siguiente</span><strong>{next.title}</strong>
        </Link>
      )}
    </nav>
  );
}
