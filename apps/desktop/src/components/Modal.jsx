// Modal.jsx — ventana flotante sobre el área de trabajo.
// Ajustes y Consumo NO son documentos: abrirlos en el centro echaba al usuario
// del editor. Aquí se superponen y al cerrarlos el código sigue donde estaba.
import { useEffect } from 'react';
import { IconX } from './Icons';

export function Modal({ title, subtitle, onClose, size = 'md', children }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal__overlay"
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={`modal modal--${size}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal__head">
          <div className="modal__titles">
            <h2 className="modal__title">{title}</h2>
            {subtitle && <p className="modal__subtitle">{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} title="Cerrar (Esc)">
            <IconX size={16} />
          </button>
        </header>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
}
