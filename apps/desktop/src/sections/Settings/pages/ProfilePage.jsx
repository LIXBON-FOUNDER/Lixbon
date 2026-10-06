// ProfilePage.jsx — Ajustes → Perfil y cuenta: foto, nombre, plan, claves de
// API (listar, crear, revocar) y cierre de sesión.
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../../store/appStore';
import { api } from '../../../lib/api';
import { AVATAR_ACCEPT, validateAvatar, uploadAvatar, removeAvatar, fetchMe } from '../../../lib/account';
import { openExternal } from '../../../lib/tauri';
import { showConfirm } from '../../../lib/confirm';
import { Avatar } from '../../../components/Avatar';
import { SpinRing } from '../../../components/Ring';
import { IconPlus } from '../../../components/Icons';

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

function relTime(iso) {
  if (!iso) return 'sin uso';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `usada hace ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `usada hace ${Math.round(s / 3600)} h`;
  return `usada hace ${Math.round(s / 86400)} días`;
}

function useCopy() {
  const [copied, setCopied] = useState('');
  const copy = (id, text) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? '' : c)), 1600);
    }).catch(() => {});
  };
  return [copied, copy];
}

export function ProfilePage() {
  const { user, serverUrl, apiKey, setUser, logout } = useAppStore();
  const [first, setFirst] = useState(user?.first_name || '');
  const [last, setLast] = useState(user?.last_name || '');
  const [savingName, setSavingName] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [keys, setKeys] = useState(null);
  const [newKey, setNewKey] = useState(null);
  const [keyName, setKeyName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [copied, copy] = useCopy();
  const fileRef = useRef(null);

  const loadKeys = () => api.get('/api/keys').then((r) => setKeys((r.keys || []).filter((k) => k.is_active))).catch(() => setKeys([]));
  useEffect(() => { loadKeys(); }, []);

  if (!user) return <span className="skeleton" style={{ height: 120, display: 'block' }} />;

  const nameDirty = first !== (user.first_name || '') || last !== (user.last_name || '');
  const nameValid = first.trim() && last.trim();
  const since = user.created_at ? new Date(user.created_at).toLocaleDateString('es', { month: 'long', year: 'numeric' }) : '';
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || user.email;

  const saveName = async () => {
    setSavingName(true);
    setError('');
    try {
      const res = await api.patch('/api/account/profile', { first_name: first, last_name: last });
      if (res?.user) setUser(res.user);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSavingName(false);
    }
  };

  const onPick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const problem = validateAvatar(file);
    if (problem) { setError(problem); return; }
    setAvatarBusy(true);
    try {
      await uploadAvatar(serverUrl, apiKey, file);
      setUser(await fetchMe(serverUrl, apiKey));
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setAvatarBusy(false);
    }
  };

  const dropAvatar = async () => {
    setAvatarBusy(true);
    try {
      await removeAvatar(serverUrl, apiKey);
      setUser(await fetchMe(serverUrl, apiKey));
    } finally {
      setAvatarBusy(false);
    }
  };

  const createKey = async () => {
    setCreating(true);
    setError('');
    try {
      const res = await api.post('/api/keys', { name: keyName.trim() || 'lixbon desktop' });
      setNewKey(res.api_key);
      setKeyName('');
      await loadKeys();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setCreating(false);
    }
  };

  const deleteAccount = async () => {
    const { choice, value } = await showConfirm({
      title: 'Eliminar la cuenta',
      message: `Se borrará ${user.email} con todos sus datos. Escribe tu contraseña para confirmarlo.`,
      input: { placeholder: 'Contraseña', type: 'password', value: '' },
      options: [{ id: 'delete', label: 'Eliminar para siempre', kind: 'danger' }, { id: 'cancel', label: 'Cancelar' }],
    });
    if (choice !== 'delete' || !value) return;
    setError('');
    try {
      await api.delete('/api/account', { body: { password: value } });
      logout();
    } catch (e) {
      setError(String(e.message || e));
    }
  };

  const revoke = async (id) => {
    try {
      await api.delete(`/api/keys/${id}`);
      await loadKeys();
    } catch (e) {
      setError(String(e.message || e));
    }
  };

  return (
    <div className="spage">
      <div className="spage__head rise">
        <button className="profile__avatar" onClick={() => fileRef.current?.click()} disabled={avatarBusy} title="Cambiar foto">
          <Avatar user={user} serverUrl={serverUrl} size={64} />
          {avatarBusy && <span className="profile__avatar-busy"><SpinRing size={20} /></span>}
        </button>
        <input ref={fileRef} type="file" accept={AVATAR_ACCEPT} hidden onChange={onPick} />
        <div className="spage__title">
          <span className="spage__h1">{displayName}</span>
          <span className="spage__sub">{user.email}{since ? ` · miembro desde ${since}` : ''}</span>
        </div>
        <span className="plantag">{user.plan_name || 'Gratuito'}</span>
        {user.avatar_url && <button className="lk" onClick={dropAvatar}>Quitar foto</button>}
      </div>

      {error && <p className="spage__error">{error}</p>}

      <section className="ssec rise rise--1">
        <span className="ssec__label">Nombre</span>
        <div className="ssec__grid2">
          {user.username && (
            <label className="fieldlabel ssec__full">Usuario<div className="field"><span className="mono profile__at">@</span><input value={user.username} readOnly /></div></label>
          )}
          <label className="fieldlabel">Nombre<div className="field field--strong"><input value={first} onChange={(e) => setFirst(e.target.value)} /></div></label>
          <label className="fieldlabel">Apellidos<div className="field field--strong"><input value={last} onChange={(e) => setLast(e.target.value)} /></div></label>
        </div>
        {nameDirty && (
          <div className="ssec__actions drop-in">
            <button className="btn btn--primary" onClick={saveName} disabled={savingName || !nameValid} title={nameValid ? '' : 'Nombre y apellidos son obligatorios'}>{savingName && <SpinRing size={12} color="var(--on-primary)" />}Guardar</button>
            <button className="lk" onClick={() => { setFirst(user.first_name || ''); setLast(user.last_name || ''); }}>Descartar</button>
          </div>
        )}
      </section>

      <section className="ssec rise rise--2">
        <div className="ssec__row">
          <span className="ssec__label">Claves de API</span>
          <div className="panelhead__fill" />
          <div className="field keyname">
            <input value={keyName} placeholder="Nombre de la clave" onChange={(e) => setKeyName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') createKey(); }} />
          </div>
          <button className="lk is-accent" onClick={createKey} disabled={creating}>
            {creating ? <SpinRing size={12} /> : <IconPlus size={13} />} Crear clave
          </button>
        </div>

        {newKey && (
          <div className="newkey drop-in">
            <span className="newkey__hint">Cópiala ahora: no se volverá a mostrar.</span>
            <div className="newkey__row">
              <span className="mono newkey__value">{newKey}</span>
              <button className="btn btn--primary btn--sm" onClick={() => copy('new', newKey)}>{copied === 'new' ? 'Copiada' : 'Copiar'}</button>
              <button className="lk" onClick={() => setNewKey(null)}>Listo</button>
            </div>
          </div>
        )}

        {keys === null && <span className="skeleton" style={{ height: 40, display: 'block' }} />}
        {keys && keys.length === 0 && <span className="mcpd__muted">No tienes claves activas.</span>}
        {keys && keys.map((k) => (
          <div key={k.id} className="keyrow">
            <div className="keyrow__id">
              <span>{k.name}</span>
              <span className="mono keyrow__meta">{k.masked_key} · creada {fmtDate(k.created_at)} · {relTime(k.last_accessed)}</span>
            </div>
            <button className="lk is-danger" onClick={() => revoke(k.id)}>Revocar</button>
          </div>
        ))}
      </section>

      <section className="ssec rise rise--3">
        <span className="ssec__label">Sesión</span>
        <div className="ssec__actions">
          <button className="btn btn--ghost" onClick={() => openExternal(`${serverUrl}/account`)}>Gestionar cuenta en la web</button>
          <button className="btn btn--ghost" onClick={() => copy('cur', apiKey)}>{copied === 'cur' ? 'Clave copiada' : 'Copiar la clave de esta sesión'}</button>
          <div className="panelhead__fill" />
          <button className="lk is-danger" onClick={logout}>Cerrar sesión</button>
        </div>
      </section>

      <section className="ssec rise rise--3">
        <span className="ssec__label">Zona peligrosa</span>
        <div className="ssec ssec--card srow">
          <div className="srow__text">
            <span className="srow__label">Eliminar cuenta</span>
            <span className="srow__hint">Borra la cuenta, las conversaciones y las claves en todas las apps. No se puede deshacer.</span>
          </div>
          <button className="btn btn--ghost profile__danger" onClick={deleteAccount}>Eliminar cuenta</button>
        </div>
      </section>
    </div>
  );
}
