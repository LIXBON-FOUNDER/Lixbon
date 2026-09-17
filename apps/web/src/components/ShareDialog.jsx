// ShareDialog.jsx — modal para compartir una conversación por enlace público.
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { IconX, IconCopy, IconCheck, IconTrash } from './Icons';
import { useCierreAnimado } from '../hooks/useCierreAnimado';
import { useT } from '../i18n/useT';

export function ShareDialog({ conversationId, onClose }) {
  const t = useT('dialogs');
  const tc = useT('common');
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const { cerrando, cerrar } = useCierreAnimado(onClose);

  const link = token ? `${window.location.origin}/s/${token}` : '';

  useEffect(() => {
    api.get(`/api/conversations/${conversationId}/share`)
      .then((res) => setToken(res.data.token))
      .catch(() => setError(t('shareLoadError')))
      .finally(() => setLoading(false));
  }, [conversationId, t]);

  const enable = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.post(`/api/conversations/${conversationId}/share`);
      setToken(res.data.token);
    } catch {
      setError(t('shareCreateError'));
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
      setError(t('shareRevokeError'));
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
    <div className={cerrando ? 'modal-overlay is-closing' : 'modal-overlay'} onClick={cerrar}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">{t('shareTitle')}</h2>
          <button className="icon-btn" onClick={cerrar} aria-label={tc('close')}><IconX /></button>
        </div>

        {loading ? (
          <p className="card__muted">{tc('loading')}</p>
        ) : token ? (
          <>
            <p className="card__muted modal__desc">
              {t('shareDescActive')}
            </p>
            <div className="share-link">
              <input className="share-link__input" value={link} readOnly onFocus={(e) => e.target.select()} />
              <button className="pill-btn pill-btn--primary share-link__copy" onClick={copy}>
                {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
                {copied ? tc('copied') : tc('copy')}
              </button>
            </div>
            <button className="modal__revoke" onClick={revoke} disabled={busy}>
              <IconTrash size={14} /> {t('revokeLink')}
            </button>
          </>
        ) : (
          <>
            <p className="card__muted modal__desc">
              {t('shareDescInactive')}
            </p>
            <button className="pill-btn pill-btn--primary modal__cta" onClick={enable} disabled={busy}>
              {busy ? t('creating') : t('createShareLink')}
            </button>
          </>
        )}
        {error && <p className="page__error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
