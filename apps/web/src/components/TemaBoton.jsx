import { useTema } from '../hooks/useTema';
import { useT } from '../i18n/useT';
import { IconoDoble, usePulso } from './Icons';

// Interruptor «tema»: sol en claro, luna en oscuro; el icono gira al pulsar.
export function TemaBoton({ className = 'icon-btn', size = 17 }) {
  const { tema, alternar } = useTema();
  const t = useT('common');
  const [pulso, pulsar] = usePulso();
  return (
    <button
      className={`${className} ia ia-tema ${tema === 'dark' ? 'on' : ''} ${pulso}`}
      onClick={() => { pulsar(); alternar(); }}
      title={tema === 'dark' ? t('lightTheme') : t('darkTheme')}
      aria-label={t('changeTheme')}
    >
      <IconoDoble off="claro" on="oscuro" size={size} />
    </button>
  );
}
