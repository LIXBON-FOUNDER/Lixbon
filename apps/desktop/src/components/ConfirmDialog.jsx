// ConfirmDialog.jsx — UI del diálogo de lib/confirm.js: overlay centrado con
// mensaje, campo de texto opcional y hasta 3 botones. Escape o clic fuera
// resuelven 'cancel'; Enter pulsa la opción primaria.
import { useEffect, useRef, useState } from 'react';
import { useConfirmStore, resolveConfirm } from '../lib/confirm';

export function ConfirmDialog() {
  const dialog = useConfirmStore((s) => s.dialog);
  const [text, setText] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (!dialog) return undefined;
    setText(dialog.input?.value ?? '');
    // Enfocar el input (si hay) o nada; Escape cancela siempre.
    const t = setTimeout(() => inputRef.current?.select(), 0);
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        resolveConfirm('cancel');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [dialog]);

  if (!dialog) return null;

  const primary = dialog.options.find((o) => o.kind === 'primary');
  const submit = () => primary && resolveConfirm(primary.id, dialog.input ? text : null);

  return (
    <div className="confirm__overlay" onMouseDown={() => resolveConfirm('cancel')}>
      <div
        className="confirm"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="confirm__title">{dialog.title}</div>
        <div className="confirm__message">{dialog.message}</div>
        {dialog.input && (
          <input
            ref={inputRef}
            className="confirm__input"
            value={text}
            placeholder={dialog.input.placeholder || ''}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
          />
        )}
        <div className="confirm__actions">
          {dialog.options.map((o) => (
            <button
              key={o.id}
              className={`confirm__btn ${o.kind ? `confirm__btn--${o.kind}` : ''}`}
              onClick={() => resolveConfirm(o.id, dialog.input ? text : null)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
