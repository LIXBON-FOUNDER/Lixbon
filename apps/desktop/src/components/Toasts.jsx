import { useToastStore } from '../store/toastStore';
import { IconX } from './Icons';

export function Toasts() {
  const { toasts, dismiss } = useToastStore();
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.tone}`}>
          <span className="toast__text">{t.text}</span>
          {t.action && (
            <button className="toast__action" onClick={() => { t.action.run(); dismiss(t.id); }}>{t.action.label}</button>
          )}
          <button className="ic toast__x" onClick={() => dismiss(t.id)} title="Cerrar"><IconX size={12} /></button>
        </div>
      ))}
    </div>
  );
}
