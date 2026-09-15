import { useSalida } from '../hooks/useSalida';

/** Panel que aparece y desaparece con animación (entra por CSS del propio
 *  className; sale con .is-cerrando). */
export function Desplegable({ abierto, className = '', children, ...rest }) {
  const { montado, cerrando } = useSalida(abierto);
  if (!montado) return null;
  return <div className={`${className} ${cerrando ? 'is-cerrando' : ''}`} {...rest}>{children}</div>;
}
