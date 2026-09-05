// ConfirmDialog.jsx — modal de confirmación para acciones destructivas.
// Con requirePassword pide la contraseña (reautenticación) y la pasa a onConfirm.
import { useState } from 'react';
import { IconX } from './Icons';
import { useCierreAnimado } from '../hooks/useCierreAnimado';

export function ConfirmDialog({
  title,
  children,
  confirmLabel = 'Confirmar',
  busyLabel = 'Procesando…',
  requirePassword = false,
  error = '',
  busy = false,
  onConfirm,
  onClose,
}) {
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
          <button className="icon-btn" onClick={cerrar} aria-label="Cerrar" disabled={busy}>
            <IconX />
          </button>
        </div>

        <div className="card__muted modal__desc">{children}</div>

        {requirePassword && (
          <input
            type="password"
            className="set-input modal__password"
            placeholder="Tu contraseña"
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
            Cancelar
          </button>
          <button
            className="pill-btn pill-btn--primary is-danger"
            disabled={!canConfirm}
            onClick={() => onConfirm(password)}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
