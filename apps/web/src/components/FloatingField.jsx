// FloatingField.jsx — campo de formulario del acceso.
//
// La etiqueta ya no flota sobre un borde: va encima del campo, y el campo se
// distingue por su relleno (#1C1C1C en reposo, #242424 con el foco). Un campo
// con error cambia de relleno y lo dice con texto, nunca solo con color.
import { useId } from 'react';

export function FloatingField({
  label, type = 'text', value, onChange, autoComplete,
  required = true, minLength, placeholder, error,
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className={`ffield ${error ? 'is-error' : ''}`}>
      <label className="ffield__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="ffield__input"
        type={type}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />
      {error && (
        <span className="ffield__error" id={errorId}>
          {error}
        </span>
      )}
    </div>
  );
}
