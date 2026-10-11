// Cuánto razona el modelo: deslizador con los niveles que admite (el gateway
// publica `reasoning: toggle|levels` en /v1/models). «Auto» deja que decida el
// gateway según el mensaje.
import { useEffect, useRef, useState } from 'react';
import { IconBolt, IconX } from './Icons';
import { useT } from '../i18n/useT';

const ETIQUETA = { auto: 'effortAuto', off: 'effortOff', on: 'effortOn', low: 'effortLow', medium: 'effortMedium', high: 'effortHigh' };

export function Razonamiento({ niveles, valor, onChange }) {
  const t = useT('chat');
  const [abierto, setAbierto] = useState(false);
  const raiz = useRef(null);

  useEffect(() => {
    if (!abierto) return undefined;
    const fuera = (e) => { if (!raiz.current?.contains(e.target)) setAbierto(false); };
    const esc = (e) => { if (e.key === 'Escape') setAbierto(false); };
    document.addEventListener('pointerdown', fuera, true);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', fuera, true);
      document.removeEventListener('keydown', esc);
    };
  }, [abierto]);

  if (niveles.length === 0) return null;
  const actual = niveles.includes(valor) ? valor : 'auto';
  const indice = niveles.indexOf(actual);

  return (
    <div className="razonar" ref={raiz}>
      <button
        type="button"
        className={`razonar__btn ${abierto ? 'is-open' : ''} ${actual !== 'auto' && actual !== 'off' ? 'is-on' : ''}`}
        onClick={() => setAbierto((v) => !v)}
        title={t('effortTitle')}
        aria-expanded={abierto}
      >
        <IconBolt size={14} />
        <span>{t(ETIQUETA[actual])}</span>
      </button>
      {abierto && (
        <div className="razonar__pop" role="dialog" aria-label={t('effortTitle')}>
          <div className="razonar__cab">
            <span>{t('effortTitle')}</span>
            <span className="razonar__valor">{t(ETIQUETA[actual])}</span>
          </div>
          <input
            type="range"
            className="razonar__rango"
            min={0}
            max={niveles.length - 1}
            step={1}
            value={indice}
            onChange={(e) => onChange(niveles[Number(e.target.value)])}
            aria-valuetext={t(ETIQUETA[actual])}
          />
          <div className="razonar__marcas">
            {niveles.map((n) => (
              <button key={n} type="button" className={n === actual ? 'is-sel' : ''} onClick={() => onChange(n)}>
                {t(ETIQUETA[n])}
              </button>
            ))}
          </div>
          <p className="razonar__ayuda">{t(actual === 'auto' ? 'effortAutoHint' : 'effortManualHint')}</p>
        </div>
      )}
    </div>
  );
}

function cuando(resetAt, idioma) {
  if (!resetAt) return '';
  const min = Math.max(1, Math.round((new Date(resetAt) - Date.now()) / 60000));
  const rtf = new Intl.RelativeTimeFormat(idioma, { numeric: 'auto' });
  if (min < 60) return rtf.format(min, 'minute');
  if (min < 48 * 60) return rtf.format(Math.round(min / 60), 'hour');
  return rtf.format(Math.round(min / 1440), 'day');
}

export function AvisoCuota({ aviso, onCerrar }) {
  const t = useT('chat');
  if (!aviso) return null;
  const idioma = document.documentElement.lang || 'es';
  const ambito = t(aviso.scope === 'week' ? 'quotaWeek' : 'quotaSession');
  const reinicio = aviso.reset_at ? ` ${t('quotaResets', { when: cuando(aviso.reset_at, idioma) })}` : '';
  const texto = aviso.state === 'exhausted'
    ? t('quotaExhausted', { scope: ambito }) + reinicio
    : t('quotaNear', { pct: Math.round(aviso.percent || 0), scope: ambito }) + reinicio;
  return (
    <div className={`aviso-cuota ${aviso.state === 'exhausted' ? 'is-agotado' : ''}`} role="status">
      <span>{texto}</span>
      <button type="button" className="aviso-cuota__x" onClick={onCerrar} aria-label={t('quotaDismiss')}>
        <IconX size={13} />
      </button>
    </div>
  );
}
