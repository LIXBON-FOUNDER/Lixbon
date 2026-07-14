// AccountMenu.jsx — foto de perfil en la barra de título y menú de la cuenta.
//
// La foto se sube con un <input type="file"> del propio WebView: no hace falta
// ningún comando de Rust (el sandbox de archivos está atado al workspace, y una
// foto de perfil puede estar en cualquier sitio del disco).
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { Avatar } from '../components/Avatar';
import {
  AVATAR_ACCEPT, validateAvatar, uploadAvatar, removeAvatar, fetchMe,
} from '../lib/account';
import { openExternal } from '../lib/tauri';
import { planColor } from '../lib/planColors';
import { IconUser, IconGear, IconChart, IconGlobe, IconTrash, IconLogout } from '../components/Icons';

export function AccountMenu() {
  const { user, serverUrl, apiKey, setUser, openModal, logout } = useAppStore();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const rootRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;

  const displayName =
    [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || user.email;

  /** Tras cambiar la foto: releer el usuario del servidor, que es la fuente de
      verdad compartida con la web. */
  const syncUser = async () => {
    try {
      setUser(await fetchMe(serverUrl, apiKey));
    } catch { /* la foto ya está subida; el usuario se refrescará al reabrir */ }
  };

  const onPick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // permite reelegir el mismo archivo
    if (!file) return;

    const problem = validateAvatar(file);
    if (problem) { setError(problem); return; }

    setBusy(true);
    setError('');
    try {
      await uploadAvatar(serverUrl, apiKey, file);
      await syncUser();
      setOpen(false);
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

  const go = (fn) => { setOpen(false); fn(); };

  return (
    <div className="account" ref={rootRef}>
      <button
        className={`account__btn ${open ? 'is-open' : ''}`}
        onClick={() => { setOpen(!open); setError(''); }}
        title={`${displayName} · Cuenta`}
      >
        <Avatar user={user} serverUrl={serverUrl} size={24} />
      </button>

      <input
        ref={fileRef}
        type="file"
        accept={AVATAR_ACCEPT}
        hidden
        onChange={onPick}
      />

      {open && (
        <div className="account__menu">
          <div className="account__head">
            <Avatar user={user} serverUrl={serverUrl} size={44} />
            <div className="account__id">
              <span className="account__name">{displayName}</span>
              {user.email && <span className="account__email">{user.email}</span>}
              <span
                className="account__plan"
                style={{ color: planColor(user.plan_id || 'free') }}
              >
                Plan {user.plan_name || 'Gratuito'}
              </span>
            </div>
          </div>

          {error && <p className="account__error">{error}</p>}

          <div className="account__photo">
            <button
              className="settings__btn"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              {busy ? 'Subiendo…' : user.avatar_url ? 'Cambiar foto' : 'Subir foto'}
            </button>
            {user.avatar_url && (
              <button className="icon-btn" onClick={onRemove} disabled={busy} title="Quitar foto">
                <IconTrash size={15} />
              </button>
            )}
            <span className="account__hint">PNG, JPG o WEBP · máx. 3 MB</span>
          </div>

          <div className="ctx-menu__sep" />

          <button className="ctx-menu__item" onClick={() => go(() => openModal('settings', 'account'))}>
            <IconUser size={14} /> Información de la cuenta
          </button>
          <button className="ctx-menu__item" onClick={() => go(() => openModal('metrics'))}>
            <IconChart size={14} /> Consumo del plan
          </button>
          <button className="ctx-menu__item" onClick={() => go(() => openModal('settings'))}>
            <IconGear size={14} /> Ajustes
          </button>
          <button className="ctx-menu__item" onClick={() => go(() => openExternal(`${serverUrl}/account`))}>
            <IconGlobe size={14} /> Gestionar en la web
          </button>

          <div className="ctx-menu__sep" />

          <button className="ctx-menu__item is-danger" onClick={() => go(logout)}>
            <IconLogout size={14} /> Cerrar sesión
          </button>
        </div>
      )}
    </div>
  );
}
