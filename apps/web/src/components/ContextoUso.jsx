// El anillo del cuadro de mensaje: cuánto contexto lleva la conversación. Al
// pulsarlo se abre, ahí mismo, el detalle del contexto y del cupo de la sesión
// y de la semana (lo mismo que Ajustes › Uso, sin salir del chat).
import { useCallback, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useDismiss } from '../hooks/useDismiss';
import { useT } from '../i18n/useT';
import { cuando } from '../lib/cuando';

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const tonoDe = (frac) => (frac >= 0.9 ? 'is-danger' : frac >= 0.75 ? 'is-warn' : '');

function Barra({ titulo, valor, frac, pie }) {
  return (
    <div className="ctx-pop__fila">
      <div className="ctx-pop__cab">
        <span>{titulo}</span>
        <span className="ctx-pop__valor">{valor}</span>
      </div>
      <div className={`ctx-pop__barra ${tonoDe(frac)}`}><span style={{ width: `${Math.round(frac * 100)}%` }} /></div>
      {pie && <p className="ctx-pop__pie">{pie}</p>}
    </div>
  );
}

function Cupo({ titulo, bucket, t, idioma }) {
  if (!bucket) return null;
  if (bucket.unlimited) return <Barra titulo={titulo} valor={t('usageUnlimited')} frac={0} />;
  const frac = Math.min(1, (bucket.percent ?? (bucket.limit ? (bucket.used / bucket.limit) * 100 : 0)) / 100);
  const pie = bucket.reset_at ? t('quotaResets', { when: cuando(bucket.reset_at, idioma) }) : t('usageNotStarted');
  return <Barra titulo={titulo} valor={`${Math.round(frac * 100)}%`} frac={frac} pie={pie} />;
}

export function ContextoUso({ uso }) {
  const t = useT('chat');
  const [abierto, setAbierto] = useState(false);
  const [cupos, setCupos] = useState(undefined); // undefined: sin pedir; null: no disponible
  const raiz = useRef(null);
  const cerrar = useCallback(() => setAbierto(false), []);
  useDismiss(abierto, raiz, cerrar);

  if (!uso) return null;
  const total = uso.total || 4096;
  const frac = Math.min(1, uso.used / total);
  const pct = Math.round(frac * 100);
  const r = 6.5;
  const circ = 2 * Math.PI * r;
  const idioma = document.documentElement.lang || 'es';

  const alternar = () => {
    setAbierto((v) => !v);
    // Se pide cada vez que se abre: el cupo cambia con cada respuesta.
    api.get('/api/account/usage')
      .then((res) => setCupos(res.data.buckets || null))
      .catch(() => setCupos(null));
  };

  return (
    <div className="ctx-uso" ref={raiz}>
      <button
        type="button"
        className={`chat-input__ctx ${tonoDe(frac)} ${abierto ? 'is-open' : ''}`}
        onClick={alternar}
        aria-expanded={abierto}
        aria-label={t('contextUsedAria')}
        title={t('contextUsedTitle', { used: k(uso.used), total: k(total), pct }) + (uso.estimado ? t('estimatedSuffix') : '')}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r={r} className="chat-input__ctx-fondo" />
          <circle
            cx="8" cy="8" r={r}
            className="chat-input__ctx-uso"
            strokeDasharray={circ}
            strokeDashoffset={circ * (1 - frac)}
            transform="rotate(-90 8 8)"
          />
        </svg>
        <span className="chat-input__ctx-pct">{pct}%</span>
      </button>
      {abierto && (
        <div className="ctx-pop" role="dialog" aria-label={t('usagePanelTitle')}>
          <Barra
            titulo={t('usageContext')}
            valor={`${pct}%`}
            frac={frac}
            pie={t('usageContextHint', { used: k(uso.used), total: k(total) }) + (uso.estimado ? t('estimatedSuffix') : '')}
          />
          {cupos === undefined && <p className="ctx-pop__pie">{t('usageLoading')}</p>}
          {cupos && (
            <>
              <Cupo titulo={t('usageSession')} bucket={cupos.session} t={t} idioma={idioma} />
              <Cupo titulo={t('usageWeek')} bucket={cupos.week} t={t} idioma={idioma} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
