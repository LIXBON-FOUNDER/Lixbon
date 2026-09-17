// ConfirmDialog.jsx — modal de confirmación para acciones destructivas.
// Con requirePassword pide la contraseña (reautenticación) y la pasa a onConfirm.
import { useState } from 'react';
import { IconX } from './Icons';
import { useCierreAnimado } from '../hooks/useCierreAnimado';
import { useT } from '../i18n/useT';

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busyLabel,
  requirePassword = false,
  danger = true,
  error = '',
  busy = false,
  onConfirm,
  onClose,
}) {
  const t = useT('dialogs');
  const tc = useT('common');
  const [password, setPassword] = useState('');
  const canConfirm = !busy && (!requirePassword || password.length > 0);
  const { cerrando, cerrar } = useCierreAnimado(onClose, { bloqueado: busy });

  return (
    <div
      className={cerrando ? 'modal-overlay is-closing' : 'modal-overlay'}
      onClick={busy ? undefined : cerrar}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">{title}</h2>
          <button className="icon-btn" onClick={cerrar} aria-label={tc('close')} disabled={busy}>
            <IconX />
          </button>
        </div>

        <div className="card__muted modal__desc">{children}</div>

        {requirePassword && (
          <input
            type="password"
            className="set-input modal__password"
            placeholder={t('yourPassword')}
            value={password}
            autoFocus
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canConfirm) onConfirm(password); }}
          />
        )}

        {error && <p className="page__error" role="alert">{error}</p>}

        <div className="modal__actions">
          <button className="pill-btn pill-btn--outline" onClick={cerrar} disabled={busy}>
            {tc('cancel')}
          </button>
          <button
            className={danger ? 'pill-btn pill-btn--primary is-danger' : 'pill-btn pill-btn--primary'}
            disabled={!canConfirm}
            onClick={() => onConfirm(password)}
          >
            {busy ? (busyLabel || t('processing')) : (confirmLabel || tc('confirm'))}
          </button>
        </div>
      </div>
    </div>
  );
}
