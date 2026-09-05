import { api } from '../../lib/api';
import { DialogoPago } from './DialogoPago';
import { fmtUSD } from './comunes';

export function PagoPlan({ plan, planActual, onHecho, onCerrar }) {
  const precio = (plan.price_monthly_cents || 0) / 100;
  const sube = planActual && plan.price_monthly_cents > (planActual.price_monthly_cents || 0);

  const resumen = (
    <div className="pago__resumen">
      <div className="pago__resumen-fila">
        <span className="pago__resumen-txt">
          <span className="pago__resumen-nombre">Plan {plan.name}</span>
          <span className="pago__sub">Mensual · se renueva solo</span>
        </span>
        <span className="pago__resumen-precio">{fmtUSD(precio)}</span>
      </div>
      <span className="pago__resumen-nota">
        {sube
          ? `Hoy se cobra solo la diferencia con tu plan ${planActual.name}; el mes que viene, `
            + `${fmtUSD(precio)} completos.`
          : 'Primer cobro hoy y luego cada mes. Puedes cancelar cuando quieras desde '
            + 'Ajustes → Facturación.'}
      </span>
    </div>
  );

  const cobrar = (pm) => api
    .post('/api/billing/subscribe', { plan_id: plan.id, payment_method_id: pm })
    .then((r) => r.data);

  return (
    <DialogoPago
      titulo={sube ? 'Mejorar plan' : 'Pagar'}
      concepto={`Tu plan ${plan.name} queda activo.`}
      resumen={resumen}
      etiquetaAccion={sube ? `Mejorar a ${plan.name}` : `Pagar ${fmtUSD(precio)}`}
      guardarFijo
      notaGuardar="Se guarda esta tarjeta: es con la que se renovará tu plan cada mes."
      cobrar={cobrar}
      onHecho={onHecho}
      onCerrar={onCerrar}
    />
  );
}
