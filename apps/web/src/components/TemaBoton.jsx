import { useTema } from '../hooks/useTema';
import { useT } from '../i18n/useT';
import { IconMoon, IconSun } from './Icons';

export function TemaBoton({ className = 'icon-btn', size = 17 }) {
  const { tema, alternar } = useTema();
  const t = useT('common');
  return (
    <button className={className} onClick={alternar} title={tema === 'dark' ? t('lightTheme') : t('darkTheme')} aria-label={t('changeTheme')}>
      {tema === 'dark' ? <IconSun size={size} /> : <IconMoon size={size} />}
    </button>
  );
}
