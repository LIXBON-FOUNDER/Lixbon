import { BrandIcon } from '@lixbon/icons/brands';
// Marca aprobada en los lienzos: rombo con destello calado.

/** Animación del icono según lo que hace el agente: leer y buscar refractan
    la luz, editar y ejecutar tallan las caras, lo demás es pensar. */
export function toolMotion(tool) {
  if (/^(read_file|search|list_files|find_files|outline|web_search|fetch_url|read_output)$/.test(tool || '')) return 'refraccion';
  if (/^(write_file|edit_file|multi_edit|append_file|insert_at_line|delete_file|rename_file|mkdir|run_command)$/.test(tool || '')) return 'talla';
  return 'destello';
}

/** Conserva los estados de movimiento del agente con la nueva silueta. */
export function LogoMark({ size = 18, motion, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={`logomark logomark--redesign ${motion ? `logomark--${motion}` : ''} ${className}`}>
      <path fill="currentColor" fillRule="evenodd" d="M15 3Q16 2 17 3L29 15Q30 16 29 17L17 29Q16 30 15 29L3 17Q2 16 3 15ZM19.5 15.2Q20.25 18.75 23.8 19.5Q20.25 20.25 19.5 23.8Q18.75 20.25 15.2 19.5Q18.75 18.75 19.5 15.2Z" />
    </svg>
  );
}

export function Logo({ size = 30 }) {
  return (
    <span className="brand" style={{ fontSize: size }}>
      lixbon
    </span>
  );
}

// Lixbon Team: el diamante de Lixbon delante de otro en el acento, dos que
// trabajan juntos. El corte entre ambos toma el fondo de donde se pinte.
export function TeamMark({ size = 18, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={`teammark ${className}`}>
      <polygon points="21.5,2.5 31,12 21.5,21.5 12,12" fill="#C6D66E" />
      <polygon points="12.5,9 23,19.5 12.5,30 2,19.5" className="teammark__cut" />
      <g className="teammark__front">
        <polygon points="12.5,9 2,19.5 12.5,19.5" fill="#E6DFC2" />
        <polygon points="12.5,9 23,19.5 12.5,19.5" fill="#CFC5A2" />
        <polygon points="2,19.5 12.5,30 12.5,19.5" fill="#7D8A3E" />
        <polygon points="23,19.5 12.5,30 12.5,19.5" fill="#58622A" />
      </g>
    </svg>
  );
}

export function ClaudeMark({ size = 16, className = '' }) {
  return <BrandIcon name="claude" size={size} className={`claudemark ${className}`} />;
}
