// PlansPage.jsx — página de precios. Con los pagos activos, el plan se cobra en
// un modal sin salir de lixbon; si no, las tarjetas muestran "Próximamente".
import { tieneVisuals } from '../lib/planes';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '../i18n/link';
import { Link } from '../i18n/link';
import { useT } from '../i18n/useT';
import { useAuth } from '../hooks/useAuth';
import { api } from '../lib/api';
import { PublicNav } from '../components/PublicNav';
import { PublicFooter } from '../components/PublicFooter';
import { PagoPlan } from '../components/pagos/PagoPlan';
import { IconCheck, IconCard } from '../components/Icons';
import { SITE_URL, useSeo } from '../lib/seo';

export default function PlansPage() {
  const t = useT('plans');
  const tc = useT('common');
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [plans, setPlans] = useState([]);
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [pagando, setPagando] = useState(null); // plan cuyo modal está abierto
  const [error, setError] = useState('');

  // Cupo semanal expresado como múltiplo del plan Gratuito, no en créditos
  // crudos (la unidad interna no es un número que el usuario deba interpretar).
  const freeWeekMult = plans.find((pl) => pl.id === 'free')?.week_credit_multiplier || 1;
  const weekQuotaLabel = (p) => {
    const multiple = p.week_credit_multiplier / freeWeekMult;
    return p.id === 'free' || multiple <= 1
      ? t('weekBase')
      : t('weekMultiple', { count: Number.isInteger(multiple) ? multiple : multiple.toFixed(1) });
  };

  const jsonLd = useMemo(() => (plans.length ? {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'lixbon',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Web, Windows, Linux, macOS, Android',
    url: SITE_URL,
    offers: plans.map((p) => ({
      '@type': 'Offer',
      name: `${p.name}`,
      price: (p.price_monthly_cents / 100).toFixed(2),
      priceCurrency: p.currency || 'USD',
      url: `${SITE_URL}/plans`,
    })),
  } : null), [plans]);
  useSeo({
    title: t('seoTitle'),
    description: t('seoDescription'),
    path: '/plans',
    jsonLd,
  });

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
        <h1 className="page__title page__title--center">{t('title')}</h1>
        <p className="plans__sub">
          {t('subtitle')}{!billingEnabled && t('onlinePaymentsSoon')}
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
                  {p.id === 'pro' && <span className="plan-card__tag">{t('mostChosen')}</span>}
                </div>
                <p className="plan-card__price">
                  {p.price_monthly_cents === 0
                    ? '$0'
                    : `$${(p.price_monthly_cents / 100).toFixed(2)} `}
                  {paid && <span>{t('perMonth')}</span>}
                </p>
                <p className="plan-card__desc">{p.description}</p>

                {/* La acción va antes de la lista: quien ya sabe qué plan
                    quiere no tiene que leerse seis viñetas para llegar a ella. */}
                {current ? (
                  <span className="pill-btn pill-btn--outline plan-card__cta is-current">{t('currentPlan')}</span>
                ) : !paid ? (
                  // Volver al gratuito desde un plan de pago es cancelar, no
                  // registrarse: mandar a /auth a quien ya tiene cuenta y plan
                  // le ofrece lo único que no necesita.
                  currentPrice > 0 ? (
                    <Link to="/account/billing" className="pill-btn pill-btn--outline plan-card__cta">
                      {t('cancelSubscription')}
                    </Link>
                  ) : (
                    <Link to="/auth?mode=register" className="pill-btn pill-btn--outline plan-card__cta">{t('startFree')}</Link>
                  )
                ) : billingEnabled ? (
                  <button
                    className="pill-btn pill-btn--primary plan-card__cta"
                    onClick={() => subscribe(p)}
                    title={currentPrice > 0
                      ? (p.price_monthly_cents > currentPrice
                        ? t('prorationTooltip')
                        : t('creditedTooltip'))
                      : undefined}
                  >
                    {currentPrice > 0
                      ? (p.price_monthly_cents > currentPrice
                        ? t('upgradeTo', { name: p.name })
                        : t('changeTo', { name: p.name }))
                      : t('subscribeTo', { name: p.name })}
                  </button>
                ) : (
                  <span className="pill-btn pill-btn--primary plan-card__cta is-soon" title={t('comingSoonTooltip')}>
                    {tc('comingSoon')}
                  </span>
                )}

                <ul className="plan-card__features">
                  {[
                    t('sessionWindow'),
                    weekQuotaLabel(p),
                    p.max_api_keys === -1 ? t('unlimitedApiKeys') : t('apiKeyCount', { count: p.max_api_keys, plural: p.max_api_keys === 1 ? '' : 's' }),
                    t('requestsPerMinute', { rate: p.rate_limit_per_min }),
                    p.allowed_models ? t('smallModels') : t('allModels'),
                    ...(tieneVisuals({ plan_id: p.id }) ? [t('visualsFeature')] : []),
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
            {t('apiNoteBefore')} <strong>API key</strong> {t('apiNoteMiddle')}{' '}
            <Link to="/account/billing">{t('accountBillingLink')}</Link>.
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
      <PublicFooter />
    </div>
  );
}
