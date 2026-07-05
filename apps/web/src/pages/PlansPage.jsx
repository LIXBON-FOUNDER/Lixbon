// PlansPage.jsx — página de precios (F5.6). El pago llega en F7:
// por ahora el CTA del plan superior es "Próximamente".
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { api } from '../lib/api';
import { PublicNav } from '../components/PublicNav';
import { planColor } from '../lib/planColors';

const fmtLimit = (v, suffix, noun) => (v === -1 ? `${noun} ilimitados` : `${v.toLocaleString()} ${suffix}`);

export default function PlansPage() {
  const { user } = useAuth();
  const [plans, setPlans] = useState([]);

  useEffect(() => {
    api.get('/api/plans').then((res) => setPlans(res.data.plans)).catch(() => setPlans([]));
  }, []);

  return (
    <div className="page page--cream">
      <PublicNav />

      <main className="page__body page__body--wide">
        <h1 className="page__title page__title--center">Planes</h1>
        <p className="plans__sub">Elige cómo quieres usar FOLAX. Los pagos en línea llegan pronto.</p>

        <div className="plans">
          {plans.map((p) => {
            const current = user && (user.plan_id === p.id || (!user.plan_id && p.id === 'free'));
            return (
              <article key={p.id} className={`plan-card ${p.id === 'pro' ? 'plan-card--featured' : ''}`}>
                <h2 className="plan-card__name" style={{ color: planColor(p.id) }}>{p.name}</h2>
                <p className="plan-card__price">
                  {p.price_monthly_cents === 0
                    ? 'Gratis'
                    : `$${(p.price_monthly_cents / 100).toFixed(2)} `}
                  {p.price_monthly_cents > 0 && <span>/ mes</span>}
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
                ) : p.price_monthly_cents === 0 ? (
                  <Link to="/auth?mode=register" className="pill-btn pill-btn--outline plan-card__cta">Empieza gratis</Link>
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
