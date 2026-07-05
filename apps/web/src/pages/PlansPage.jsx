// PlansPage.jsx — página de precios. Con Stripe habilitado (F7), los planes de
// pago llevan al checkout; si no, muestran "Próximamente".
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { api } from '../lib/api';
import { PublicNav } from '../components/PublicNav';
import { planColor } from '../lib/planColors';

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
      window.location.href = res.data.url; // redirige al checkout de Stripe
    } catch (err) {
      const d = err.response?.data?.detail;
      setError((d && d.message) || 'No se pudo iniciar el pago. Intenta de nuevo.');
      setBusy(null);
    }
  };

  return (
    <div className="page page--cream">
      <PublicNav />

      <main className="page__body page__body--wide">
        <h1 className="page__title page__title--center">Planes</h1>
        <p className="plans__sub">
          Elige cómo quieres usar FOLAX.{!billingEnabled && ' Los pagos en línea llegan pronto.'}
        </p>
        {error && <p className="page__error" role="alert">{error}</p>}

        <div className="plans">
          {plans.map((p) => {
            const current = user && (user.plan_id === p.id || (!user.plan_id && p.id === 'free'));
            const paid = p.price_monthly_cents > 0;
            return (
              <article key={p.id} className={`plan-card ${p.id === 'pro' ? 'plan-card--featured' : ''}`}>
                <h2 className="plan-card__name" style={{ color: planColor(p.id) }}>{p.name}</h2>
                <p className="plan-card__price">
                  {p.price_monthly_cents === 0
                    ? 'Gratis'
                    : `$${(p.price_monthly_cents / 100).toFixed(2)} `}
                  {paid && <span>/ mes</span>}
                </p>
                <p className="plan-card__desc">{p.description}</p>
                <ul className="plan-card__features">
                  <li>{fmtLimit(p.messages_per_day, 'mensajes / día', 'Mensajes')}</li>
                  <li>{fmtLimit(p.tokens_per_month, 'tokens / mes', 'Tokens')}</li>
                  <li>{p.max_api_keys === -1 ? 'API keys ilimitadas' : `${p.max_api_keys} API key(s)`}</li>
                  <li>{p.rate_limit_per_min} solicitudes / minuto</li>
                  <li>{p.allowed_models ? 'Modelos pequeños' : 'Todos los modelos'}</li>
                </ul>

                {current ? (
                  <span className="pill-btn pill-btn--outline plan-card__cta is-current">Tu plan actual</span>
                ) : !paid ? (
                  <Link to="/auth?mode=register" className="pill-btn pill-btn--outline plan-card__cta">Empieza gratis</Link>
                ) : billingEnabled ? (
                  <button
                    className="pill-btn pill-btn--primary plan-card__cta"
                    onClick={() => subscribe(p.id)}
                    disabled={busy === p.id}
                  >
                    {busy === p.id ? 'Redirigiendo…' : `Suscribirme a ${p.name}`}
                  </button>
                ) : (
                  <span className="pill-btn pill-btn--primary plan-card__cta is-soon" title="Pagos disponibles pronto">
                    Próximamente
                  </span>
                )}
              </article>
            );
          })}
        </div>
      </main>
    </div>
  );
}
