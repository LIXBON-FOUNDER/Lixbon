// SeccionFacturacion.jsx — Ajustes → Facturación: tarjetas guardadas, cobros
// automáticos, saldo y últimos cobros. Todo se cobra desde aquí, sin salir.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { planBadge } from '../../lib/planColors';
import { ConfirmDialog } from '../ConfirmDialog';
import { IconBolt, IconPlus, IconTrash } from '../Icons';
import { DialogoTarjeta } from './DialogoTarjeta';
import { PagoCreditos } from './PagoCreditos';
import { Tarjeta, errMsg, fmtUSD } from './comunes';

const fmtFecha = (iso) => (iso ? new Date(iso).toLocaleDateString('es', {
  day: 'numeric', month: 'long', year: 'numeric',
}) : '—');

const fmtDia = (iso) => (iso ? new Date(iso).toLocaleDateString('es', {
  day: 'numeric', month: 'long',
}) : '—');

const ESTADO_FACTURA = {
  paid: 'Pagada', open: 'Pendiente', draft: 'Borrador',
  uncollectible: 'Incobrable', void: 'Anulada',
};

const ESTADO_COBRO = {
  succeeded: 'Aprobado', processing: 'Procesando',
  requires_action: 'Esperando al banco', requires_payment_method: 'Rechazado',
  canceled: 'Cancelado',
};

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
  const [billing, setBilling] = useState(null);
  const [credits, setCredits] = useState(null);
  const [packs, setPacks] = useState([]);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const [busy, setBusy] = useState(null);
  const [dialogo, setDialogo] = useState(null);

  const cargarBilling = useCallback(() => api.get('/api/billing/status')
    .then((res) => setBilling(res.data))
    .catch((e) => setError(errMsg(e, 'No se pudo cargar tu facturación.'))), []);

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
  }, 'No se pudo cambiar la tarjeta predeterminada.');

  const quitarTarjeta = (id) => conError(id, async () => {
    const res = await api.delete(`/api/billing/payment-methods/${id}`);
    setBilling((b) => ({ ...b, payment_methods: res.data.payment_methods }));
    cargarCreditos();
  }, 'No se pudo quitar la tarjeta.');

  const cambiarAuto = (activo) => conError('auto', async () => {
    if (activo && (!packAuto || !tarjetaAuto)) {
      setError('Añade una tarjeta antes de activar la recarga automática.');
      return;
    }
    const res = await api.put('/api/credits/autoreload', {
      enabled: activo,
      pack_id: activo ? packAuto.id : null,
      threshold_usd: 5,
      payment_method_id: activo ? tarjetaAuto.id : null,
    });
    setCredits((c) => ({ ...c, autoreload: res.data.autoreload }));
  }, 'No se pudo guardar la recarga automática.');

  const cancelar = () => conError('cancelar', async () => {
    await api.post('/api/billing/cancel');
    setDialogo(null);
    setAviso('Tu plan queda activo hasta el final del periodo pagado.');
    cargarBilling();
  }, 'No se pudo cancelar la suscripción.');

  const reactivar = () => conError('cancelar', async () => {
    await api.post('/api/billing/resume');
    setAviso('Tu plan vuelve a renovarse.');
    cargarBilling();
  }, 'No se pudo reactivar la suscripción.');

  const tarjetaGuardada = async () => {
    await cargarBilling();
    setAviso('Tarjeta guardada.');
  };

  // No cierra el diálogo: el cobro aprobado tiene su propia pantalla y la cierra
  // el usuario. Aquí solo se refresca lo que el cobro cambió.
  const recargaHecha = () => {
    setAviso('Recarga completada.');
    cargarCreditos();
    cargarBilling();
  };

  const precio = plan.price_monthly_cents === 0
    ? 'Gratis'
    : `${fmtUSD(plan.price_monthly_cents / 100)} / mes`;

  return (
    <>
      {aviso && <p className="admin-ok" role="status">{aviso}</p>}
      {error && <p className="page__error" role="alert">{error}</p>}

      <div className="set-card set-plan">
        <h2 className="set-title">Plan</h2>
        <div className="set-plan__info">
          <span
            className="plan-pill"
            style={{ background: planBadge(plan.id).bg, color: planBadge(plan.id).ink }}
          >
            Plan {plan.name}
          </span>
          <p className="card__muted">{plan.description}</p>
          <span className="set-plan__price">{precio}</span>
          {pagado && billing.current_period_end && (
            <span className="card__muted">
              {billing.cancel_at_period_end
                ? `Se cancela el ${fmtFecha(billing.current_period_end)}`
                : `Se renueva el ${fmtFecha(billing.current_period_end)}`}
            </span>
          )}
        </div>
        <Link to="/planes" className="pill-btn pill-btn--primary set-btn">
          <IconBolt size={15} /> {pagado ? 'Cambiar plan' : 'Mejorar plan'}
        </Link>
      </div>

      <div className="set-card">
        <div className="set-row set-row--head">
          <h2 className="set-title">Métodos de pago</h2>
          <button
            className="pill-btn pill-btn--outline set-btn"
            disabled={!billing?.enabled}
            onClick={() => setDialogo('tarjeta')}
          >
            <IconPlus size={15} /> Añadir tarjeta
          </button>
        </div>
        {!billing ? (
          <p className="card__muted">Cargando…</p>
        ) : metodos.length === 0 ? (
          <p className="card__muted">
            {billing.enabled
              ? 'Todavía no has guardado ninguna tarjeta. La que añadas se usará para tu '
                + 'plan y para las recargas de saldo.'
              : 'Los pagos en línea llegan pronto.'}
          </p>
        ) : metodos.map((m) => (
          <Tarjeta key={m.id} metodo={m}>
            {!m.is_default && (
              <button
                className="pill-btn pill-btn--outline set-btn"
                disabled={busy === m.id}
                onClick={() => hacerPredeterminada(m.id)}
              >
                Predeterminada
              </button>
            )}
            <button
              className="icon-btn"
              aria-label={`Quitar la tarjeta terminada en ${m.last4}`}
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
          <h2 className="set-title">Cobros automáticos</h2>
          <Fila
            titulo="Renovación del plan"
            sub={pagado && billing.current_period_end
              ? `${plan.name} · ${fmtUSD(plan.price_monthly_cents / 100)} `
                + `el ${fmtDia(billing.current_period_end)}`
              : 'Sin plan de pago activo'}
          >
            <Link to="/planes" className="pill-btn pill-btn--outline set-btn">Cambiar plan</Link>
          </Fila>

          <Fila
            titulo="Recarga automática de saldo"
            sub={auto?.enabled && packAuto
              ? `Carga ${fmtUSD(packAuto.price_usd)} cuando el saldo baje `
                + `de ${fmtUSD(auto.threshold_usd)}`
              : packAuto
                ? `Cargaría ${fmtUSD(packAuto.price_usd)} cuando el saldo baje de ${fmtUSD(5)}`
                : 'Sin packs de recarga configurados'}
          >
            <Interruptor
              label="Recarga automática de saldo"
              activo={Boolean(auto?.enabled)}
              disabled={busy === 'auto' || !billing?.enabled}
              onChange={cambiarAuto}
            />
          </Fila>
          {auto?.last_error && (
            <p className="card__muted">
              La última recarga automática falló ({auto.last_error}) y se desactivó.
            </p>
          )}

          {pagado && (
            <Fila
              titulo={billing.cancel_at_period_end ? 'Reactivar la suscripción' : 'Cancelar la suscripción'}
              sub={billing.cancel_at_period_end
                ? `Ahora mismo termina el ${fmtFecha(billing.current_period_end)}`
                : 'Sigue activa hasta el final del periodo pagado'}
            >
              {billing.cancel_at_period_end ? (
                <button
                  className="pill-btn pill-btn--outline set-btn"
                  disabled={busy === 'cancelar'}
                  onClick={reactivar}
                >
                  Reactivar
                </button>
              ) : (
                <button
                  className="pill-btn pill-btn--outline set-btn is-danger"
                  onClick={() => setDialogo('cancelar')}
                >
                  Cancelar
                </button>
              )}
            </Fila>
          )}
        </div>

        <div className="set-card pago-saldo">
          <span className="eyebrow">Saldo de créditos</span>
          <span className="pago-saldo__cifra">
            {credits ? fmtUSD(credits.balance_usd) : '…'}
          </span>
          <p className="card__muted">
            Se descuenta por tokens al usar tus API keys, según la tarifa de cada modelo.
          </p>
          <button
            className="pill-btn pill-btn--primary set-btn"
            disabled={!billing?.enabled || packs.length === 0}
            onClick={() => setDialogo('recargar')}
          >
            Recargar saldo
          </button>
          <Link to="/docs/precios-api" className="card__muted pago-saldo__enlace">
            Ver los precios por modelo
          </Link>
        </div>
      </div>

      <div className="set-card">
        <h2 className="set-title">Últimos cobros</h2>
        {!billing ? (
          <p className="card__muted">Cargando…</p>
        ) : billing.charges?.length ? billing.charges.map((c) => (
          <Fila
            key={c.id}
            titulo={c.concept}
            sub={`${ESTADO_COBRO[c.status] || c.status} el ${fmtDia(c.date)}`
              + (c.last4 ? ` · •••• ${c.last4}` : '')}
          >
            <span className="pago-monto">{fmtUSD(c.amount)}</span>
          </Fila>
        )) : (
          <p className="card__muted">
            Aún no hay cobros. Aparecerán aquí en cuanto actives un plan o recargues saldo.
          </p>
        )}
      </div>

      {billing?.invoices?.length > 0 && (
        <div className="set-card">
          <h2 className="set-title">Facturas</h2>
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
                  Ver
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
          title="¿Cancelar la suscripción?"
          confirmLabel="Cancelar suscripción"
          busyLabel="Cancelando…"
          busy={busy === 'cancelar'}
          onClose={() => setDialogo(null)}
          onConfirm={cancelar}
        >
          Tu plan {plan.name} sigue activo hasta el {fmtFecha(billing?.current_period_end)}.
          Después vuelves al plan Gratuito: no se borra nada, solo cambian los límites.
        </ConfirmDialog>
      )}
      {dialogo?.tipo === 'quitar' && (
        <ConfirmDialog
          title="¿Quitar esta tarjeta?"
          confirmLabel="Quitar tarjeta"
          busyLabel="Quitando…"
          busy={busy === dialogo.metodo.id}
          onClose={() => setDialogo(null)}
          onConfirm={async () => { await quitarTarjeta(dialogo.metodo.id); setDialogo(null); }}
        >
          Dejará de estar disponible para tus cobros. La tarjeta terminada
          en {dialogo.metodo.last4} se puede volver a añadir cuando quieras.
        </ConfirmDialog>
      )}
    </>
  );
}
