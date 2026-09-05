// PlansPage.jsx — página de precios. Con Stripe habilitado (F7), los planes de
// pago llevan al checkout; si no, muestran "Próximamente".
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { api } from '../lib/api';
import { PublicNav } from '../components/PublicNav';
import { IconCheck, IconCard } from '../components/Icons';

const fmtLimit = (v, suffix, noun) => (v === -1 ? `${noun} ilimitados` : `${v.toLocaleString()} ${suffix}`);

export default function PlansPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [plans, setPlans] = useState([]);
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [busy, setBusy] = useState(null); // plan_id en proceso de checkout
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/plans').then((res) => setPlans(res.data.plans)).catch(() => setPlans([]));
    api.get('/api/billing/config').then((res) => setBillingEnabled(res.data.enabled)).catch(() => {});
  }, []);

  const subscribe = async (planId) => {
    if (!user) { navigate('/auth?mode=register'); return; }
    setError('');
    setBusy(planId);
    try {
      const res = await api.post('/api/billing/checkout', { plan_id: planId });
      if (res.data.upgraded) {
        // Upgrade in-place (ya tenía suscripción): sin checkout, cobro prorrateado hecho
        navigate('/account/facturacion?upgrade=success');
        return;
      }
      window.location.href = res.data.url; // redirige al checkout de Stripe
    } catch (err) {
      const d = err.response?.data?.detail;
      setError((d && d.message) || 'No se pudo iniciar el pago. Intenta de nuevo.');
      setBusy(null);
    }
  };

  // Precio del plan actual del usuario (para distinguir upgrade de alta nueva)
  const currentPrice = user
    ? (plans.find((p) => p.id === user.plan_id)?.price_monthly_cents ?? 0)
    : 0;

  return (
    <div className="page">
      <PublicNav />

      <main className="page__body page__body--wide">
        <h1 className="page__title page__title--center">Planes</h1>
        <p className="plans__sub">
          Elige cómo quieres usar lixbon.{!billingEnabled && ' Los pagos en línea llegan pronto.'}
        </p>
        {error && <p className="page__error" role="alert">{error}</p>}

        <div className="plans">
          {plans.map((p) => {
            const current = user && (user.plan_id === p.id || (!user.plan_id && p.id === 'free'));
            const paid = p.price_monthly_cents > 0;
            return (
              <article key={p.id} className={`plan-card ${p.id === 'pro' ? 'plan-card--featured' : ''}`}>
                <div className="plan-card__head">
                  <h2 className="plan-card__name">{p.name}</h2>
                  {p.id === 'pro' && <span className="plan-card__tag">Más elegido</span>}
                </div>
                <p className="plan-card__price">
                  {p.price_monthly_cents === 0
                    ? '$0'
                    : `$${(p.price_monthly_cents / 100).toFixed(2)} `}
                  {paid && <span>/ mes</span>}
                </p>
                <p className="plan-card__desc">{p.description}</p>

                {/* La acción va antes de la lista: quien ya sabe qué plan
                    quiere no tiene que leerse seis viñetas para llegar a ella. */}
                {current ? (
                  <span className="pill-btn pill-btn--outline plan-card__cta is-current">Tu plan actual</span>
                ) : !paid ? (
                  <Link to="/auth?mode=register" className="pill-btn pill-btn--outline plan-card__cta">Empieza gratis</Link>
                ) : billingEnabled ? (
                  <button
                    className="pill-btn pill-btn--primary plan-card__cta"
                    onClick={() => subscribe(p.id)}
                    disabled={busy === p.id}
                    title={currentPrice > 0 && p.price_monthly_cents > currentPrice
                      ? 'Se cobra solo la diferencia prorrateada del mes'
                      : undefined}
                  >
                    {busy === p.id
                      ? 'Procesando…'
                      : currentPrice > 0 && p.price_monthly_cents > currentPrice
                        ? `Mejorar a ${p.name}`
                        : `Suscribirme a ${p.name}`}
                  </button>
                ) : (
                  <span className="pill-btn pill-btn--primary plan-card__cta is-soon" title="Pagos disponibles pronto">
                    Próximamente
                  </span>
                )}

                <ul className="plan-card__features">
                  {[
                    fmtLimit(p.messages_per_day, 'mensajes al día', 'Mensajes'),
                    fmtLimit(p.tokens_per_month, 'tokens al mes', 'Tokens'),
                    p.max_api_keys === -1 ? 'API keys ilimitadas' : `${p.max_api_keys} API key${p.max_api_keys === 1 ? '' : 's'}`,
                    `${p.rate_limit_per_min} peticiones por minuto`,
                    p.allowed_models ? 'Modelos pequeños del clúster' : 'Todos los modelos activos',
                  ].map((texto) => (
                    <li key={texto}><IconCheck size={15} /> <span>{texto}</span></li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>

        <div className="plans__nota">
          <IconCard size={17} />
          <p>
            Las peticiones hechas con una <strong>API key</strong> se cobran aparte, por
            tokens y según la tarifa de cada modelo, contra tu saldo de créditos. Puedes
            recargar saldo sin cambiar de plan desde{' '}
            <Link to="/account/facturacion">Cuenta → Facturación</Link>.
          </p>
        </div>
      </main>
    </div>
  );
}
