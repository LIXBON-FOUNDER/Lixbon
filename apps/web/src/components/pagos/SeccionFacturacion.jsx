// SeccionFacturacion.jsx — Ajustes → Facturación: tarjetas guardadas, cobros
// automáticos, saldo y últimos cobros. Todo se cobra desde aquí, sin salir.
import { useCallback, useEffect, useState } from 'react';
import { Link } from '../../i18n/link';
import { useLocale } from '../../i18n/LocaleContext';
import { useT } from '../../i18n/useT';
import { api } from '../../lib/api';
import { planBadge } from '../../lib/planColors';
import { ConfirmDialog } from '../ConfirmDialog';
import { IconBolt, IconPlus, IconTrash } from '../Icons';
import { DialogoTarjeta } from './DialogoTarjeta';
import { PagoCreditos } from './PagoCreditos';
import { Tarjeta, errMsg, fmtDia, fmtUSD } from './comunes';

function Fila({ titulo, sub, children }) {
  return (
    <div className="set-row">
      <div className="set-row__label">
        <span>{titulo}</span>
        {sub && <span className="set-row__hint">{sub}</span>}
      </div>
      <div className="set-row__control">{children}</div>
    </div>
  );
}

function Interruptor({ activo, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={activo}
      aria-label={label}
      className={`set-toggle ${activo ? 'is-on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!activo)}
    >
      <span className="set-toggle__knob" />
    </button>
  );
}

export function SeccionFacturacion({ plan }) {
  const t = useT('account');
  const locale = useLocale();
  const fmtFecha = (iso) => (iso ? new Date(iso).toLocaleDateString(locale, {
    day: 'numeric', month: 'long', year: 'numeric',
  }) : '—');
  const ESTADO_FACTURA = t('billing.invoiceStatus');
  const ESTADO_COBRO = t('billing.chargeStatus');

  const [billing, setBilling] = useState(null);
  const [credits, setCredits] = useState(null);
  const [packs, setPacks] = useState([]);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const [busy, setBusy] = useState(null);
  const [dialogo, setDialogo] = useState(null);

  const cargarBilling = useCallback(() => api.get('/api/billing/status')
    .then((res) => setBilling(res.data))
    .catch((e) => setError(errMsg(e, t('billing.loadError')))), [t]);

  const cargarCreditos = useCallback(() => api.get('/api/credits')
    .then((res) => setCredits(res.data))
    .catch(() => {}), []);

  useEffect(() => {
    cargarBilling();
    cargarCreditos();
    api.get('/api/credits/packs').then((r) => setPacks(r.data.packs || [])).catch(() => {});
  }, [cargarBilling, cargarCreditos]);

  const metodos = billing?.payment_methods || [];
  const pagado = billing?.is_paid;
  const auto = credits?.autoreload;
  const packAuto = packs.find((p) => p.id === auto?.pack_id) || packs[1] || packs[0];
  const tarjetaAuto = metodos.find((m) => m.id === auto?.payment_method_id)
    || metodos.find((m) => m.is_default);

  const conError = async (clave, accion, fallo) => {
    setError('');
    setAviso('');
    setBusy(clave);
    try {
      await accion();
    } catch (e) {
      setError(errMsg(e, fallo));
    } finally {
      setBusy(null);
    }
  };

  const hacerPredeterminada = (id) => conError(id, async () => {
    const res = await api.post('/api/billing/payment-methods/default', { payment_method_id: id });
    setBilling((b) => ({ ...b, payment_methods: res.data.payment_methods }));
  }, t('billing.defaultCardError'));

  const quitarTarjeta = (id) => conError(id, async () => {
    const res = await api.delete(`/api/billing/payment-methods/${id}`);
    setBilling((b) => ({ ...b, payment_methods: res.data.payment_methods }));
    cargarCreditos();
  }, t('billing.removeCardError'));

  const cambiarAuto = (activo) => conError('auto', async () => {
    if (activo && (!packAuto || !tarjetaAuto)) {
      setError(t('billing.addCardBeforeAuto'));
      return;
    }
    const res = await api.put('/api/credits/autoreload', {
      enabled: activo,
      pack_id: activo ? packAuto.id : null,
      threshold_usd: 5,
      payment_method_id: activo ? tarjetaAuto.id : null,
    });
    setCredits((c) => ({ ...c, autoreload: res.data.autoreload }));
  }, t('billing.autoReloadSaveError'));

  const cancelar = () => conError('cancelar', async () => {
    await api.post('/api/billing/cancel');
    setDialogo(null);
    setAviso(t('billing.cancelNotice'));
    cargarBilling();
  }, t('billing.cancelError'));

  const reactivar = () => conError('cancelar', async () => {
    await api.post('/api/billing/resume');
    setAviso(t('billing.resumeNotice'));
    cargarBilling();
  }, t('billing.resumeError'));

  const tarjetaGuardada = async () => {
    await cargarBilling();
    setAviso(t('billing.cardSaved'));
  };

  // No cierra el diálogo: el cobro aprobado tiene su propia pantalla y la cierra
  // el usuario. Aquí solo se refresca lo que el cobro cambió.
  const recargaHecha = () => {
    setAviso(t('billing.topupDone'));
    cargarCreditos();
    cargarBilling();
  };

  const precio = plan.price_monthly_cents === 0
    ? t('billing.free')
    : `${fmtUSD(plan.price_monthly_cents / 100)} ${t('billing.perMonth')}`;

  return (
    <>
      {aviso && <p className="page__ok" role="status">{aviso}</p>}
      {error && <p className="page__error" role="alert">{error}</p>}

      <div className="set-card set-plan">
        <h2 className="set-title">{t('billing.planTitle')}</h2>
        <div className="set-plan__info">
          <span
            className="plan-pill"
            style={{ background: planBadge(plan.id).bg, color: planBadge(plan.id).ink }}
          >
            {t('usage.plan', { name: plan.name })}
          </span>
          <p className="card__muted">{plan.description}</p>
          <span className="set-plan__price">{precio}</span>
          {pagado && billing.current_period_end && (
            <span className="card__muted">
              {billing.cancel_at_period_end
                ? t('billing.cancelsOn', { date: fmtFecha(billing.current_period_end) })
                : t('billing.renewsOn', { date: fmtFecha(billing.current_period_end) })}
            </span>
          )}
          {billing?.status === 'past_due' && (
            <p className="set-aviso is-warn" role="alert">
              {t('billing.pastDueWarning')}
            </p>
          )}
        </div>
        <Link to="/plans" className="pill-btn pill-btn--primary set-btn">
          <IconBolt size={15} /> {pagado ? t('billing.changePlan') : t('billing.upgradePlan')}
        </Link>
      </div>

      <div className="set-card">
        <div className="set-row set-row--head">
          <h2 className="set-title">{t('billing.paymentMethodsTitle')}</h2>
          <button
            className="pill-btn pill-btn--outline set-btn"
            disabled={!billing?.enabled}
            onClick={() => setDialogo('tarjeta')}
          >
            <IconPlus size={15} /> {t('billing.addCard')}
          </button>
        </div>
        {!billing ? (
          <p className="card__muted">{t('billing.loading')}</p>
        ) : metodos.length === 0 ? (
          <p className="card__muted">
            {billing.enabled ? t('billing.noCardsSaved') : t('billing.paymentsComingSoon')}
          </p>
        ) : metodos.map((m) => (
          <Tarjeta key={m.id} metodo={m}>
            {!m.is_default && (
              <button
                className="pill-btn pill-btn--outline set-btn"
                disabled={busy === m.id}
                onClick={() => hacerPredeterminada(m.id)}
              >
                {t('billing.default')}
              </button>
            )}
            <button
              className="icon-btn"
              aria-label={t('billing.removeCardAria', { last4: m.last4 })}
              disabled={busy === m.id}
              onClick={() => setDialogo({ tipo: 'quitar', metodo: m })}
            >
              <IconTrash size={15} />
            </button>
          </Tarjeta>
        ))}
      </div>

      <div className="pago-cols">
        <div className="set-card">
          <h2 className="set-title">{t('billing.autoChargesTitle')}</h2>
          <Fila
            titulo={billing?.cancel_at_period_end ? t('billing.planEnd') : t('billing.planRenewal')}
            sub={pagado && billing?.current_period_end
              ? (billing.cancel_at_period_end
                ? t('billing.noEndsOn', { plan: plan.name, date: fmtDia(billing.current_period_end, locale) })
                : t('billing.renewsFor', { plan: plan.name, amount: fmtUSD(plan.price_monthly_cents / 100), date: fmtDia(billing.current_period_end, locale) }))
              : t('billing.noActivePlan')}
          >
            <Link to="/plans" className="pill-btn pill-btn--outline set-btn">{t('billing.changePlan')}</Link>
          </Fila>

          <Fila
            titulo={t('billing.autoReload')}
            sub={auto?.enabled && packAuto
              ? t('billing.autoReloadOn', { amount: fmtUSD(packAuto.price_usd), threshold: fmtUSD(auto.threshold_usd) })
              : packAuto
                ? t('billing.autoReloadWouldCharge', { amount: fmtUSD(packAuto.price_usd), threshold: fmtUSD(5) })
                : t('billing.autoReloadNotConfigured')}
          >
            <Interruptor
              label={t('billing.autoReload')}
              activo={Boolean(auto?.enabled)}
              disabled={busy === 'auto' || !billing?.enabled}
              onChange={cambiarAuto}
            />
          </Fila>
          {auto?.last_error && (
            <p className="card__muted">
              {t('billing.autoReloadFailed', { error: auto.last_error })}
            </p>
          )}

          {pagado && (
            <Fila
              titulo={billing.cancel_at_period_end ? t('billing.reactivateSubscription') : t('billing.cancelSubscription')}
              sub={billing.cancel_at_period_end
                ? t('billing.reactivatesNowEndsOn', { date: fmtFecha(billing.current_period_end) })
                : t('billing.activeUntilPaidPeriod')}
            >
              {billing.cancel_at_period_end ? (
                <button
                  className="pill-btn pill-btn--outline set-btn"
                  disabled={busy === 'cancelar'}
                  onClick={reactivar}
                >
                  {t('billing.reactivate')}
                </button>
              ) : (
                <button
                  className="pill-btn pill-btn--outline set-btn is-danger"
                  onClick={() => setDialogo('cancelar')}
                >
                  {t('billing.cancel')}
                </button>
              )}
            </Fila>
          )}
        </div>

        <div className="set-card pago-saldo">
          <span className="eyebrow">{t('billing.creditsBalance')}</span>
          <span className="pago-saldo__cifra">
            {credits ? fmtUSD(credits.balance_usd) : '…'}
          </span>
          <p className="card__muted">
            {t('billing.creditsBalanceHint')}
          </p>
          <button
            className="pill-btn pill-btn--primary set-btn"
            disabled={!billing?.enabled || packs.length === 0}
            onClick={() => setDialogo('recargar')}
          >
            {t('billing.addCredits')}
          </button>
          <Link to="/docs/api-pricing" className="card__muted pago-saldo__enlace">
            {t('billing.seeApiPricing')}
          </Link>
        </div>
      </div>

      <div className="set-card">
        <h2 className="set-title">{t('billing.recentChargesTitle')}</h2>
        {!billing ? (
          <p className="card__muted">{t('billing.loading')}</p>
        ) : billing.charges?.length ? billing.charges.map((c) => (
          <Fila
            key={c.id}
            titulo={c.concept}
            sub={`${ESTADO_COBRO[c.status] || c.status} el ${fmtDia(c.date, locale)}`
              + (c.last4 ? ` · •••• ${c.last4}` : '')}
          >
            <span className="pago-monto">{fmtUSD(c.amount)}</span>
          </Fila>
        )) : (
          <p className="card__muted">
            {t('billing.noCharges')}
          </p>
        )}
      </div>

      {billing?.invoices?.length > 0 && (
        <div className="set-card">
          <h2 className="set-title">{t('billing.invoicesTitle')}</h2>
          {billing.invoices.map((inv) => (
            <Fila
              key={inv.id}
              titulo={fmtFecha(inv.date)}
              sub={`${inv.currency} ${inv.amount.toFixed(2)} · `
                + `${ESTADO_FACTURA[inv.status] || inv.status}`}
            >
              {inv.hosted_url && (
                <a
                  className="pill-btn pill-btn--outline set-btn"
                  href={inv.hosted_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('billing.viewInvoice')}
                </a>
              )}
            </Fila>
          ))}
        </div>
      )}

      {dialogo === 'tarjeta' && (
        <DialogoTarjeta onGuardada={tarjetaGuardada} onCerrar={() => setDialogo(null)} />
      )}
      {dialogo === 'recargar' && (
        <PagoCreditos
          packs={packs}
          saldo={credits?.balance_usd || 0}
          onHecho={recargaHecha}
          onCerrar={() => setDialogo(null)}
        />
      )}
      {dialogo === 'cancelar' && (
        <ConfirmDialog
          title={t('billing.cancelSubscriptionConfirm.title')}
          confirmLabel={t('billing.cancelSubscriptionConfirm.confirmLabel')}
          busyLabel={t('billing.cancelSubscriptionConfirm.busyLabel')}
          busy={busy === 'cancelar'}
          onClose={() => setDialogo(null)}
          onConfirm={cancelar}
        >
          {t('billing.cancelSubscriptionConfirm.body', { plan: plan.name, date: fmtFecha(billing?.current_period_end) })}
        </ConfirmDialog>
      )}
      {dialogo?.tipo === 'quitar' && (
        <ConfirmDialog
          title={t('billing.removeCardConfirm.title')}
          confirmLabel={t('billing.removeCardConfirm.confirmLabel')}
          busyLabel={t('billing.removeCardConfirm.busyLabel')}
          busy={busy === dialogo.metodo.id}
          onClose={() => setDialogo(null)}
          onConfirm={async () => { await quitarTarjeta(dialogo.metodo.id); setDialogo(null); }}
        >
          {t('billing.removeCardConfirm.body', { last4: dialogo.metodo.last4 })}
        </ConfirmDialog>
      )}
    </>
  );
}
