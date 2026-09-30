// SettingsParts.jsx — piezas comunes de las páginas de Ajustes: la cabecera con
// icono de cada página y la cabecera de cada sección (etiqueta + explicación).

export function PageHead({ icon: Icon, title, sub, children }) {
  return (
    <div className="spage__head rise">
      {Icon && <span className="spage__icon"><Icon size={20} /></span>}
      <div className="spage__title">
        <span className="spage__h1">{title}</span>
        {sub && <span className="spage__sub">{sub}</span>}
      </div>
      {children}
    </div>
  );
}

export function SectionHead({ label, hint, children }) {
  return (
    <div className="ssec__head">
      <div className="ssec__headtext">
        <span className="ssec__label">{label}</span>
        {hint && <span className="ssec__hint">{hint}</span>}
      </div>
      {children && <div className="ssec__headactions">{children}</div>}
    </div>
  );
}
