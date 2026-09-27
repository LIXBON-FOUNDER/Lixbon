import { useToastStore } from '../store/toastStore';
import { IconX } from './Icons';

/** Avisos abajo a la derecha. `children` va encima de los toasts (el aviso de
    actualización), en la misma pila para que no se tapen entre sí. */
export function Toasts({ children }) {
  const { toasts, dismiss } = useToastStore();
  if (!toasts.length && !children) return null;
  return (
    <div className="toasts" role="status">
      {children}
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
