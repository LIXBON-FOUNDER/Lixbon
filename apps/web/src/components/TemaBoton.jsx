import { useTema } from '../hooks/useTema';
import { IconMoon, IconSun } from './Icons';

export function TemaBoton({ className = 'icon-btn', size = 17 }) {
  const { tema, alternar } = useTema();
  return (
    <button className={className} onClick={alternar} title={tema === 'dark' ? 'Tema claro' : 'Tema oscuro'} aria-label="Cambiar tema">
      {tema === 'dark' ? <IconSun size={size} /> : <IconMoon size={size} />}
    </button>
  );
}
