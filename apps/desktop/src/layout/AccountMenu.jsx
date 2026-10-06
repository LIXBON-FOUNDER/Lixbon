// AccountMenu.jsx — tarjeta de cuenta al fondo del sidebar. Un clic abre un
// popover anclado (no un modal: el resto de la app queda intacto detrás) con
// dos páginas internas — Perfil y Consumo — que comparten el mismo origen.
//
// El sidebar tiene overflow:hidden (lo necesita para plegarse como una
// cortina sin que el contenido se derrame) — eso mismo recortaba este
// popover, que crece HACIA ARRIBA desde la tarjeta y es más ancho que el
// propio sidebar. Igual que Select.jsx con sus desplegables: se monta en un
// portal sobre <body> con posición fija calculada desde la tarjeta.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FiCamera } from 'react-icons/fi';
import { useAppStore } from '../store/appStore';
import { Avatar } from '../components/Avatar';
import {
  AVATAR_ACCEPT, validateAvatar, uploadAvatar, removeAvatar, fetchMe,
} from '../lib/account';
import { api } from '../lib/api';
import { openExternal } from '../lib/tauri';
import { planColor } from '../lib/planColors';
import { useAnchoredAbove } from '../lib/useAnchoredPopover';
import {
  IconGear, IconGlobe, IconLogout, IconX, IconCopy,
} from '../components/Icons';

function fmtReset(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('es', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function maskKey(key) {
  if (!key || key.length < 8) return key || '';
  return `${key.slice(0, 10)}••••${key.slice(-4)}`;
}

function ProfilePage({ user, serverUrl, apiKey, busy, error, onPickAvatar, onRemoveAvatar, onGoUsage, onClose }) {
  const displayName =
    [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || user.email;
  const copyKey = () => navigator.clipboard.writeText(apiKey).catch(() => {});

  return (
    <>
      <div className="acctpop__head">
        <span className="acctpop__title">Perfil</span>
        <button className="iconbtn" onClick={onClose} title="Cerrar"><IconX size={12} /></button>
      </div>

      <div className="acctpop__id">
        <button
          className="avatar-edit"
          onClick={onPickAvatar}
          disabled={busy}
          title={user.avatar_url ? 'Cambiar foto' : 'Subir foto'}
        >
          <Avatar user={user} serverUrl={serverUrl} size={44} />
          <span className="avatar-edit__overlay">
            {busy ? <span className="avatar-edit__spinner" /> : <FiCamera size={13} />}
          </span>
        </button>
        <div className="acctpop__idtext">
          <div className="acctpop__name">{displayName}</div>
          {user.email && <div className="acctpop__email">{user.email}</div>}
        </div>
      </div>

      {error && <p className="account__error">{error}</p>}
      {user.avatar_url && (
        <button className="avatar-edit__remove" onClick={onRemoveAvatar} disabled={busy}>Quitar foto</button>
      )}

      <div className="acctpop__plan">
        <div>
          <div className="acctpop__plan-name" style={{ color: planColor(user.plan_id || 'free') }}>
            Plan {user.plan_name || 'Gratuito'}
          </div>
          <button className="acctpop__link" onClick={onGoUsage}>Ver consumo</button>
        </div>
        <button className="pillbtn" onClick={() => openExternal(`${serverUrl}/account`)}>Gestionar</button>
      </div>

      {apiKey && (
        <div className="acctpop__key">
          <span className="acctpop__key-value">{maskKey(apiKey)}</span>
          <button className="iconbtn" onClick={copyKey} title="Copiar la clave completa">
            <IconCopy size={12} />
          </button>
        </div>
      )}

      <div className="acctpop__foot">
        <button className="acctpop__link" onClick={() => { onClose(); useAppStore.getState().openModal('settings'); }}>
          <IconGear size={12} /> Ajustes
        </button>
        <button className="acctpop__link" onClick={() => openExternal(`${serverUrl}/account`)}>
          <IconGlobe size={12} /> Cuenta en la web
        </button>
        <button className="acctpop__link acctpop__link--danger" onClick={() => { onClose(); useAppStore.getState().logout(); }}>
          <IconLogout size={12} /> Cerrar sesión
        </button>
      </div>
    </>
  );
}

function BucketMeter({ label, bucket }) {
  const pct = bucket.unlimited ? 0 : Math.min(100, Math.round(bucket.percent));
  return (
    <div className="acctpop__quota-line" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
      <div className="acctpop__quota-line">
        <span>{label}</span>
        <span className="acctpop__quota-pct">{bucket.unlimited ? '∞' : `${pct}%`}</span>
      </div>
      {!bucket.unlimited && (
        <span className="acctpop__meter">
          <span className="acctpop__meter-fill" style={{ width: `${pct}%` }} />
        </span>
      )}
      <span className="acctpop__hint" style={{ margin: 0 }}>Se reinicia {fmtReset(bucket.reset_at)}</span>
    </div>
  );
}

function UsagePage({ user, serverUrl, usage, onBack, onClose }) {
  return (
    <>
      <div className="acctpop__head">
        <span className="acctpop__title">Consumo</span>
        <button className="iconbtn" onClick={onClose} title="Cerrar"><IconX size={12} /></button>
      </div>
      <p className="acctpop__hint">Sesión (4h) y semana — el mismo cupo en web, escritorio, CLI y móvil</p>

      {usage ? (
        <>
          <div className="acctpop__quota" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <BucketMeter label="Sesión actual" bucket={usage.buckets.session} />
            <BucketMeter label="Esta semana" bucket={usage.buckets.week} />
          </div>

          <div className="acctpop__plan">
            <div>
              <div className="acctpop__plan-name" style={{ color: planColor(user.plan_id || 'free') }}>
                Plan {user.plan_name || 'Gratuito'}
              </div>
              <button className="acctpop__link" onClick={onBack}>← Perfil</button>
            </div>
            <button className="pillbtn" onClick={() => openExternal(`${serverUrl}/account`)}>Actualizar</button>
          </div>
        </>
      ) : (
        <span className="skeleton" style={{ height: 90, borderRadius: 14, display: 'block' }} />
      )}
    </>
  );
}

export function AccountMenu({ compact = false }) {
  const { user, serverUrl, apiKey } = useAppStore();

  const [open, setOpen] = useState(false);
  const [page, setPage] = useState('profile'); // 'profile' | 'usage'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [usage, setUsage] = useState(null);
  const rootRef = useRef(null);
  const popRef = useRef(null);
  const fileRef = useRef(null);
  const pos = useAnchoredAbove(rootRef, open, compact ? { align: 'right', below: true } : { align: 'left' });

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (rootRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || usage) return;
    api.get('/api/account/usage').then(setUsage).catch(() => {});
  }, [open, usage]);

  // El comando /usage (menú "/" del composer) abre directo la página de
  // Consumo del popover, sin pasar por Perfil primero.
  useEffect(() => {
    const onOpenUsage = () => { setPage('usage'); setOpen(true); };
    window.addEventListener('lixbon:open-usage', onOpenUsage);
    return () => window.removeEventListener('lixbon:open-usage', onOpenUsage);
  }, []);

  if (!user) {
    // apiKey ya cargó (por eso se ve el sidebar) pero el perfil todavía no
    // llegó del servidor: un hueco vacío aquí es más confuso que un esqueleto.
    if (compact) return <span className="skeleton acctavatar" />;
    return (
      <div className="acctwrap">
        <div className="acctcard">
          <span className="skeleton" style={{ width: 30, height: 30, borderRadius: 999, flexShrink: 0 }} />
          <div className="acctcard__id">
            <span className="skeleton" style={{ width: '70%', height: 11, borderRadius: 4, display: 'block', marginBottom: 5 }} />
            <span className="skeleton" style={{ width: '45%', height: 9, borderRadius: 4, display: 'block' }} />
          </div>
        </div>
      </div>
    );
  }

  const displayName =
    [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || user.email;

  const syncUser = async () => {
    try {
      useAppStore.getState().setUser(await fetchMe(serverUrl, apiKey));
    } catch { /* la foto ya está subida; el usuario se refrescará al reabrir */ }
  };

  const onPick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const problem = validateAvatar(file);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError('');
    try {
      await uploadAvatar(serverUrl, apiKey, file);
      await syncUser();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    setBusy(true);
    setError('');
    try {
      await removeAvatar(serverUrl, apiKey);
      await syncUser();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  };

  const close = () => { setOpen(false); setPage('profile'); };

  return (
    <div className="acctwrap" ref={rootRef}>
      {compact ? (
        <button
          className={`acctavatar ${open ? 'is-open' : ''}`}
          onClick={() => { setOpen((v) => !v); setError(''); }}
          title={`${displayName} · Cuenta`}
        >
          <Avatar user={user} serverUrl={serverUrl} size={26} />
        </button>
      ) : (
        <button
          className={`acctcard ${open ? 'is-open' : ''}`}
          onClick={() => { setOpen((v) => !v); setError(''); }}
          title={`${displayName} · Cuenta`}
        >
          <Avatar user={user} serverUrl={serverUrl} size={30} />
          <div className="acctcard__id">
            <div className="acctcard__name">{displayName}</div>
            <div className="acctcard__plan">Plan {user.plan_name || 'Gratuito'}</div>
          </div>
        </button>
      )}

      <input ref={fileRef} type="file" accept={AVATAR_ACCEPT} hidden onChange={onPick} />

      {open && pos && createPortal(
        <div className="acctpop" ref={popRef} style={pos}>
          {page === 'profile' ? (
            <ProfilePage
              user={user} serverUrl={serverUrl} apiKey={apiKey}
              busy={busy} error={error}
              onPickAvatar={() => fileRef.current?.click()}
              onRemoveAvatar={onRemove}
              onGoUsage={() => setPage('usage')}
              onClose={close}
            />
          ) : (
            <UsagePage
              user={user} serverUrl={serverUrl} usage={usage}
              onBack={() => setPage('profile')}
              onClose={close}
            />
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
