// PlansPage.jsx — página de precios. Con los pagos activos, el plan se cobra en
// un modal sin salir de lixbon; si no, las tarjetas muestran "Próximamente".
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { api } from '../lib/api';
import { PublicNav } from '../components/PublicNav';
import { PagoPlan } from '../components/pagos/PagoPlan';
import { IconCheck, IconCard } from '../components/Icons';

const fmtLimit = (v, suffix, noun) => (v === -1 ? `${noun} ilimitados` : `${v.toLocaleString()} ${suffix}`);

export default function PlansPage() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [plans, setPlans] = useState([]);
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [pagando, setPagando] = useState(null); // plan cuyo modal está abierto
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/plans').then((res) => setPlans(res.data.plans)).catch(() => setPlans([]));
    api.get('/api/billing/config').then((res) => setBillingEnabled(res.data.enabled)).catch(() => {});
  }, []);

  const subscribe = (plan) => {
    if (!user) { navigate('/auth?mode=register'); return; }
    setError('');
    setPagando(plan);
  };

  // El plan lo activa el webhook o la respuesta del cobro; releer /me evita que
  // la pill del sidebar siga enseñando el plan viejo.
  const cobrado = () => {
    api.get('/api/auth/me').then((me) => setUser(me.data.user)).catch(() => {});
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
                    onClick={() => subscribe(p)}
                    title={currentPrice > 0 && p.price_monthly_cents > currentPrice
                      ? 'Se cobra solo la diferencia prorrateada del mes'
                      : undefined}
                  >
                    {currentPrice > 0 && p.price_monthly_cents > currentPrice
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

      {pagando && (
        <PagoPlan
          plan={pagando}
          planActual={plans.find((p) => p.id === user?.plan_id) || null}
          onHecho={cobrado}
          onCerrar={() => setPagando(null)}
        />
      )}
    </div>
  );
}
