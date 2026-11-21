import { Aviso } from './Pulido';
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

// El error en rojo tintado: qué pasó en una línea y, si se puede, «Reintentar»
// a la derecha (no un texto rojo suelto).
export function MensajeError({ children, onReintentar }) {
  const t = useT('chat');
  return (
    <Aviso tipo="mal" icono="sin-conexion" titulo={t('errorTitle')} texto={children} role="alert"
      acciones={onReintentar && (
        <button type="button" className="pill-btn pill-btn--outline" onClick={onReintentar}>{t('retry')}</button>
      )} />
  );
}
