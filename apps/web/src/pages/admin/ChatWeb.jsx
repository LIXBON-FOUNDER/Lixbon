// Abre o pone en pausa el chat de lixbon.com. En pausa, /chat enseña la lámina
// «Puerto tranquilo» con los atajos a Visuals, Remoto y Apps, y las conversaciones
// abiertas se pueden leer pero no continuar.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { olvidarChatWeb } from '../../lib/chatWeb';
import { IconRefresh } from '../../components/Icons';
import { Aviso, Boton, Cabecera, Cargando, Chip, Stat, Tarjeta, errMsg, fmtFecha } from './comunes';

export default function ChatWeb() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState('');

  const cargar = useCallback(() => {
    api.get('/api/admin/web-chat')
      .then((r) => { setData(r.data.web_chat); setError(''); })
      .catch((e) => setError(errMsg(e, 'No se pudo leer el estado del chat web')));
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const alternar = async () => {
    setGuardando(true);
    setAviso('');
    try {
      const r = await api.patch('/api/admin/web-chat', { enabled: !data.enabled });
      setData(r.data.web_chat);
      olvidarChatWeb();
      setError('');
      setAviso(r.data.web_chat.enabled ? 'Chat web abierto.' : 'Chat web en pausa.');
    } catch (e) {
      setError(errMsg(e, 'No se pudo guardar'));
    } finally {
      setGuardando(false);
    }
  };

  return (
    <>
      <Cabecera
        titulo="Chat web"
        lead="Abre el chat de lixbon.com o déjalo en pausa mientras no haya equipos para ejecutar los modelos."
      >
        <Boton onClick={cargar}><IconRefresh size={15} /> Refrescar</Boton>
      </Cabecera>

      <div className="adm__body">
        <Aviso error>{error}</Aviso>

        {!data ? (error ? null : <Cargando />) : (
          <>
            <div className="adm-stats">
              <Stat label="Estado" valor={data.enabled ? 'Abierto' : 'En pausa'} pie={data.enabled ? 'La web muestra la caja de mensaje' : 'La web muestra «Puerto tranquilo»'} />
              <Stat label="Último cambio" valor={fmtFecha(data.updated_at)} />
            </div>

            <div className="adm-rejilla-2">
              <Tarjeta titulo="Chat web activo">
                <div className="adm-donaciones">
                  <p className="adm__lead">
                    {data.enabled
                      ? 'lixbon.com/chat abre con el colibrí y la caja de mensaje: cualquiera con sesión puede escribir a los modelos.'
                      : 'lixbon.com/chat muestra la lámina «Puerto tranquilo» y los atajos a Visuals, Remoto y Apps. Las conversaciones se leen, pero no se continúan.'}
                  </p>
                  <div className="adm-donaciones__fila">
                    <Chip tono={data.enabled ? 'ok' : 'warn'} punto>{data.enabled ? 'Abierto' : 'En pausa'}</Chip>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={data.enabled}
                      aria-label="Chat web activo"
                      className={`adm-switch ${data.enabled ? 'is-on' : ''}`}
                      disabled={guardando}
                      onClick={alternar}
                    >
                      <span />
                    </button>
                  </div>
                </div>
              </Tarjeta>
            </div>
            {aviso && <p className="adm__lead" role="status">{aviso}</p>}
          </>
        )}
      </div>
    </>
  );
}
