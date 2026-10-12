// NavLink.jsx — enlace a una ruta del ADE. Es un <a href="#/…"> real (se puede copiar) que navega sin recargar.
import { useNav } from '../navigation/useAdeRouter';
import { formatRoute } from '../navigation/routes';

export function NavLink({ route, className = '', children, ...rest }) {
  const { navigate } = useNav();
  return (
    <a
      href={formatRoute(route)} className={`ade-link ${className}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button > 0) return;
        e.preventDefault();
        navigate(route);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

/** Botón que navega (misma semántica que NavLink, con aspecto de botón). */
export function NavButton({ route, variant = 'ghost', size = 'sm', children, ...rest }) {
  const { navigate } = useNav();
  const v = variant === 'primary' ? 'btn--primary' : variant === 'accent' ? 'btn--accent' : 'btn--ghost';
  return (
    <button type="button" className={`btn ${v} ${size === 'sm' ? 'btn--sm' : ''} ade-action`} onClick={() => navigate(route)} {...rest}>
      {children}
    </button>
  );
}
