// Las donaciones sustituyen a las suscripciones mientras estén activas. Es
// temporal: apagarlas devuelve los planes tal como están en Tarifas. El total
// se ajusta a mano con lo que entró en PayPal.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { IconRefresh } from '../../components/Icons';
import { Aviso, Boton, Cabecera, Cargando, Chip, Stat, Tarjeta, errMsg, fmtFecha } from './comunes';

const aDolares = (cents) => ((Number(cents) || 0) / 100).toFixed(2);
const fmtDolares = (cents) => ((Number(cents) || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export default function Donaciones() {
  const [data, setData] = useState(null);
  const [total, setTotal] = useState('');
  const [meta, setMeta] = useState('');
  const [error, setError] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState('');

  const recibir = (d) => { setData(d); setTotal(aDolares(d.total_cents)); setMeta(aDolares(d.goal_cents)); };

  const cargar = useCallback(() => {
    api.get('/api/admin/donations')
      .then((r) => { recibir(r.data.donations); setError(''); })
      .catch((e) => setError(errMsg(e, 'No se pudo leer la configuración de donaciones')));
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const guardar = async (campos, mensaje) => {
    setGuardando(true);
    setAviso('');
    try {
      const r = await api.patch('/api/admin/donations', campos);
      recibir(r.data.donations);
      setError('');
      setAviso(mensaje);
    } catch (e) {
      setError(errMsg(e, 'No se pudo guardar'));
    } finally {
      setGuardando(false);
    }
  };

  const centsDe = (texto) => Math.round(Number(String(texto).replace(',', '.')) * 100);
  const valido = (txt) => txt !== '' && Number.isFinite(centsDe(txt)) && centsDe(txt) >= 0;
  const totalValido = valido(total) && valido(meta);

  return (
    <>
      <Cabecera
        titulo="Donaciones"
        lead="Mientras estén activas sustituyen a las suscripciones. Es temporal: la configuración de planes y tarifas no se toca."
      >
        <Boton onClick={cargar}><IconRefresh size={15} /> Refrescar</Boton>
      </Cabecera>

      <div className="adm__body">
        <Aviso error>{error}</Aviso>

        {!data ? (error ? null : <Cargando />) : (
          <>
            <div className="adm-stats">
              <Stat label="Total donado" valor={fmtDolares(data.total_cents)} pie={data.goal_cents ? `de una meta de ${fmtDolares(data.goal_cents)}` : 'Ajuste manual con lo recibido en PayPal'} />
              <Stat label="Estado" valor={data.enabled ? 'Activas' : 'Apagadas'} pie={data.enabled ? 'La web muestra «Donar»' : 'La web muestra los planes'} />
              <Stat label="Último cambio" valor={fmtFecha(data.updated_at)} />
            </div>

            <div className="adm-rejilla-2">
              <Tarjeta titulo="Donaciones activas">
                <div className="adm-donaciones">
                  <p className="adm__lead">
                    {data.enabled
                      ? 'lixbon.com oculta los planes de pago: /plans y Ajustes › Facturación muestran las donaciones, que se cobran en PayPal.'
                      : 'lixbon.com muestra los planes y las suscripciones con la configuración de Tarifas.'}
                  </p>
                  <div className="adm-donaciones__fila">
                    <Chip tono={data.enabled ? 'ok' : 'warn'} punto>{data.enabled ? 'Sustituyen a las suscripciones' : 'Se muestran los planes de pago'}</Chip>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={data.enabled}
                      aria-label="Donaciones activas"
                      className={`adm-switch ${data.enabled ? 'is-on' : ''}`}
                      disabled={guardando}
                      onClick={() => guardar({ enabled: !data.enabled }, data.enabled ? 'Donaciones apagadas.' : 'Donaciones activadas.')}
                    >
                      <span />
                    </button>
                  </div>
                </div>
              </Tarjeta>

              <Tarjeta titulo="Cantidad y meta">
                <div className="adm-campos">
                  <label className="adm-campo adm-campo__ancho">
                    <span className="adm-campo__label">Total donado (USD)</span>
                    <input
                      className="adm-input adm-input--mono"
                      inputMode="decimal"
                      value={total}
                      onChange={(e) => setTotal(e.target.value)}
                    />
                  </label>
                  <label className="adm-campo adm-campo__ancho">
                    <span className="adm-campo__label">Meta (USD) · dibuja la barra de progreso de /plans; 0 la oculta</span>
                    <input
                      className="adm-input adm-input--mono"
                      inputMode="decimal"
                      value={meta}
                      onChange={(e) => setMeta(e.target.value)}
                    />
                  </label>
                </div>
                <div className="adm-donaciones__fila">
                  <Boton variante="primary" disabled={guardando || !totalValido}
                    onClick={() => guardar({ total_cents: centsDe(total), goal_cents: centsDe(meta) }, 'Cantidad y meta guardadas.')}>
                    Guardar
                  </Boton>
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
