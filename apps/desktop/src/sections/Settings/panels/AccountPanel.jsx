// AccountPanel.jsx — perfil, plan y API key. Las keys se administran en la web.
import { useState } from 'react';
import { useAppStore } from '../../../store/appStore';
import { planColor } from '../../../lib/planColors';
import { openExternal } from '../../../lib/tauri';
import { IconEye, IconEyeOff, IconCopy, IconCheck } from '../../../components/Icons';

export function AccountPanel() {
  const { serverUrl, apiKey, user, setUser, logout } = useAppStore();

  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revalidating, setRevalidating] = useState(false);
  const [keyStatus, setKeyStatus] = useState('');

  const displayName =
    user?.first_name ? `${user.first_name} ${user.last_name || ''}`.trim()
    : user?.username || user?.email || '—';

  const maskedKey = apiKey
    ? `${apiKey.slice(0, 12)}${'•'.repeat(16)}${apiKey.slice(-4)}`
    : '';

  const handleCopyKey = async () => {
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard no disponible */ }
  };

  const handleRevalidate = async () => {
    setRevalidating(true);
    setKeyStatus('');
    try {
      const res = await fetch(`${serverUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        setUser((await res.json()).user);
        setKeyStatus('La key es válida. Perfil actualizado.');
      } else if (res.status === 401) {
        setKeyStatus('La key ya no es válida: fue revocada o expiró.');
      } else {
        setKeyStatus(`El servidor respondió ${res.status}.`);
      }
    } catch {
      setKeyStatus('No se pudo conectar con el servidor.');
    } finally {
      setRevalidating(false);
    }
  };

  return (
    <>
      <section className="settings__panel">
        <h3 className="settings__panel-title">Perfil</h3>
        <div className="settings__rows">
          <div className="settings__row">
            <span className="settings__row-label">Usuario</span>
            <span className="settings__row-value">{displayName}</span>
          </div>
          {user?.email && (
            <div className="settings__row">
              <span className="settings__row-label">Correo</span>
              <span className="settings__row-value">{user.email}</span>
            </div>
          )}
          <div className="settings__row">
            <span className="settings__row-label">Plan</span>
            <span className="settings__row-value" style={{ color: planColor(user?.plan_id) }}>
              {user?.plan_name || 'Gratuito'}
            </span>
          </div>
        </div>
        <div className="settings__actions">
          <button
            className="pill-btn pill-btn--outline"
            onClick={() => openExternal(`${serverUrl}/account`)}
          >
            Gestionar cuenta en la web
          </button>
          <button className="pill-btn pill-btn--outline settings__danger" onClick={logout}>
            Cerrar sesión
          </button>
        </div>
      </section>

      <section className="settings__panel">
        <h3 className="settings__panel-title">API key</h3>
        <div className="settings__key">
          <code className="settings__key-value">{showKey ? apiKey : maskedKey}</code>
          <span className="settings__key-actions">
            <button className="icon-btn" onClick={() => setShowKey(!showKey)} title={showKey ? 'Ocultar' : 'Mostrar'}>
              {showKey ? <IconEyeOff size={16} /> : <IconEye size={16} />}
            </button>
            <button className="icon-btn" onClick={handleCopyKey} title="Copiar">
              {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
            </button>
          </span>
        </div>
        <div className="settings__actions">
          <button className="pill-btn pill-btn--outline" onClick={handleRevalidate} disabled={revalidating}>
            {revalidating ? 'Comprobando…' : 'Revalidar key'}
          </button>
          <button
            className="pill-btn pill-btn--outline"
            onClick={() => openExternal(`${serverUrl}/account`)}
          >
            Gestionar keys en la web
          </button>
        </div>
        {keyStatus && <p className="settings__status">{keyStatus}</p>}
      </section>
    </>
  );
}
