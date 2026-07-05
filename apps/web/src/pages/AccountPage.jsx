// AccountPage.jsx — "Ajustes": sección con sidebar interno (General, Cuenta,
// Privacidad, Facturación, Uso). Reemplaza la antigua vista plana de Mi cuenta.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { api } from '../lib/api';
import { Logo } from '../components/Logo';
import { UsageChart } from '../components/UsageChart';
import {
  IconGear, IconUser, IconShield, IconCard, IconChart,
  IconPlus, IconTrash, IconX, IconChevron, IconBolt, IconLogout,
} from '../components/Icons';

const unlimited = (v) => v === -1;

const SECTIONS = [
  { id: 'general', label: 'General', Icon: IconUser },
  { id: 'cuenta', label: 'Cuenta', Icon: IconGear },
  { id: 'privacidad', label: 'Privacidad', Icon: IconShield },
  { id: 'facturacion', label: 'Facturación', Icon: IconCard },
  { id: 'uso', label: 'Uso', Icon: IconChart },
];

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

function Row({ label, hint, children }) {
  return (
    <div className="set-row">
      <div className="set-row__label">
        <span>{label}</span>
        {hint && <span className="set-row__hint">{hint}</span>}
      </div>
      <div className="set-row__control">{children}</div>
    </div>
  );
}

const SoonTag = () => <span className="set-soon">Próximamente</span>;

// ── General ─────────────────────────────────────────────────────────────

function GeneralSection({ user, onSaved }) {
  const [first, setFirst] = useState(user.first_name || '');
  const [last, setLast] = useState(user.last_name || '');
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);

  const dirty = first.trim() !== (user.first_name || '') || last.trim() !== (user.last_name || '');

  const save = async () => {
    setBusy(true);
    setOk(false);
    try {
      const res = await api.patch('/api/account/profile', { first_name: first.trim(), last_name: last.trim() });
      onSaved(res.data.user);
      setOk(true);
      setTimeout(() => setOk(false), 2500);
    } catch { /* noop */ } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2 className="set-title">Perfil</h2>
      <div className="set-card">
        <Row label="Avatar">
          <span className="set-avatar">{(first || user.username || '?')[0].toUpperCase()}</span>
        </Row>
        <Row label="Nombre">
          <input className="set-input" value={first} onChange={(e) => setFirst(e.target.value)} />
        </Row>
        <Row label="Apellido">
          <input className="set-input" value={last} onChange={(e) => setLast(e.target.value)} />
        </Row>
        <Row label="Correo" hint="No se puede cambiar">
          <span className="set-static">{user.email || user.username}</span>
        </Row>
      </div>
      <div className="set-actions">
        {ok && <span className="set-ok">Guardado ✓</span>}
        <button className="pill-btn pill-btn--primary" disabled={!dirty || busy} onClick={save}>
          {busy ? 'Guardando…' : 'Guardar cambios'}
        </button>
      </div>

      <h2 className="set-title">Preferencias</h2>
      <div className="set-card">
        <Row label="Apariencia" hint="Tema claro / oscuro"><SoonTag /></Row>
        <Row label="Idioma" hint="Idioma de la interfaz"><SoonTag /></Row>
      </div>
    </>
  );
}

// ── Cuenta ──────────────────────────────────────────────────────────────

function CuentaSection({ user, plan, keys, onReloadKeys, onLogout }) {
  const [newKey, setNewKey] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pwSent, setPwSent] = useState(false);

  const activeKeys = keys.filter((k) => k.is_active);

  const createKey = async () => {
    setError('');
    setBusy(true);
    try {
      const res = await api.post('/api/keys', { name: `Key ${new Date().toISOString().slice(0, 10)}` });
      setNewKey(res.data.api_key);
      await onReloadKeys();
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
      await onReloadKeys();
    } catch {
      setError('No se pudo desactivar la key');
    }
  };

  const sendReset = async () => {
    try {
      await api.post('/api/auth/request-password-reset', { email: user.email || user.username });
      setPwSent(true);
    } catch { setPwSent(true); }
  };

  return (
    <>
      <h2 className="set-title">Cuenta</h2>
      <div className="set-card">
        <Row label="Correo" hint={user.email_verified ? 'Verificado' : 'Sin verificar'}>
          <span className="set-static">{user.email || user.username}</span>
        </Row>
        <Row label="Contraseña" hint="Te enviamos un enlace por correo para cambiarla">
          {pwSent
            ? <span className="set-ok">Enlace enviado ✓</span>
            : <button className="pill-btn pill-btn--outline set-btn" onClick={sendReset}>Cambiar contraseña</button>}
        </Row>
      </div>

      <h2 className="set-title">API keys</h2>
      {error && <p className="page__error" role="alert">{error}</p>}
      <div className="set-card">
        <div className="set-row set-row--head">
          <span className="card__muted">
            {activeKeys.length} activa(s) de {unlimited(plan.max_api_keys) ? 'ilimitadas' : plan.max_api_keys} en tu plan.
          </span>
          <button className="pill-btn pill-btn--primary set-btn" onClick={createKey} disabled={busy}>
            <IconPlus size={14} /> Nueva key
          </button>
        </div>

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
      </div>

      <h2 className="set-title">Sesión</h2>
      <div className="set-card">
        <Row label="Cerrar sesión" hint="Cierra tu sesión en este navegador">
          <button className="pill-btn pill-btn--outline set-btn" onClick={onLogout}>
            <IconLogout size={14} /> Cerrar sesión
          </button>
        </Row>
        <Row label="Eliminar cuenta" hint="Borra tu cuenta y tus datos"><SoonTag /></Row>
      </div>
    </>
  );
}

// ── Privacidad ──────────────────────────────────────────────────────────

function PrivacidadSection() {
  return (
    <>
      <h2 className="set-title">Privacidad</h2>
      <p className="set-lead">
        En FOLAX tus conversaciones son tuyas. La inferencia ocurre en nuestro propio
        clúster y no compartimos tus datos con terceros.
      </p>
      <div className="set-card">
        <Row label="Datos de uso anónimos" hint="Métricas agregadas para mejorar el servicio"><SoonTag /></Row>
        <Row label="Historial de conversaciones" hint="Guardar el historial de tus chats"><SoonTag /></Row>
      </div>

      <h2 className="set-title">Tus datos</h2>
      <div className="set-card">
        <Row label="Exportar datos" hint="Descarga una copia de tus conversaciones"><SoonTag /></Row>
        <Row label="Borrar historial" hint="Elimina todas tus conversaciones"><SoonTag /></Row>
      </div>
    </>
  );
}

// ── Facturación ─────────────────────────────────────────────────────────

function FacturacionSection({ plan }) {
  const price = plan.price_monthly_cents === 0
    ? 'Gratis'
    : `$${(plan.price_monthly_cents / 100).toFixed(2)} / mes`;
  return (
    <>
      <h2 className="set-title">Plan</h2>
      <div className="set-card set-plan">
        <div className="set-plan__info">
          <span className="plan-pill">Plan {plan.name}</span>
          <p className="card__muted">{plan.description}</p>
          <span className="set-plan__price">{price}</span>
        </div>
        <Link to="/planes" className="pill-btn pill-btn--primary set-btn">
          <IconBolt size={15} /> Ajustar plan
        </Link>
      </div>

      <h2 className="set-title">Pago</h2>
      <div className="set-card">
        <Row label="Método de pago" hint="Los pagos en línea llegan pronto"><SoonTag /></Row>
      </div>

      <h2 className="set-title">Facturas</h2>
      <div className="set-card">
        <p className="card__muted">Aún no tienes facturas. Aparecerán aquí cuando actives un plan de pago.</p>
      </div>

      <h2 className="set-title">Cancelación</h2>
      <div className="set-card">
        <Row label="Cancelar plan" hint="Disponible con los planes de pago"><SoonTag /></Row>
      </div>
    </>
  );
}

// ── Uso ─────────────────────────────────────────────────────────────────

function UsoSection({ usage, daily, plan }) {
  return (
    <>
      <h2 className="set-title">Uso del período <span className="set-plan-tag">Plan {plan.name}</span></h2>
      <div className="set-card">
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
      </div>

      <h2 className="set-title">Tokens por día — últimos 30 días</h2>
      <div className="set-card">
        <UsageChart daily={daily} />
      </div>
    </>
  );
}

// ── Página ──────────────────────────────────────────────────────────────

export default function AccountPage() {
  const { user, setUser, loading, logout } = useAuth();
  const navigate = useNavigate();
  const { section } = useParams();
  const [account, setAccount] = useState(null);
  const [keys, setKeys] = useState([]);
  const [error, setError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);

  const current = SECTIONS.find((s) => s.id === section) || SECTIONS[0];

  const loadKeys = useCallback(async () => {
    const res = await api.get('/api/keys');
    setKeys(res.data.keys);
  }, []);

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
    if (!user) { navigate('/auth', { replace: true }); return; }
    load().catch(() => setError('No se pudo cargar tu cuenta. Intenta de nuevo.'));
  }, [user, loading, navigate, load]);

  useEffect(() => { setMenuOpen(false); }, [section]);

  const doLogout = async () => { await logout(); navigate('/'); };

  const plan = account?.plan;

  if (loading || (!account && !error)) {
    return (
      <div className="app-loading">
        <span className="brand app-loading__logo">FOLAX</span>
        <span className="app-loading__bar"><span /></span>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page__bar">
        <Link to="/" className="page__logo"><Logo size={22} /></Link>
        <Link to="/" className="pill-btn pill-btn--outline page__back">Volver al chat</Link>
      </header>

      <div className="settings">
        <button className="docs__menu-toggle" onClick={() => setMenuOpen((v) => !v)}>
          {current.label} <IconChevron size={14} open={menuOpen} />
        </button>

        <aside className={`settings__nav ${menuOpen ? 'is-open' : ''}`}>
          <span className="settings__nav-title">Ajustes</span>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={`settings__nav-link ${s.id === current.id ? 'is-active' : ''}`}
              onClick={() => navigate(`/account/${s.id}`)}
            >
              <s.Icon size={16} /> {s.label}
            </button>
          ))}
        </aside>

        <main className="settings__content">
          {error && <p className="page__error" role="alert">{error}</p>}
          {account && user && (
            <>
              {current.id === 'general' && <GeneralSection user={user} onSaved={setUser} />}
              {current.id === 'cuenta' && (
                <CuentaSection user={user} plan={plan} keys={keys} onReloadKeys={loadKeys} onLogout={doLogout} />
              )}
              {current.id === 'privacidad' && <PrivacidadSection />}
              {current.id === 'facturacion' && <FacturacionSection plan={plan} />}
              {current.id === 'uso' && <UsoSection usage={account.usage} daily={account.daily} plan={plan} />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
