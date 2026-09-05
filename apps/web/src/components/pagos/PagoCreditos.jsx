import { useState } from 'react';
import { api } from '../../lib/api';
import { IconCheck } from '../Icons';
import { DialogoPago } from './DialogoPago';
import { fmtUSD } from './comunes';

const UMBRAL_USD = 5;

export function PagoCreditos({ packs, saldo, onHecho, onCerrar }) {
  const [pack, setPack] = useState(packs[0]?.id || null);
  const [auto, setAuto] = useState(false);
  const elegido = packs.find((p) => p.id === pack) || packs[0];

  const resumen = (
    <>
      <div className="pago__campo">
        <span className="pago__label">Cuánto quieres cargar</span>
        <div className="pago__packs">
          {packs.map((p) => (
            <button
              type="button"
              key={p.id}
              className={`pago-pack ${p.id === pack ? 'is-activo' : ''}`}
              onClick={() => setPack(p.id)}
            >
              <span className="pago-pack__nombre">{p.name}</span>
              <span className="pago-pack__precio">{fmtUSD(p.price_usd)}</span>
              <span className="pago-pack__nota">{fmtUSD(p.credit_usd)} de saldo</span>
            </button>
          ))}
        </div>
      </div>

      <div className="pago__resumen">
        <div className="pago__resumen-fila">
          <span className="pago__resumen-txt">
            <span className="pago__resumen-nombre">Saldo después de la recarga</span>
            <span className="pago__sub">Ahora tienes {fmtUSD(saldo)}</span>
          </span>
          <span className="pago__resumen-precio">
            {fmtUSD((saldo || 0) + (elegido?.credit_usd || 0))}
          </span>
        </div>
      </div>
    </>
  );

  const extra = (
    <label className="pago__guardar">
      <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
      <span className="pago__tick" aria-hidden="true"><IconCheck size={12} /></span>
      <span>
        Recargar {fmtUSD(elegido?.price_usd)} automáticamente cuando el saldo baje
        de {fmtUSD(UMBRAL_USD)}
      </span>
    </label>
  );

  const cobrar = (pm, guardar) => api
    .post('/api/credits/topup', {
      pack_id: elegido.id,
      payment_method_id: pm,
      guardar: guardar || auto,
    })
    .then((r) => r.data);

  // La recarga automática se guarda con el cobro ya aprobado: encenderla sobre
  // una tarjeta que el banco acaba de rechazar dejaría el ajuste roto.
  const hecho = async (res) => {
    if (auto && res.payment_method) {
      try {
        await api.put('/api/credits/autoreload', {
          enabled: true,
          pack_id: elegido.id,
          threshold_usd: UMBRAL_USD,
          payment_method_id: res.payment_method,
        });
      } catch {
        /* el saldo ya entró; el ajuste se puede reintentar desde Facturación */
      }
    }
    onHecho?.(res);
  };

  return (
    <DialogoPago
      titulo="Recargar saldo"
      concepto={`Se sumaron ${fmtUSD(elegido?.credit_usd)} a tu saldo de créditos.`}
      resumen={resumen}
      extra={extra}
      etiquetaAccion={`Recargar ${fmtUSD(elegido?.price_usd)}`}
      guardarFijo={auto}
      notaGuardar="Se guarda esta tarjeta: es con la que se hará la recarga automática."
      cobrar={cobrar}
      onHecho={hecho}
      onCerrar={onCerrar}
    />
  );
}
