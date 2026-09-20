// AccountPage.jsx — "Ajustes": sección con sidebar interno (General, Perfil,
// Privacidad, Facturación, Uso). Reemplaza la antigua vista plana de Mi cuenta.
import { TemaBoton } from '../components/TemaBoton';
import { useSeo } from '../lib/seo';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Link, Navigate, useNavigate } from '../i18n/link';
import { useLocale } from '../i18n/LocaleContext';
import { useT } from '../i18n/useT';
import { FiCamera } from 'react-icons/fi';
import { useAuth } from '../hooks/useAuth';
import { api } from '../lib/api';
import { AVATAR_ACCEPT, validateAvatar, initialOf } from '../lib/avatar';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useConfirmar } from '../hooks/useConfirmar';
import { useReenvioVerificacion } from '../components/VerifyBanner';
import { Logo } from '../components/Logo';
import { UsageChart } from '../components/UsageChart';
import { SeccionFacturacion } from '../components/pagos/SeccionFacturacion';
import { planBadge } from '../lib/planColors';
import { LEGACY_ACCOUNT_SECTIONS } from '../i18n/paths';
import {
  IconGear, IconUser, IconShield, IconCard, IconChart,
  IconPlus, IconTrash, IconX, IconChevron, IconLogout,
  IconCheck,
} from '../components/Icons';

const unlimited = (v) => v === -1;

function useSections() {
  const t = useT('account');
  return [
    { id: 'general', label: t('sections.general'), Icon: IconUser },
    { id: 'profile', label: t('sections.profile'), Icon: IconGear },
    { id: 'privacy', label: t('sections.privacy'), Icon: IconShield },
    { id: 'billing', label: t('sections.billing'), Icon: IconCard },
    { id: 'usage', label: t('sections.usage'), Icon: IconChart },
  ];
}

function QuotaBar({ label, used, limit, resetHint, unlimitedLabel, showPercent }) {
  const pct = unlimited(limit) ? 0 : Math.min(100, (used / Math.max(1, limit)) * 100);
  const full = !unlimited(limit) && used >= limit;
  return (
    <div className="quota">
      <div className="quota__head">
        <span>{label}</span>
        <span className={full ? 'quota__count is-full' : 'quota__count'}>
          {unlimited(limit)
            ? unlimitedLabel
            : showPercent ? `${Math.round(pct)}%` : `${used.toLocaleString()} / ${limit.toLocaleString()}`}
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

function SoonTag() {
  const tc = useT('common');
  return <span className="set-soon">{tc('comingSoon')}</span>;
}

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

function AvatarField({ user, onSaved }) {
  const t = useT('account');
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /** Tras cambiar la foto se relee el usuario: es la fuente de verdad que
      comparten la web y el IDE. */
  const sync = async () => {
    const me = await api.get('/api/auth/me');
    onSaved(me.data.user);
  };

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // permite reelegir el mismo archivo
    if (!file) return;

    const problem = validateAvatar(file);
    if (problem) { setError(problem); return; }

    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      // El cliente axios manda application/json por defecto, y con ese header
      // convertiría el FormData a JSON. Hay que declarar el multipart.
      await api.post('/api/account/avatar', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      await sync();
    } catch (err) {
      setError(err?.response?.data?.detail?.message || t('general.uploadError'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await api.delete('/api/account/avatar');
      await sync();
    } catch {
      setError(t('general.removeError'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="set-avatar-field">
      <input ref={fileRef} type="file" accept={AVATAR_ACCEPT} hidden onChange={pick} />

      {/* La foto ES el botón: al pasar el ratón aparece la cámara. */}
      <button
        className="avatar-edit"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        title={user.avatar_url ? t('general.changePhoto') : t('general.uploadPhoto')}
      >
        {user.avatar_url ? (
          <img className="set-avatar set-avatar--img" src={user.avatar_url} alt="" />
        ) : (
          <span className="set-avatar">{initialOf(user)}</span>
        )}
        <span className="avatar-edit__overlay">
          {busy ? <span className="avatar-edit__spinner" /> : <FiCamera size={17} />}
        </span>
      </button>

      {user.avatar_url && (
        <button className="avatar-edit__remove" onClick={remove} disabled={busy}>
          {t('general.remove')}
        </button>
      )}

      {error && <p className="set-error">{error}</p>}
    </div>
  );
}

function GeneralSection({ user, onSaved }) {
  const t = useT('account');
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
      <div className="set-card">
        <h2 className="set-title">{t('general.profileTitle')}</h2>
        <Row label={t('general.avatarLabel')} hint={t('general.avatarHint')}>
          <AvatarField user={user} onSaved={onSaved} />
        </Row>
        <Row label={t('general.firstName')}>
          <input className="set-input" value={first} onChange={(e) => setFirst(e.target.value)} />
        </Row>
        <Row label={t('general.lastName')}>
          <input className="set-input" value={last} onChange={(e) => setLast(e.target.value)} />
        </Row>
        <Row label={t('general.email')} hint={t('general.emailHint')}>
          <span className="set-static">{user.email || user.username}</span>
        </Row>
      </div>
      <div className="set-actions">
        {ok && <span className="set-ok"><IconCheck size={13} /> {t('general.saved')}</span>}
        <button className="pill-btn pill-btn--primary" disabled={!dirty || busy} onClick={save}>
          {busy ? t('general.saving') : t('general.save')}
        </button>
      </div>

      <div className="set-card">
        <h2 className="set-title">{t('general.preferencesTitle')}</h2>
        <Row label={t('general.language')} hint={t('general.languageHint')}><SoonTag /></Row>
      </div>
    </>
  );
}

// ── Perfil (cuenta) ────────────────────────────────────────────────────

function ProfileSection({ user, plan, keys, onReloadKeys, onLogout, onPedirLogout }) {
  const t = useT('account');
  const [newKey, setNewKey] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pwSent, setPwSent] = useState(false);
  const { estado: verifyState, reenviar: resendVerify } = useReenvioVerificacion();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [delBusy, setDelBusy] = useState(false);
  const [delError, setDelError] = useState('');
  const confirmar = useConfirmar();

  const deleteAccount = async (password) => {
    setDelBusy(true);
    setDelError('');
    try {
      await api.delete('/api/account', { data: { password } });
      await onLogout(); // la sesión ya no existe; limpia el estado y navega
    } catch (err) {
      const d = err.response?.data?.detail;
      setDelError(typeof d === 'string' ? d : t('profile.deleteAccountError'));
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
      setError((d && d.message) || d || t('profile.createKeyError'));
    } finally {
      setBusy(false);
    }
  };

  const deleteKey = async (id) => {
    const ok = await confirmar({
      titulo: t('profile.deactivateKeyConfirm.title'),
      texto: t('profile.deactivateKeyConfirm.text'),
      etiqueta: t('profile.deactivateKeyConfirm.label'),
    });
    if (!ok) return;
    try {
      await api.delete(`/api/keys/${id}`);
      await onReloadKeys();
    } catch {
      setError(t('profile.deactivateKeyError'));
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
      <div className="set-card">
        <h2 className="set-title">{t('profile.title')}</h2>
        <Row
          label={t('profile.email')}
          hint={user.email_verified
            ? t('profile.emailHintVerified')
            : verifyState === 'enviado'
              ? t('profile.emailHintSent')
              : verifyState === 'error'
                ? t('profile.emailHintError')
                : t('profile.emailHintUnverified')}
        >
          <span className="set-static">{user.email || user.username}</span>
          <span className={user.email_verified ? 'verify-chip is-ok' : 'verify-chip'}>
            {user.email_verified ? t('profile.verified') : t('profile.unverified')}
          </span>
          {!user.email_verified && user.email && verifyState !== 'enviado' && (
            <button
              className="pill-btn pill-btn--outline set-btn"
              onClick={resendVerify}
              disabled={verifyState === 'enviando'}
            >
              {verifyState === 'enviando' ? t('profile.sending') : t('profile.resendVerification')}
            </button>
          )}
        </Row>
        <Row label={t('profile.password')} hint={t('profile.passwordHint')}>
          {pwSent
            ? <span className="set-ok"><IconCheck size={13} /> {t('profile.linkSent')}</span>
            : <button className="pill-btn pill-btn--outline set-btn" onClick={sendReset}>{t('profile.changePassword')}</button>}
        </Row>
      </div>

      <div className="set-card">
        <h2 className="set-title">{t('profile.apiKeysTitle')}</h2>
        {error && <p className="page__error" role="alert">{error}</p>}
        <div className="set-row set-row--head">
          <span className="card__muted">
            {t('profile.activeKeysOf', { active: activeKeys.length, max: unlimited(plan.max_api_keys) ? t('profile.unlimitedKeys') : plan.max_api_keys })}
          </span>
          <button className="pill-btn pill-btn--primary set-btn" onClick={createKey} disabled={busy}>
            <IconPlus size={14} /> {t('profile.newKey')}
          </button>
        </div>

        {newKey && (
          <div className="key-reveal">
            <div>
              <strong>{t('profile.saveKeyNow')}</strong>
              <code>{newKey}</code>
            </div>
            <button className="icon-btn" onClick={() => setNewKey(null)} aria-label={t('profile.close')}><IconX /></button>
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
                {k.is_active ? (k.last_accessed ? t('profile.usedOn', { date: new Date(k.last_accessed).toLocaleDateString() }) : t('profile.unused')) : t('profile.inactive')}
              </span>
              {k.is_active && (
                <button className="icon-btn" onClick={() => deleteKey(k.id)} aria-label={t('profile.deactivateAria', { name: k.name })}>
                  <IconTrash size={15} />
                </button>
              )}
            </li>
          ))}
          {keys.length === 0 && <p className="card__muted">{t('profile.noKeys')}</p>}
        </ul>
      </div>

      <div className="set-card">
        <h2 className="set-title">{t('profile.sessionTitle')}</h2>
        <Row label={t('profile.logOut')} hint={t('profile.logOutHint')}>
          <button className="pill-btn pill-btn--outline set-btn" onClick={onPedirLogout}>
            <IconLogout size={14} /> {t('profile.logOut')}
          </button>
        </Row>
        <Row label={t('profile.deleteAccount')} hint={t('profile.deleteAccountHint')}>
          <button className="pill-btn pill-btn--outline set-btn is-danger" onClick={() => setConfirmDelete(true)}>
            {t('profile.deleteAccount')}
          </button>
        </Row>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title={t('profile.deleteAccountConfirm.title')}
          confirmLabel={t('profile.deleteAccountConfirm.confirmLabel')}
          busyLabel={t('profile.deleteAccountConfirm.busyLabel')}
          requirePassword
          busy={delBusy}
          error={delError}
          onClose={() => setConfirmDelete(false)}
          onConfirm={deleteAccount}
        >
          {t('profile.deleteAccountConfirm.body')}
        </ConfirmDialog>
      )}
    </>
  );
}

// ── Privacidad ──────────────────────────────────────────────────────────

function PrivacySection({ user, onUserChange }) {
  const t = useT('account');
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
      setError(t('privacy.exportError'));
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
      setClearError(t('privacy.clearError'));
    } finally {
      setClearBusy(false);
    }
  };

  useEffect(() => {
    if (settings) return;
    api.get('/api/account/settings')
      .then((res) => setSettings(res.data.settings))
      .catch(() => setError(t('privacy.settingsLoadError')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setError(t('privacy.settingsSaveError'));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <>
      <div className="set-card">
        <h2 className="set-title">{t('privacy.title')}</h2>
        <p className="set-lead">
          {t('privacy.lead')}
        </p>
        {error && <p className="page__error" role="alert">{error}</p>}
        <Row label={t('privacy.anonymousUsage')} hint={t('privacy.anonymousUsageHint')}>
          {settings
            ? <Toggle label={t('privacy.anonymousUsage')} checked={settings.anonymous_usage}
                disabled={busyKey === 'anonymous_usage'}
                onChange={(v) => toggle('anonymous_usage', v)} />
            : <span className="set-static">…</span>}
        </Row>
        <Row label={t('privacy.history')} hint={t('privacy.historyHint')}>
          {settings
            ? <Toggle label={t('privacy.history')} checked={settings.save_history}
                disabled={busyKey === 'save_history'}
                onChange={(v) => toggle('save_history', v)} />
            : <span className="set-static">…</span>}
        </Row>
      </div>

      <div className="set-card">
        <h2 className="set-title">{t('privacy.dataTitle')}</h2>
        <Row label={t('privacy.exportData')} hint={t('privacy.exportDataHint')}>
          <button className="pill-btn pill-btn--outline set-btn" onClick={exportData} disabled={exporting}>
            {exporting ? t('privacy.preparing') : t('privacy.export')}
          </button>
        </Row>
        <Row label={t('privacy.clearHistory')} hint={t('privacy.clearHistoryHint')}>
          {cleared
            ? <span className="set-ok"><IconCheck size={13} /> {t('privacy.historyCleared')}</span>
            : (
              <button className="pill-btn pill-btn--outline set-btn is-danger" onClick={() => setConfirmClear(true)}>
                {t('privacy.clearHistory')}
              </button>
            )}
        </Row>
      </div>

      {confirmClear && (
        <ConfirmDialog
          title={t('privacy.clearHistoryConfirm.title')}
          confirmLabel={t('privacy.clearHistoryConfirm.confirmLabel')}
          busyLabel={t('privacy.clearHistoryConfirm.busyLabel')}
          busy={clearBusy}
          error={clearError}
          onClose={() => setConfirmClear(false)}
          onConfirm={clearHistory}
        >
          {t('privacy.clearHistoryConfirm.body')}
        </ConfirmDialog>
      )}
    </>
  );
}

// ── Uso ─────────────────────────────────────────────────────────────────

function UsageSection({ usage, buckets, daily, plan }) {
  const t = useT('account');
  const locale = useLocale();
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
      <div className="set-card">
        <h2 className="set-title">{t('usage.periodTitle')} <span className="set-plan-tag" style={{ background: planBadge(plan.id).bg, color: planBadge(plan.id).ink }}>{t('usage.plan', { name: plan.name })}</span></h2>
        <p className="card__muted">
          {paid ? t('usage.paidDesc') : t('usage.freeDesc')}
        </p>
        <QuotaBar
          showPercent
          label={t('usage.sessionTitle')}
          used={buckets.session.used}
          limit={buckets.session.unlimited ? -1 : buckets.session.limit}
          unlimitedLabel={t('unlimited')}
          resetHint={`${t('usage.sessionHint')} ${t('usage.resetsAt', { date: new Date(buckets.session.reset_at).toLocaleString(locale) })}`}
        />
        <QuotaBar
          showPercent
          label={t('usage.weekTitle')}
          used={buckets.week.used}
          limit={buckets.week.unlimited ? -1 : buckets.week.limit}
          unlimitedLabel={t('unlimited')}
          resetHint={`${t('usage.weekHint')} ${t('usage.resetsAt', { date: new Date(buckets.week.reset_at).toLocaleString(locale) })}`}
        />
      </div>

      <div className="set-card">
        <h2 className="set-title">{t('usage.dailyTokensTitle')}</h2>
        <UsageChart daily={daily} />
      </div>

      <div className="set-card">
        <h2 className="set-title">{t('usage.apiCreditsTitle')}</h2>
        {paid && (
          <p className="card__muted">
            {withinQuota
              ? t('usage.withinQuota', { name: plan.name })
              : t('usage.overQuota', { name: plan.name })}
          </p>
        )}
        {apiUsage === null ? (
          <p className="card__muted">…</p>
        ) : apiUsage.length === 0 ? (
          <p className="card__muted">
            {t('usage.noCharges')}
          </p>
        ) : (
          <>
            <div className="set-table-wrap">
              <table className="set-table">
                <thead>
                  <tr>
                    <th>{t('usage.tableDay')}</th>
                    <th>{t('usage.tableModel')}</th>
                    <th>{t('usage.tableInputTokens')}</th>
                    <th>{t('usage.tableOutputTokens')}</th>
                    <th>{t('usage.tableRequests')}</th>
                    <th>{t('usage.tableCost')}</th>
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
            <p className="set-table-total">{t('usage.periodTotal')} <strong>${apiTotal.toFixed(4)}</strong></p>
          </>
        )}
      </div>
    </>
  );
}

// ── Página ──────────────────────────────────────────────────────────────

export default function AccountPage() {
  const t = useT('account');
  const SECTIONS = useSections();
  useSeo({ title: t('seoTitle'), noindex: true });
  const { user, setUser, loading, logout } = useAuth();
  const navigate = useNavigate();
  const { section } = useParams();
  const [account, setAccount] = useState(null);
  const [keys, setKeys] = useState([]);
  const [error, setError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);

  const legacyTarget = section && !SECTIONS.some((s) => s.id === section) ? LEGACY_ACCOUNT_SECTIONS[section] : null;
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
    load().catch(() => setError(t('loadError')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, loading, load]);

  useEffect(() => { setMenuOpen(false); }, [section]);

  const confirmar = useConfirmar();

  const doLogout = async () => { await logout(); navigate('/'); };

  const pedirLogout = async () => {
    const ok = await confirmar({
      titulo: t('logoutConfirm.title'),
      texto: t('logoutConfirm.text'),
      etiqueta: t('logoutConfirm.label'),
      peligro: false,
    });
    if (ok) doLogout();
  };

  const plan = account?.plan;

  if (legacyTarget) {
    return <Navigate to={`/account/${legacyTarget}`} replace />;
  }

  if (loading || (!account && !error)) {
    return (
      <div className="app-loading">
        <span className="app-loading__logo"><Logo size={19} /></span>
        <span className="app-loading__bar"><span /></span>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page__bar">
        <Link to="/chat" className="page__logo"><Logo /></Link>
        <TemaBoton />
        <Link to="/chat" className="pill-btn pill-btn--outline page__back">{t('backToChat')}</Link>
      </header>

      <h1 className="page__title settings__title">{t('title')}</h1>

      <div className="settings">
        <button
          className="docs__menu-toggle"
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-controls="settings-nav"
        >
          {current.label} <IconChevron size={14} open={menuOpen} />
        </button>

        <aside id="settings-nav" className={`settings__nav ${menuOpen ? 'is-open' : ''}`}>
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
            /* key por sección: cambiar de pestaña vuelve a montar este bloque y
               dispara su animación de entrada. Las secciones ya se montaban y
               desmontaban una a una, así que no se pierde ningún estado que
               antes sobreviviera. */
            <div className="settings__pane" key={current.id}>
              {current.id === 'general' && <GeneralSection user={user} onSaved={setUser} />}
              {current.id === 'profile' && (
                <ProfileSection
                  user={user}
                  plan={plan}
                  keys={keys}
                  onReloadKeys={loadKeys}
                  onLogout={doLogout}
                  onPedirLogout={pedirLogout}
                />
              )}
              {current.id === 'privacy' && <PrivacySection user={user} onUserChange={setUser} />}
              {current.id === 'billing' && <SeccionFacturacion plan={plan} />}
              {current.id === 'usage' && <UsageSection usage={account.usage} buckets={account.buckets} daily={account.daily} plan={plan} />}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
