// AccountPage.jsx — "Ajustes": sección con sidebar interno (General, Cuenta,
// Privacidad, Facturación, Uso). Reemplaza la antigua vista plana de Mi cuenta.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { api } from '../lib/api';
import { getThemePreference, setThemePreference } from '../lib/theme';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Logo } from '../components/Logo';
import { UsageChart } from '../components/UsageChart';
import { planColor } from '../lib/planColors';
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

function Toggle({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`set-toggle ${checked ? 'is-on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="set-toggle__knob" />
    </button>
  );
}

// ── General ─────────────────────────────────────────────────────────────

function GeneralSection({ user, onSaved }) {
  const [first, setFirst] = useState(user.first_name || '');
  const [last, setLast] = useState(user.last_name || '');
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [themePref, setThemePref] = useState(getThemePreference);

  const changeTheme = (pref) => {
    setThemePreference(pref);
    setThemePref(pref);
  };

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
        <Row label="Apariencia" hint="Tema de la interfaz">
          <div className="set-seg" role="radiogroup" aria-label="Apariencia">
            {[
              { id: 'light', label: 'Claro' },
              { id: 'dark', label: 'Oscuro' },
              { id: 'system', label: 'Sistema' },
            ].map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`set-seg__btn ${themePref === opt.id ? 'is-active' : ''}`}
                onClick={() => changeTheme(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </Row>
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [delBusy, setDelBusy] = useState(false);
  const [delError, setDelError] = useState('');

  const deleteAccount = async (password) => {
    setDelBusy(true);
    setDelError('');
    try {
      await api.delete('/api/account', { data: { password } });
      await onLogout(); // la sesión ya no existe; limpia el estado y navega
    } catch (err) {
      const d = err.response?.data?.detail;
      setDelError(typeof d === 'string' ? d : 'No se pudo eliminar la cuenta. Intenta de nuevo.');
      setDelBusy(false);
    }
  };

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
        <Row label="Eliminar cuenta" hint="Borra tu cuenta y todos tus datos de forma permanente">
          <button className="pill-btn pill-btn--outline set-btn is-danger" onClick={() => setConfirmDelete(true)}>
            Eliminar cuenta
          </button>
        </Row>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="¿Eliminar tu cuenta?"
          confirmLabel="Eliminar cuenta"
          busyLabel="Eliminando…"
          requirePassword
          busy={delBusy}
          error={delError}
          onClose={() => setConfirmDelete(false)}
          onConfirm={deleteAccount}
        >
          Se borrarán tu perfil, tus conversaciones, tus API keys y tu suscripción de
          forma permanente. Esta acción no se puede deshacer. Escribe tu contraseña
          para confirmar.
        </ConfirmDialog>
      )}
    </>
  );
}

// ── Privacidad ──────────────────────────────────────────────────────────

function PrivacidadSection({ user, onUserChange }) {
  const [settings, setSettings] = useState(user.settings || null);
  const [busyKey, setBusyKey] = useState(null);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearError, setClearError] = useState('');
  const [cleared, setCleared] = useState(false);

  const exportData = async () => {
    setError('');
    setExporting(true);
    try {
      const res = await api.get('/api/account/export', { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `lixbon-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError('No se pudieron exportar tus datos. Intenta de nuevo.');
    } finally {
      setExporting(false);
    }
  };

  const clearHistory = async () => {
    setClearBusy(true);
    setClearError('');
    try {
      await api.delete('/api/account/conversations');
      setCleared(true);
      setConfirmClear(false);
    } catch {
      setClearError('No se pudo borrar el historial. Intenta de nuevo.');
    } finally {
      setClearBusy(false);
    }
  };

  useEffect(() => {
    if (settings) return;
    api.get('/api/account/settings')
      .then((res) => setSettings(res.data.settings))
      .catch(() => setError('No se pudieron cargar tus preferencias.'));
  }, [settings]);

  const toggle = async (key, value) => {
    setError('');
    setBusyKey(key);
    const prev = settings;
    setSettings({ ...settings, [key]: value }); // optimista
    try {
      const res = await api.patch('/api/account/settings', { [key]: value });
      setSettings(res.data.settings);
      onUserChange({ ...user, settings: res.data.settings });
    } catch {
      setSettings(prev);
      setError('No se pudo guardar el cambio. Intenta de nuevo.');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <>
      <h2 className="set-title">Privacidad</h2>
      <p className="set-lead">
        En lixbon tus conversaciones son tuyas. La inferencia ocurre en nuestro propio
        clúster y no compartimos tus datos con terceros.
      </p>
      {error && <p className="page__error" role="alert">{error}</p>}
      <div className="set-card">
        <Row label="Datos de uso anónimos" hint="Métricas agregadas para mejorar el servicio">
          {settings
            ? <Toggle label="Datos de uso anónimos" checked={settings.anonymous_usage}
                disabled={busyKey === 'anonymous_usage'}
                onChange={(v) => toggle('anonymous_usage', v)} />
            : <span className="set-static">…</span>}
        </Row>
        <Row label="Historial de conversaciones" hint="Guardar el historial de tus chats. Desactivado, los chats nuevos no se guardan (el uso sí se contabiliza)">
          {settings
            ? <Toggle label="Historial de conversaciones" checked={settings.save_history}
                disabled={busyKey === 'save_history'}
                onChange={(v) => toggle('save_history', v)} />
            : <span className="set-static">…</span>}
        </Row>
      </div>

      <h2 className="set-title">Tus datos</h2>
      <div className="set-card">
        <Row label="Exportar datos" hint="Descarga una copia de tus conversaciones y tu uso (JSON)">
          <button className="pill-btn pill-btn--outline set-btn" onClick={exportData} disabled={exporting}>
            {exporting ? 'Preparando…' : 'Exportar'}
          </button>
        </Row>
        <Row label="Borrar historial" hint="Elimina todas tus conversaciones de forma permanente">
          {cleared
            ? <span className="set-ok">Historial borrado ✓</span>
            : (
              <button className="pill-btn pill-btn--outline set-btn is-danger" onClick={() => setConfirmClear(true)}>
                Borrar historial
              </button>
            )}
        </Row>
      </div>

      {confirmClear && (
        <ConfirmDialog
          title="¿Borrar todo el historial?"
          confirmLabel="Borrar historial"
          busyLabel="Borrando…"
          busy={clearBusy}
          error={clearError}
          onClose={() => setConfirmClear(false)}
          onConfirm={clearHistory}
        >
          Se eliminarán todas tus conversaciones y sus mensajes de forma permanente.
          Las estadísticas de uso se conservan. Esta acción no se puede deshacer.
        </ConfirmDialog>
      )}
    </>
  );
}

// ── Facturación ─────────────────────────────────────────────────────────

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString() : '—');

function FacturacionSection({ plan }) {
  const [billing, setBilling] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [credits, setCredits] = useState(null);
  const [packs, setPacks] = useState(null);
  const [packBusy, setPackBusy] = useState(null);

  const creditsOk = new URLSearchParams(window.location.search).get('credits') === 'success';
  const upgradeOk = new URLSearchParams(window.location.search).get('upgrade') === 'success';

  useEffect(() => {
    api.get('/api/billing/status')
      .then((res) => setBilling(res.data))
      .catch(() => setError('No se pudo cargar tu facturación.'));
    api.get('/api/credits').then((res) => setCredits(res.data)).catch(() => {});
    api.get('/api/credits/packs').then((res) => setPacks(res.data)).catch(() => {});
    // aviso de retorno del checkout
    const params = new URLSearchParams(window.location.search);
    if (params.get('checkout') === 'success') {
      setError('');
    }
  }, []);

  const buyPack = async (packId) => {
    setError('');
    setPackBusy(packId);
    try {
      const res = await api.post('/api/credits/checkout', { pack_id: packId });
      window.location.href = res.data.url;
    } catch {
      setError('No se pudo iniciar la compra de créditos.');
      setPackBusy(null);
    }
  };

  const purchases = (credits?.ledger || []).filter((l) => l.kind === 'purchase');

  const openPortal = async () => {
    setBusy(true);
    try {
      const res = await api.post('/api/billing/portal');
      window.location.href = res.data.url;
    } catch {
      setError('No se pudo abrir el portal de facturación.');
      setBusy(false);
    }
  };

  const price = plan.price_monthly_cents === 0
    ? 'Gratis'
    : `$${(plan.price_monthly_cents / 100).toFixed(2)} / mes`;
  const paid = billing?.is_paid;
  const renews = new URLSearchParams(window.location.search).get('checkout') === 'success';

  return (
    <>
      {renews && (
        <p className="admin-ok" role="status">¡Listo! Tu suscripción se está activando. Puede tardar unos segundos en reflejarse.</p>
      )}
      {upgradeOk && (
        <p className="admin-ok" role="status">
          ¡Plan mejorado! Se cobró la diferencia — la verás en tus facturas.
        </p>
      )}
      {error && <p className="page__error" role="alert">{error}</p>}

      <h2 className="set-title">Plan</h2>
      <div className="set-card set-plan">
        <div className="set-plan__info">
          <span className="plan-pill" style={{ background: planColor(plan.id), color: '#fff' }}>Plan {plan.name}</span>
          <p className="card__muted">{plan.description}</p>
          <span className="set-plan__price">{price}</span>
          {paid && billing.current_period_end && (
            <span className="card__muted">
              {billing.cancel_at_period_end
                ? `Se cancela el ${fmtDate(billing.current_period_end)}`
                : `Se renueva el ${fmtDate(billing.current_period_end)}`}
            </span>
          )}
        </div>
        {paid ? (
          <button className="pill-btn pill-btn--primary set-btn" onClick={openPortal} disabled={busy}>
            {busy ? 'Abriendo…' : 'Ajustar plan'}
          </button>
        ) : (
          <Link to="/planes" className="pill-btn pill-btn--primary set-btn">
            <IconBolt size={15} /> {billing?.enabled ? 'Mejorar plan' : 'Ver planes'}
          </Link>
        )}
      </div>

      <h2 className="set-title">Créditos de API</h2>
      {creditsOk && (
        <p className="admin-ok" role="status">
          ¡Recarga completada! El saldo puede tardar unos segundos en reflejarse.
        </p>
      )}
      <p className="card__muted">
        {paid
          ? `Con tu plan ${plan.name}, el uso de la API ya está incluido en tu cuota mensual de tokens. Los créditos solo se descuentan si agotas esa cuota y quieres seguir usando la API el resto del mes.`
          : 'Sin plan de pago, cada petición con tu API key se descuenta de este saldo según la tarifa del modelo.'}
      </p>
      <div className="set-card">
        <Row
          label="Saldo disponible"
          hint={paid ? 'Solo se usa si agotas la cuota de tu plan' : 'Se descuenta por tokens al usar tus API keys'}
        >
          <span className="set-credits">
            {credits ? `$${credits.balance_usd.toFixed(2)}` : '…'}
          </span>
        </Row>
        <Row
          label="Recargar saldo"
          hint={packs?.enabled
            ? 'Pago único con tarjeta; los créditos no caducan'
            : 'Los pagos en línea llegan pronto'}
        >
          <div className="set-packs">
            {(packs?.packs || []).map((p) => (
              <button
                key={p.id}
                className="pill-btn pill-btn--outline set-btn"
                disabled={!packs?.enabled || packBusy !== null}
                onClick={() => buyPack(p.id)}
              >
                {packBusy === p.id ? 'Abriendo…' : `${p.name} · $${p.price_usd}`}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Precios por modelo" hint="Cuánto cuesta cada millón de tokens">
          <Link to="/docs/precios-api" className="pill-btn pill-btn--outline set-btn">Ver precios</Link>
        </Row>
      </div>

      {purchases.length > 0 && (
        <>
          <h2 className="set-title">Recargas</h2>
          <div className="set-card">
            <ul className="keys">
              {purchases.map((p) => (
                <li key={p.id} className="keys__item">
                  <div className="keys__info">
                    <span className="keys__name">{fmtDate(p.created_at)}</span>
                    <span className="keys__masked">{p.note || 'Recarga'}</span>
                  </div>
                  <span className="keys__meta">+${p.delta_usd.toFixed(2)}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <h2 className="set-title">Pago</h2>
      <div className="set-card">
        {paid && billing.payment_method ? (
          <Row label="Método de pago" hint="Gestiónalo desde el portal">
            <span className="set-static">
              {billing.payment_method.brand?.toUpperCase()} ···· {billing.payment_method.last4}
            </span>
          </Row>
        ) : (
          <Row label="Método de pago" hint={billing?.enabled ? 'Se añade al suscribirte' : 'Los pagos en línea llegan pronto'}>
            <SoonTag />
          </Row>
        )}
      </div>

      <h2 className="set-title">Facturas</h2>
      <div className="set-card">
        {paid && billing.invoices?.length > 0 ? (
          <ul className="keys">
            {billing.invoices.map((inv) => (
              <li key={inv.id} className="keys__item">
                <div className="keys__info">
                  <span className="keys__name">{fmtDate(inv.date)}</span>
                  <span className="keys__masked">{inv.currency} {inv.amount.toFixed(2)} · {inv.status}</span>
                </div>
                {inv.hosted_url && (
                  <a className="keys__meta" href={inv.hosted_url} target="_blank" rel="noreferrer">Ver</a>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="card__muted">Aún no tienes facturas. Aparecerán aquí cuando actives un plan de pago.</p>
        )}
      </div>

      <h2 className="set-title">Cancelación</h2>
      <div className="set-card">
        {paid ? (
          <Row label="Cancelar plan" hint="Gestiona la cancelación desde el portal de facturación">
            <button className="pill-btn pill-btn--outline set-btn is-danger" onClick={openPortal} disabled={busy}>
              Gestionar
            </button>
          </Row>
        ) : (
          <Row label="Cancelar plan" hint="Disponible con los planes de pago"><SoonTag /></Row>
        )}
      </div>
    </>
  );
}

// ── Uso ─────────────────────────────────────────────────────────────────

function UsoSection({ usage, daily, plan }) {
  const [apiUsage, setApiUsage] = useState(null);

  useEffect(() => {
    api.get('/api/credits/usage')
      .then((res) => setApiUsage(res.data.daily))
      .catch(() => setApiUsage([]));
  }, []);

  const apiTotal = (apiUsage || []).reduce((acc, r) => acc + r.cost_usd, 0);
  const paid = plan.price_monthly_cents > 0 && plan.id !== 'free';
  const unlimitedTokens = usage.tokens_per_month === -1;
  const withinQuota = unlimitedTokens || usage.tokens_month < usage.tokens_per_month;

  return (
    <>
      <h2 className="set-title">Uso del período <span className="set-plan-tag" style={{ background: planColor(plan.id), color: '#fff' }}>Plan {plan.name}</span></h2>
      <p className="card__muted">
        {paid
          ? 'Tu plan se mide en tokens (la barra de abajo). El chat de la web, el IDE y el CLI, y también la API, se cubren con esa cuota mensual. Solo pagas créditos aparte si agotas la cuota.'
          : 'Tu plan gratuito se mide en tokens (la barra de abajo) para el chat. El uso de la API con tu key se cobra por separado de tu saldo de créditos.'}
      </p>
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

      <h2 className="set-title">Consumo de créditos de API — últimos 30 días</h2>
      <div className="set-card">
        {paid && (
          <p className="card__muted">
            {withinQuota
              ? `Estás dentro de la cuota de tu plan ${plan.name}, así que tu uso de la API está incluido y no gasta créditos. Solo verás cargos aquí si agotas la cuota.`
              : `Agotaste la cuota mensual de tu plan ${plan.name}. A partir de ahí, el uso de la API se cobra de tus créditos, como se detalla abajo.`}
          </p>
        )}
        {apiUsage === null ? (
          <p className="card__muted">Cargando…</p>
        ) : apiUsage.length === 0 ? (
          <p className="card__muted">
            No hay cargos de créditos. Las peticiones con tu API key que se cobren
            del saldo aparecerán aquí desglosadas por día y modelo.
          </p>
        ) : (
          <>
            <div className="set-table-wrap">
              <table className="set-table">
                <thead>
                  <tr>
                    <th>Día</th>
                    <th>Modelo</th>
                    <th>Tokens entrada</th>
                    <th>Tokens salida</th>
                    <th>Peticiones</th>
                    <th>Costo</th>
                  </tr>
                </thead>
                <tbody>
                  {apiUsage.map((r, i) => (
                    <tr key={i}>
                      <td>{r.date}</td>
                      <td><code>{r.model}</code></td>
                      <td>{r.prompt_tokens.toLocaleString()}</td>
                      <td>{r.completion_tokens.toLocaleString()}</td>
                      <td>{r.requests}</td>
                      <td>${r.cost_usd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="set-table-total">Total del período: <strong>${apiTotal.toFixed(4)}</strong></p>
          </>
        )}
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
        <span className="brand app-loading__logo">LIXBON</span>
        <span className="app-loading__bar"><span /></span>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page__bar">
        <Link to="/" className="page__logo"><Logo size={30} /></Link>
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
              {current.id === 'privacidad' && <PrivacidadSection user={user} onUserChange={setUser} />}
              {current.id === 'facturacion' && <FacturacionSection plan={plan} />}
              {current.id === 'uso' && <UsoSection usage={account.usage} daily={account.daily} plan={plan} />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
