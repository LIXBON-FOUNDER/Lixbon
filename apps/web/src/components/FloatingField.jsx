// FloatingField.jsx — input outlined con label flotante sobre el borde
// (estilo Material outlined, según mockups de auth).
import { useId } from 'react';

export function FloatingField({ label, type = 'text', value, onChange, autoComplete, required = true, minLength }) {
  const id = useId();
  return (
    <div className="ffield">
      <input
        id={id}
        className="ffield__input"
        type={type}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        placeholder=" "
      />
      <label className="ffield__label" htmlFor={id}>
        {label}
      </label>
    </div>
  );
}
