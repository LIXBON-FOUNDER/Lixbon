import { IconAlert } from './Icons';
import { useT } from '../i18n/useT';

export function Razonamiento({ texto, activo }) {
  const t = useT('chat');
  return (
    <details className="msg-razon" open={activo}>
      <summary className={activo ? 'msg-razon__titulo is-activo' : 'msg-razon__titulo'}>
        {activo ? t('reasoningActive') : t('reasoning')}
      </summary>
      <div className="msg-razon__texto">{texto}</div>
    </details>
  );
}

export function MensajeError({ children }) {
  return (
    <span className="msg__error">
      <IconAlert size={15} />
      <span>{children}</span>
    </span>
  );
}
