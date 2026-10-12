// small.jsx — piezas pequeñas de maquetación y avisos.
import { Fragment } from 'react';
import { NavLink } from './NavLink';
import { useAde } from '../state/AdeProvider';

export const SimBadge = ({ children = 'Simulado' }) => (
  <span className="ade-simbadge" title="Los datos y las acciones son simulados: no tocan el Core.">{children}</span>
);

export function Section({ title, count, aside, children, id, className = '' }) {
  return (
    <section className={`ade-section ${className}`} aria-labelledby={id ? `${id}-t` : undefined} aria-label={id ? undefined : title}>
      <header className="ade-section__head">
        <h2 id={id ? `${id}-t` : undefined} className="ade-section__title">
          {title}
          {count !== undefined && <span className="ade-count">{count}</span>}
        </h2>
        {aside && <div className="ade-section__aside">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

export function Stat({ label, value, tone }) {
  return (
    <span className={`ade-stat ${tone ? `ade-tone-${tone}` : ''}`}>
      <b>{value}</b> <span>{label}</span>
    </span>
  );
}

export function Breadcrumbs({ trail }) {
  return (
    <nav className="ade-crumbs" aria-label="Ruta de navegación">
      {trail.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="ade-crumbs__sep" aria-hidden="true">›</span>}
          {i === trail.length - 1 ? <span aria-current="page" className="ade-crumbs__here">{c.label}</span> : <NavLink route={c.route}>{c.label}</NavLink>}
        </Fragment>
      ))}
    </nav>
  );
}

/** Avisos de resultado de una acción (tomados del AdeProvider). Lo simulado se rotula. */
export function AdeNotices() {
  const { notices, dismissNotice } = useAde();
  if (!notices.length) return null;
  return (
    <div className="ade-notices" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`ade-notice ade-notice--${n.tone}`} role={n.tone === 'error' ? 'alert' : 'status'}>
          <span>{n.text}</span>
          <button type="button" className="ade-notice__x" aria-label="Cerrar aviso" onClick={() => dismissNotice(n.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
