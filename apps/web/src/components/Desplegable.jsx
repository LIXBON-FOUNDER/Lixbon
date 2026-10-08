import { useSalida } from '../hooks/useSalida';

export function Desplegable({ abierto, className = '', children, ...rest }) {
  const { montado, cerrando } = useSalida(abierto);
  if (!montado) return null;
  return <div className={`${className} ${cerrando ? 'is-cerrando' : ''}`} {...rest}>{children}</div>;
}
