import { api } from '../../lib/api';
import { useT } from '../../i18n/useT';
import { DialogoPago } from './DialogoPago';
import { fmtUSD } from './comunes';

export function PagoPlan({ plan, planActual, onHecho, onCerrar }) {
  const t = useT('account');
  const precio = (plan.price_monthly_cents || 0) / 100;
  const cambia = Boolean(planActual && planActual.id !== plan.id
    && (planActual.price_monthly_cents || 0) > 0);
  const sube = cambia && plan.price_monthly_cents > planActual.price_monthly_cents;
  const baja = cambia && !sube;

  // Una bajada no cobra: Stripe acredita el tiempo que queda del plan caro.
  // Anunciar "primer cobro hoy" ahí sería decir que se cobra algo que no se cobra.
  const nota = sube
    ? t('billing.planDialog.upgradeNote', { current: planActual.name, amount: fmtUSD(precio) })
    : baja
      ? t('billing.planDialog.downgradeNote', { current: planActual.name, amount: fmtUSD(precio) })
      : t('billing.planDialog.newSubNote');

  const resumen = (
    <div className="pago__resumen">
      <div className="pago__resumen-fila">
        <span className="pago__resumen-txt">
          <span className="pago__resumen-nombre">{t('billing.planDialog.planLine', { name: plan.name })}</span>
          <span className="pago__sub">{t('billing.planDialog.monthlySub')}</span>
        </span>
        <span className="pago__resumen-precio">{fmtUSD(precio)}</span>
      </div>
      <span className="pago__resumen-nota">{nota}</span>
    </div>
  );

  const cobrar = (pm) => api
    .post('/api/billing/subscribe', { plan_id: plan.id, payment_method_id: pm })
    .then((r) => r.data);

  return (
    <DialogoPago
      titulo={sube ? t('billing.planDialog.upgradeTitle') : baja ? t('billing.planDialog.changeTitle') : t('billing.planDialog.payTitle')}
      concepto={t('billing.planDialog.concept', { name: plan.name })}
      resumen={resumen}
      etiquetaAccion={sube ? t('billing.planDialog.upgradeAction', { name: plan.name })
        : baja ? t('billing.planDialog.changeAction', { name: plan.name }) : t('billing.planDialog.payAction', { amount: fmtUSD(precio) })}
      guardarFijo
      notaGuardar={t('billing.planDialog.saveNote')}
      cobrar={cobrar}
      onHecho={onHecho}
      onCerrar={onCerrar}
    />
  );
}
