// AccountPage.jsx — "Mi cuenta" (F5): plan vigente, uso del período con barras,
// gráfica de 30 días y gestión de API keys.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { api } from '../lib/api';
import { Logo } from '../components/Logo';
import { UsageChart } from '../components/UsageChart';
import { IconPlus, IconTrash, IconX } from '../components/Icons';

const unlimited = (v) => v === -1;

function QuotaBar({ label, used, limit, resetHint }) {
  const pct = unlimited(limit) ? 0 : Math.min(100, (used / Math.max(1, limit)) * 100);
  const full = !unlimited(limit) && used >= limit;
  return (
    <div className="quota">
      <div className="quota__head">
        <span>{label}</span>
        <span className={full ? 'quota__count is-full' : 'quota__count'}>
          {used.toLocaleString()} / {unlimited(limit) ? 'Ilimitado' : limit.toLocaleString()}
        </span>
      </div>
      {!unlimited(limit) && (
        <div className="quota__track">
          <div className={`quota__fill ${full ? 'is-full' : ''}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      <span className="quota__reset">{resetHint}</span>
    </div>
  );
}

export default function AccountPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [account, setAccount] = useState(null);
  const [keys, setKeys] = useState([]);
  const [newKey, setNewKey] = useState(null); // se muestra UNA vez
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [usage, keysRes] = await Promise.all([
      api.get('/api/account/usage'),
      api.get('/api/keys'),
    ]);
    setAccount(usage.data);
    setKeys(keysRes.data.keys);
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate('/auth', { replace: true });
      return;
    }
    load().catch(() => setError('No se pudo cargar tu cuenta. Intenta de nuevo.'));
  }, [user, loading, navigate, load]);

  const createKey = async () => {
    setError('');
    setBusy(true);
    try {
      const res = await api.post('/api/keys', { name: `Key ${new Date().toISOString().slice(0, 10)}` });
      setNewKey(res.data.api_key);
      await load();
    } catch (err) {
      const d = err.response?.data?.detail;
      setError((d && d.message) || d || 'No se pudo crear la key');
    } finally {
      setBusy(false);
    }
  };

  const deleteKey = async (id) => {
    if (!window.confirm('¿Desactivar esta API key? Las integraciones que la usen dejarán de funcionar.')) return;
    try {
      await api.delete(`/api/keys/${id}`);
      await load();
    } catch {
      setError('No se pudo desactivar la key');
    }
  };

  if (loading || (!account && !error)) {
    return (
      <div className="app-loading">
        <span className="brand app-loading__logo">FOLAX</span>
        <span className="app-loading__bar"><span /></span>
      </div>
    );
  }

  const plan = account?.plan;
  const usage = account?.usage;
  const activeKeys = keys.filter((k) => k.is_active);

  return (
    <div className="page">
      <header className="page__bar">
        <Link to="/" className="page__logo"><Logo size={17} /></Link>
        <Link to="/" className="pill-btn pill-btn--outline page__back">Volver al chat</Link>
      </header>

      <main className="page__body">
        <h1 className="page__title">Mi cuenta</h1>
        {error && <p className="page__error" role="alert">{error}</p>}

        {account && (
          <>
            <section className="card">
              <div className="card__row">
                <div>
                  <h2 className="card__title">Plan</h2>
                  <p className="card__muted">{plan.description}</p>
                </div>
                <span className="plan-pill">Plan {plan.name}</span>
              </div>
              <Link to="/planes" className="pill-btn pill-btn--primary card__cta">Ver planes</Link>
            </section>

            <section className="card">
              <h2 className="card__title">Uso del período</h2>
              <QuotaBar
                label="Mensajes hoy"
                used={usage.messages_today}
                limit={usage.messages_per_day}
                resetHint={`Se reinicia ${new Date(usage.day_resets_at).toLocaleString()}`}
              />
              <QuotaBar
                label="Tokens este mes"
                used={usage.tokens_month}
                limit={usage.tokens_per_month}
                resetHint={`Se reinicia ${new Date(usage.month_resets_at).toLocaleDateString()}`}
              />
            </section>

            <section className="card">
              <h2 className="card__title">Tokens por día — últimos 30 días</h2>
              <UsageChart daily={account.daily} />
            </section>

            <section className="card">
              <div className="card__row">
                <h2 className="card__title">API keys</h2>
                <button className="pill-btn pill-btn--primary card__small-cta" onClick={createKey} disabled={busy}>
                  <IconPlus size={14} /> Nueva key
                </button>
              </div>
              <p className="card__muted">
                {activeKeys.length} activa(s) de {unlimited(plan.max_api_keys) ? 'ilimitadas' : plan.max_api_keys} permitida(s) en tu plan.
              </p>

              {newKey && (
                <div className="key-reveal">
                  <div>
                    <strong>Guárdala ahora — no se volverá a mostrar:</strong>
                    <code>{newKey}</code>
                  </div>
                  <button className="icon-btn" onClick={() => setNewKey(null)} aria-label="Cerrar"><IconX /></button>
                </div>
              )}

              <ul className="keys">
                {keys.map((k) => (
                  <li key={k.id} className={`keys__item ${k.is_active ? '' : 'is-inactive'}`}>
                    <div className="keys__info">
                      <span className="keys__name">{k.name}</span>
                      <code className="keys__masked">{k.masked_key}</code>
                    </div>
                    <span className="keys__meta">
                      {k.is_active ? (k.last_accessed ? `Usada ${new Date(k.last_accessed).toLocaleDateString()}` : 'Sin usar') : 'Inactiva'}
                    </span>
                    {k.is_active && (
                      <button className="icon-btn" onClick={() => deleteKey(k.id)} aria-label={`Desactivar ${k.name}`}>
                        <IconTrash size={15} />
                      </button>
                    )}
                  </li>
                ))}
                {keys.length === 0 && <p className="card__muted">Aún no tienes API keys.</p>}
              </ul>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
