// Mapa del hilo: en lugar de barra de desplazamiento, un punto por cada mensaje
// del usuario, a la derecha del chat. Al pasar el cursor el panel se ensancha
// y cada punto enseña el principio de su mensaje (10 caracteres); al pulsarlo,
// el hilo va a ese mensaje. El punto del mensaje que se está leyendo va
// encendido.
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n/useT';

const MAX_LETRAS = 10;

const recorte = (texto) => {
  const limpio = String(texto || '').replace(/\s+/g, ' ').trim();
  return limpio.length > MAX_LETRAS ? `${limpio.slice(0, MAX_LETRAS)}…` : limpio;
};

/** `mensajes`: [{ indice, texto }] de los mensajes del usuario, en orden. */
export function MapaMensajes({ scrollRef, mensajes }) {
  const t = useT('chat');
  const [actual, setActual] = useState(-1);

  const nodo = useCallback((indice) => scrollRef.current?.querySelector(`[data-msg-usuario="${indice}"]`), [scrollRef]);

  // Encendido: el último mensaje del usuario cuya parte de arriba ya pasó por
  // el tercio superior de la vista.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || mensajes.length < 2) return undefined;
    let marco = 0;
    const medir = () => {
      marco = 0;
      const corte = el.getBoundingClientRect().top + el.clientHeight / 3;
      let cual = 0;
      mensajes.forEach((m, k) => {
        const n = nodo(m.indice);
        if (n && n.getBoundingClientRect().top <= corte) cual = k;
      });
      setActual(cual);
    };
    const alMover = () => { if (!marco) marco = requestAnimationFrame(medir); };
    medir();
    el.addEventListener('scroll', alMover, { passive: true });
    return () => { el.removeEventListener('scroll', alMover); cancelAnimationFrame(marco); };
  }, [scrollRef, mensajes, nodo]);

  if (mensajes.length < 2) return null;

  const ir = (indice) => {
    const n = nodo(indice);
    const el = scrollRef.current;
    if (!n || !el) return;
    const quieto = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollTop + n.getBoundingClientRect().top - el.getBoundingClientRect().top - 24, behavior: quieto ? 'auto' : 'smooth' });
  };

  return (
    <nav className="mapa-msgs" aria-label={t('threadMapAria')} style={{ '--n': mensajes.length }}>
      {mensajes.map((m, k) => (
        <button
          key={m.indice}
          type="button"
          className={`mapa-msgs__punto ${k === actual ? 'is-actual' : ''}`}
          onClick={() => ir(m.indice)}
          aria-label={t('threadMapGo', { text: recorte(m.texto) })}
          aria-current={k === actual ? 'true' : undefined}
        >
          <span className="mapa-msgs__texto" aria-hidden="true">{recorte(m.texto)}</span>
          <span className="mapa-msgs__marca" aria-hidden="true" />
        </button>
      ))}
    </nav>
  );
}
