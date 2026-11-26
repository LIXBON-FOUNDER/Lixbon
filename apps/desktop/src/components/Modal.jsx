// Modal.jsx — ventana flotante sobre el área de trabajo.
// Ajustes y Consumo NO son documentos: abrirlos en el centro echaba al usuario
// del editor. Aquí se superponen y al cerrarlos el código sigue donde estaba.
import { useEffect, useRef } from 'react';
import { IconX } from './Icons';

export function Modal({ title, subtitle, onClose, size = 'md', children, footer }) {
  const dialogRef = useRef(null);
  const returnFocus = useRef(typeof document === 'undefined' ? null : document.activeElement);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const focusable = () => [...(dialogRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') || [])].filter((element) => element.getClientRects().length > 0);
    if (!dialogRef.current?.contains(document.activeElement)) focusable()[0]?.focus();
    const onKey = (e) => {
      const dialogs = document.querySelectorAll('.modal[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== dialogRef.current) return;
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); }
      if (e.key === 'Tab') {
        const elements = focusable();
        if (!elements.length) { e.preventDefault(); return; }
        const first = elements[0], last = elements[elements.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); if (returnFocus.current?.isConnected) returnFocus.current.focus(); };
  }, []);

  return (
    <div
      className="modal__overlay"
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div ref={dialogRef} className={`modal modal--${size}`} role="dialog" aria-modal="true" aria-label={title}>
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
        {footer && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>
  );
}
