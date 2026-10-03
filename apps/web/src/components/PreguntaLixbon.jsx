// PreguntaLixbon.jsx — tarjeta "pregúntale a lixbon" al final de la FAQ de la
// portada. En reposo mide lo mismo que una pregunta; al preguntar crece hasta
// ocupar el sitio de las preguntas genéricas (la caja de la FAQ conserva su
// alto, así que nada de lo que hay debajo se mueve).
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useLocale } from '../i18n/LocaleContext';
import { useT } from '../i18n/useT';
import { IconSend, IconX } from './Icons';

const MAX_PREGUNTA = 300;
const HISTORIAL = 6;
const reducirMovimiento = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function Escribiendo({ texto }) {
  const [visibles, setVisibles] = useState(() => (reducirMovimiento() ? texto.length : 0));
  useEffect(() => {
    if (visibles >= texto.length) return undefined;
    const id = setTimeout(() => setVisibles((n) => Math.min(texto.length, n + 3)), 14);
    return () => clearTimeout(id);
  }, [visibles, texto]);
  return texto.slice(0, visibles);
}

export function PreguntaLixbon({ abierta, onAbrir, onCerrar }) {
  const locale = useLocale();
  const t = useT('landing');
  const [texto, setTexto] = useState('');
  const [turnos, setTurnos] = useState([]);
  const [cargando, setCargando] = useState(false);
  const inputRef = useRef(null);
  const registroRef = useRef(null);

  useEffect(() => {
    const el = registroRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reducirMovimiento() ? 'auto' : 'smooth' });
  }, [turnos, cargando]);

  const cerrar = () => {
    onCerrar();
    setTexto('');
  };

  const enviar = async (e) => {
    e.preventDefault();
    const pregunta = texto.trim();
    if (!pregunta || cargando) return;
    onAbrir();
    const previos = turnos.filter((m) => !m.error).slice(-HISTORIAL);
    setTurnos([...turnos, { role: 'user', content: pregunta }]);
    setTexto('');
    setCargando(true);
    try {
      const { data } = await api.post('/api/ask', {
        locale,
        messages: [...previos, { role: 'user', content: pregunta }].map(({ role, content }) => ({ role, content })),
      });
      setTurnos((m) => [...m, { role: 'assistant', content: data.answer, nuevo: true }]);
    } catch (err) {
      const detalle = err.response?.data?.detail;
      setTurnos((m) => [...m, { role: 'assistant', content: typeof detalle === 'string' ? detalle : t('askError'), error: true }]);
    } finally {
      setCargando(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div
      className={`landing__ask ${abierta ? 'is-abierta' : ''}`}
      onKeyDown={(e) => { if (e.key === 'Escape' && abierta) cerrar(); }}
    >
      <div className="landing__ask-panel" aria-hidden={!abierta}>
        <div className="landing__ask-cab">
          <span>{t('askTitle')}</span>
          <button type="button" className="landing__ask-cerrar" onClick={cerrar} aria-label={t('askClose')} tabIndex={abierta ? 0 : -1}>
            <IconX size={16} />
          </button>
        </div>
        <div className="landing__ask-registro" ref={registroRef} aria-live="polite">
          {turnos.map((m, i) => (
            <p key={i} className={`landing__ask-msg landing__ask-msg--${m.role} ${m.error ? 'is-error' : ''}`}>
              {m.nuevo && i === turnos.length - 1 ? <Escribiendo texto={m.content} /> : m.content}
            </p>
          ))}
          {cargando && <span className="landing__ask-puntos" aria-label={t('askThinking')}><i /><i /><i /></span>}
        </div>
      </div>
      <form className="landing__ask-form" onSubmit={enviar}>
        <input
          ref={inputRef}
          value={texto}
          maxLength={MAX_PREGUNTA}
          placeholder={t('askPlaceholder')}
          aria-label={t('askPlaceholder')}
          onChange={(e) => setTexto(e.target.value)}
          autoComplete="off"
        />
        <button type="submit" className="landing__ask-enviar" disabled={!texto.trim() || cargando} aria-label={t('askSend')}>
          <IconSend size={16} />
        </button>
      </form>
    </div>
  );
}
