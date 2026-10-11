import { ATTENTION } from './attention';
import './attention.css';

const TITLES = {
  [ATTENTION.approveInTerminal]: 'Aprobar en la terminal',
  [ATTENTION.integrate]: 'Lista para integrar',
  [ATTENTION.review]: 'Revisar diff',
  [ATTENTION.failed]: 'Falló',
};

export function AttentionList({ items, selected, onSelect }) {
  if (!items.length) return null;
  return (
    <section className="attn" aria-label="Requiere tu atención">
      <div className="attn__head">Requiere tu atención <span className="attn__count">{items.length}</span></div>
      {items.map(({ task, kind, hint }) => (
        <button key={task.id} type="button" data-testid={`attention-${task.id}`} className={`attn__item attn__item--${kind} ${selected === task.id ? 'is-active' : ''}`} onClick={() => onSelect(task.id, kind)}>
          <span className="attn__title">{TITLES[kind]} · {task.title || task.id}</span>
          <span className="attn__meta">{hint}</span>
        </button>
      ))}
    </section>
  );
}
