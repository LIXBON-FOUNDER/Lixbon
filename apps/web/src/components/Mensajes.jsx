// Mensajes.jsx — piezas compartidas del hilo: razonamiento plegable y error.
import { IconAlert } from './Icons';
import { useT } from '../i18n/useT';

// Razonamiento previo de los modelos thinking: plegado, y abierto mientras
// el modelo aún no ha escrito nada para que se vea que está trabajando.
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
