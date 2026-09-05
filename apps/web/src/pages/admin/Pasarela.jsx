// Pasarela.jsx — estado de la pasarela, de solo lectura.
//
// El diseño traía un formulario con la clave secreta y un botón de rotar. No
// se implementa así a propósito: las claves viven en variables de entorno del
// despliegue, y editarlas desde el panel significaría guardarlas en la base de
// datos y servirlas por HTTP a quien tenga una sesión de admin. Se rotan en
// Stripe y se cambian en Railway.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { IconRefresh } from '../../components/Icons';
import {
  Aviso, Boton, Cabecera, Cargando, Chip, Tarjeta, errMsg, fmtNum,
} from './comunes';

function Dato({ label, children, mono }) {
  return (
    <div className="adm-lista__fila">
      <span className="adm-lista__label">{label}</span>
      <span className={`adm-lista__valor ${mono ? 'mono' : ''}`}>{children}</span>
    </div>
  );
}

export default function Pasarela() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const cargar = useCallback(() => {
    api.get('/api/admin/payments/gateway')
      .then((r) => { setData(r.data); setError(''); })
      .catch((e) => setError(errMsg(e, 'No se pudo leer la pasarela')));
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  return (
    <>
      <Cabecera
        titulo="Configuración de la pasarela"
        lead="Con qué adquirente se cobra y por dónde entran los avisos."
      >
        <Boton onClick={cargar}><IconRefresh size={15} /> Refrescar</Boton>
      </Cabecera>

      <div className="adm__body">
        <Aviso error>{error}</Aviso>

        {!data ? (error ? null : <Cargando />) : (
          <>
            <div className="adm-rejilla-2">
              <Tarjeta titulo="Adquirente">
                <div className="adm-lista">
                  <Dato label="Procesador">{data.processor}</Dato>
                  <Dato label="Comercio" mono>{data.account_id}</Dato>
                  <Dato label="País">{data.country || '—'}</Dato>
                  <Dato label="Moneda">{data.default_currency || 'USD'}</Dato>
                  <Dato label="Modo">
                    <Chip tono={data.livemode ? 'ok' : 'warn'} punto>
                      {data.livemode ? 'Producción' : 'Pruebas'}
                    </Chip>
                  </Dato>
                  <Dato label="Cobros">
                    <Chip tono={data.charges_enabled ? 'ok' : 'bad'} punto>
                      {data.charges_enabled ? 'Habilitados' : 'Bloqueados'}
                    </Chip>
                  </Dato>
                  <Dato label="Depósitos">
                    <Chip tono={data.payouts_enabled ? 'ok' : 'bad'} punto>
                      {data.payouts_enabled ? 'Habilitados' : 'Bloqueados'}
                    </Chip>
                  </Dato>
                </div>
              </Tarjeta>

              <Tarjeta titulo="Claves">
                <div className="adm-lista">
                  <Dato label="Pública" mono>{data.publishable_key || '—'}</Dato>
                  <Dato label="Secreta" mono>
                    {data.livemode ? 'sk_live_' : 'sk_test_'}••••••••••••
                  </Dato>
                  <Dato label="Firma del webhook">
                    <Chip tono={data.webhook_secret_set ? 'ok' : 'bad'} punto>
                      {data.webhook_secret_set ? 'Configurada' : 'Sin configurar'}
                    </Chip>
                  </Dato>
                </div>
                <p className="adm-card__nota">
                  Las claves viven en las variables de entorno del despliegue
                  (<span className="mono">STRIPE_SECRET_KEY</span>,{' '}
                  <span className="mono">STRIPE_PUBLISHABLE_KEY</span>,{' '}
                  <span className="mono">STRIPE_WEBHOOK_SECRET</span>) y no se editan
                  desde aquí: guardarlas en la base de datos para poder tocarlas en el
                  panel sería empeorar su custodia. Se rotan en Stripe y se cambian en
                  Railway.
                </p>
              </Tarjeta>
            </div>

            <Tarjeta titulo="Webhooks">
              <div className="adm-lista">
                <Dato label="Nuestro endpoint" mono>{data.webhook_url || '—'}</Dato>
                <Dato label="Eventos recientes">{fmtNum(data.events_seen)}</Dato>
                <Dato label="Sin entregar">
                  <Chip tono={data.events_pending ? 'warn' : 'ok'} punto>
                    {fmtNum(data.events_pending)}
                  </Chip>
                </Dato>
              </div>
              {data.endpoints.length > 0 && (
                <div className="adm-bloque">
                  <span className="adm-bloque__label">Endpoints dados de alta en Stripe</span>
                  <div className="adm-lista">
                    {data.endpoints.map((e) => (
                      <div key={e.url} className="adm-lista__fila">
                        <span className="adm-lista__valor mono">{e.url}</span>
                        <span className="adm-lista__label">
                          {e.events} eventos · {e.status === 'enabled' ? 'activo' : e.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {!data.webhook_secret_set && (
                <p className="adm-card__nota">
                  Sin la firma configurada el webhook rechaza todo lo que llega: las
                  suscripciones se sincronizarían solo cuando el usuario entra a
                  Facturación, y las recargas hechas con 3-D Secure podrían quedar
                  cobradas sin acreditar.
                </p>
              )}
            </Tarjeta>

            <Tarjeta titulo="Cómo se cobra">
              <p className="adm-card__nota">
                El cobro ocurre dentro de lixbon: el navegador tokeniza la tarjeta contra
                Stripe y aquí solo se guarda el identificador del método de pago. El
                número no pasa por nuestro servidor ni por la base de datos. El saldo de
                créditos siempre se guarda en USD.
              </p>
            </Tarjeta>
          </>
        )}
      </div>
    </>
  );
}
