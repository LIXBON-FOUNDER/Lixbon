// ShareDialog.jsx — modal para compartir una conversación por enlace público.
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { IconX, IconCopy, IconCheck, IconTrash } from './Icons';

export function ShareDialog({ conversationId, onClose }) {
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const link = token ? `${window.location.origin}/s/${token}` : '';

  useEffect(() => {
    api.get(`/api/conversations/${conversationId}/share`)
      .then((res) => setToken(res.data.token))
      .catch(() => setError('No se pudo cargar el estado de compartir.'))
      .finally(() => setLoading(false));
  }, [conversationId]);

  const enable = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.post(`/api/conversations/${conversationId}/share`);
      setToken(res.data.token);
    } catch {
      setError('No se pudo crear el enlace.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      await api.delete(`/api/conversations/${conversationId}/share`);
      setToken(null);
    } catch {
      setError('No se pudo revocar el enlace.');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard no disponible */ }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">Compartir conversación</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Cerrar"><IconX /></button>
        </div>

        {loading ? (
          <p className="card__muted">Cargando…</p>
        ) : token ? (
          <>
            <p className="card__muted modal__desc">
              Cualquiera con el enlace puede ver esta conversación (solo lectura).
              Los mensajes que envíes después no se incluirán hasta que vuelvas a compartir.
            </p>
            <div className="share-link">
              <input className="share-link__input" value={link} readOnly onFocus={(e) => e.target.select()} />
              <button className="pill-btn pill-btn--primary share-link__copy" onClick={copy}>
                {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
                {copied ? 'Copiado' : 'Copiar'}
              </button>
            </div>
            <button className="modal__revoke" onClick={revoke} disabled={busy}>
              <IconTrash size={14} /> Revocar enlace
            </button>
          </>
        ) : (
          <>
            <p className="card__muted modal__desc">
              Crea un enlace público de solo lectura para compartir esta conversación.
              Podrás revocarlo cuando quieras.
            </p>
            <button className="pill-btn pill-btn--primary modal__cta" onClick={enable} disabled={busy}>
              {busy ? 'Creando…' : 'Crear enlace para compartir'}
            </button>
          </>
        )}
        {error && <p className="page__error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
