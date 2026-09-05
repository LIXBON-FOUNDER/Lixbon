import { IconAlert, IconCheck } from '../../components/Icons';

export const errMsg = (err, fallback) => {
  const d = err.response?.data?.detail;
  return (d && d.message) || (typeof d === 'string' ? d : fallback);
};

export const fmtFecha = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

export const fmtDia = (iso) => (
  iso ? new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'short' }) : '—'
);

export const fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString('es') : '—');

export const fmtUSD = (n, dec = 2) => `$${(Number(n) || 0).toFixed(dec)}`;

export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2).replace('.', ',')} B`;
  if (v >= 1e6) return `${Math.round(v / 1e6)} M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)} k`;
  return String(v);
}

export function fmtHace(segundos) {
  if (segundos == null) return 'nunca';
  if (segundos < 60) return `hace ${Math.round(segundos)} s`;
  if (segundos < 3600) return `hace ${Math.round(segundos / 60)} min`;
  if (segundos < 86400) return `hace ${Math.round(segundos / 3600)} h`;
  return `hace ${Math.round(segundos / 86400)} días`;
}

export const inicialDe = (texto) => (texto || '?').trim().charAt(0).toUpperCase();

const NOMBRE_PLAN = { free: 'Gratuito', pro: 'Pro', advance: 'Advance' };

export const nombrePlan = (id) => NOMBRE_PLAN[id] || id || '—';

const TINTAS = ['#8CA038', '#5C93DB', '#C4553D', '#8A8A88'];
export const tintaDe = (i) => TINTAS[i % TINTAS.length];

export function Cabecera({ titulo, lead, children }) {
  return (
    <header className="adm__head">
      <div className="adm__titles">
        <h1 className="adm__title">{titulo}</h1>
        {lead && <p className="adm__lead">{lead}</p>}
      </div>
      {children && <div className="adm__actions">{children}</div>}
    </header>
  );
}

export function Boton({ variante = 'plano', sm, peligro, children, ...rest }) {
  const clases = ['adm-btn'];
  if (variante === 'primary') clases.push('adm-btn--primary');
  if (sm) clases.push('adm-btn--sm');
  if (peligro) clases.push('is-danger');
  return <button type="button" className={clases.join(' ')} {...rest}>{children}</button>;
}

export function Tarjeta({ titulo, extra, tabla, className = '', children }) {
  const clases = ['adm-card'];
  if (tabla) clases.push('adm-card--tabla');
  if (className) clases.push(className);
  return (
    <section className={clases.join(' ')}>
      {(titulo || extra) && (
        <div className="adm-card__head">
          {titulo ? <h2 className="adm-card__title">{titulo}</h2> : <span />}
          {extra}
        </div>
      )}
      {children}
    </section>
  );
}

export function Aviso({ error, children }) {
  if (!children) return null;
  return (
    <p className={error ? 'adm-error' : 'adm-ok'} role={error ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

export const Cargando = () => <p className="adm-vacio">Cargando…</p>;

export const Vacio = ({ children }) => <p className="adm-vacio">{children}</p>;

export function Nota({ tono = 'bad', titulo, sub }) {
  return (
    <div className={tono === 'ok' ? 'adm-aviso adm-aviso--ok' : 'adm-aviso'}>
      {tono === 'ok' ? <IconCheck size={17} /> : <IconAlert size={17} />}
      <div className="adm-aviso__txt">
        <span className="adm-aviso__titulo">{titulo}</span>
        {sub && <span className="adm-aviso__sub">{sub}</span>}
      </div>
    </div>
  );
}

// El punto repite el estado en forma: el color por sí solo no lo comunica.
export function Chip({ tono, punto, mono, children }) {
  const clases = ['adm-chip'];
  if (tono) clases.push(`adm-chip--${tono}`);
  if (mono) clases.push('adm-chip--mono');
  return (
    <span className={clases.join(' ')}>
      {punto && <span className="adm-chip__punto" />}
      {children}
    </span>
  );
}

export function Stat({ label, valor, pie }) {
  return (
    <div className="adm-stat">
      <span className="adm-stat__label">{label}</span>
      <span className="adm-stat__valor">{valor}</span>
      {pie && <span className="adm-stat__pie">{pie}</span>}
    </div>
  );
}

export function Medida({ label, valor, pct, gruesa }) {
  const ancho = Math.max(0, Math.min(100, Number(pct) || 0));
  return (
    <div className={gruesa ? 'adm-medida adm-medida--gruesa' : 'adm-medida'}>
      <div className="adm-medida__top">
        <span className="adm-medida__label">{label}</span>
        <span className="adm-medida__valor">{valor}</span>
      </div>
      <div className="adm-medida__pista">
        <span className="adm-medida__relleno" style={{ width: `${ancho}%` }} />
      </div>
    </div>
  );
}

// Rejilla en vez de <table>: la fila entera es una superficie con su radio, y
// un <tr> no puede serlo.
export function Tabla({ cols, cabeceras, ancho, children }) {
  const grid = { gridTemplateColumns: cols };
  const tabla = (
    <div className="adm-tabla" style={ancho ? { minWidth: ancho } : undefined}>
      <div className="adm-tabla__cabecera" style={grid}>
        {cabeceras.map((c) => (
          <span
            key={c.label || c.key}
            className="adm-tabla__th"
            style={c.num ? { textAlign: 'right' } : undefined}
          >
            {c.label}
          </span>
        ))}
      </div>
      <div className="adm-tabla__filas">{children}</div>
    </div>
  );
  return <div className="adm-scroll-x">{tabla}</div>;
}

export function Fila({ cols, children }) {
  return (
    <div className="adm-tabla__fila" style={{ gridTemplateColumns: cols }}>
      {children}
    </div>
  );
}

export function Celda({ num, acciones, children }) {
  const clases = ['adm-tabla__td'];
  if (num) clases.push('adm-tabla__td--num');
  if (acciones) clases.push('adm-tabla__td--acciones');
  return <div className={clases.join(' ')}>{children}</div>;
}

export function Quien({ nombre, correo }) {
  return (
    <div className="adm-quien">
      <span className="adm-quien__ini">{inicialDe(nombre || correo)}</span>
      <div className="adm-quien__txt">
        <span className="adm-quien__nombre">{nombre || correo}</span>
        {nombre && correo && <span className="adm-quien__mail">{correo}</span>}
      </div>
    </div>
  );
}
