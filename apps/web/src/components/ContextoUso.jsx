// El anillo del cuadro de mensaje: cuánto del cupo semanal se ha usado, con
// el color según ese porcentaje (verde, ámbar, rojo). Al pulsarlo se abre,
// ahí mismo, el detalle: contexto de la conversación, sesión y semana (lo
// mismo que Ajustes › Uso, sin salir del chat).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useDismiss } from '../hooks/useDismiss';
import { useT } from '../i18n/useT';
import { cuando } from '../lib/cuando';
import { useAuth } from '../hooks/useAuth';

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
// Verde hasta la mitad, ámbar hasta el 80 % y rojo desde ahí.
export const tonoUso = (frac) => (frac >= 0.8 ? 'is-danger' : frac >= 0.5 ? 'is-warn' : 'is-ok');
export const fraccionDe = (bucket) => {
  if (!bucket || bucket.unlimited) return 0;
  const pct = bucket.percent ?? (bucket.limit ? (bucket.used / bucket.limit) * 100 : 0);
  return Math.min(1, Math.max(0, pct / 100));
};

function Barra({ titulo, valor, frac, pie }) {
  return (
    <div className="ctx-pop__fila">
      <div className="ctx-pop__cab">
        <span>{titulo}</span>
        <span className="ctx-pop__valor">{valor}</span>
      </div>
      <div className={`ctx-pop__barra ${tonoUso(frac)}`}><span style={{ width: `${Math.round(frac * 100)}%` }} /></div>
      {pie && <p className="ctx-pop__pie">{pie}</p>}
    </div>
  );
}

function Cupo({ titulo, bucket, t, idioma }) {
  if (!bucket) return null;
  if (bucket.unlimited) return <Barra titulo={titulo} valor={t('usageUnlimited')} frac={0} />;
  const frac = fraccionDe(bucket);
  const pie = bucket.reset_at ? t('quotaResets', { when: cuando(bucket.reset_at, idioma) }) : t('usageNotStarted');
  return <Barra titulo={titulo} valor={`${Math.round(frac * 100)}%`} frac={frac} pie={pie} />;
}

export function ContextoUso({ uso }) {
  const t = useT('chat');
  const { user } = useAuth();
  const [abierto, setAbierto] = useState(false);
  const [cupos, setCupos] = useState(undefined); // undefined: sin pedir; null: no disponible
  const raiz = useRef(null);
  const cerrar = useCallback(() => setAbierto(false), []);
  useDismiss(abierto, raiz, cerrar);

  // El cupo cambia con cada respuesta: se vuelve a pedir cuando cambia el
  // contexto usado (llega al terminar cada mensaje) y al abrir el detalle.
  const pedir = useCallback(() => {
    if (!user) { setCupos(null); return; }
    api.get('/api/account/usage')
      .then((res) => setCupos(res.data.buckets || null))
      .catch(() => setCupos(null));
  }, [user]);
  useEffect(() => { pedir(); }, [pedir, uso?.used]);

  const semana = cupos?.week;
  if (!semana && !uso) return null;
  const frac = fraccionDe(semana);
  const pct = Math.round(frac * 100);
  const r = 6.5;
  const circ = 2 * Math.PI * r;
  const idioma = document.documentElement.lang || 'es';
  const totalCtx = uso ? uso.total || 4096 : 0;
  const fracCtx = uso ? Math.min(1, uso.used / totalCtx) : 0;

  const alternar = () => {
    setAbierto((v) => !v);
    pedir();
  };

  return (
    <div className="ctx-uso" ref={raiz}>
      <button
        type="button"
        className={`chat-input__ctx ${semana ? tonoUso(frac) : ''} ${abierto ? 'is-open' : ''}`}
        onClick={alternar}
        aria-expanded={abierto}
        aria-label={t('weekUsedAria', { pct })}
        title={t('weekUsedAria', { pct })}
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
        <span className="chat-input__ctx-pct">{semana?.unlimited ? '∞' : `${pct}%`}</span>
      </button>
      {abierto && (
        <div className="ctx-pop" role="dialog" aria-label={t('usagePanelTitle')}>
          {cupos === undefined && <p className="ctx-pop__pie">{t('usageLoading')}</p>}
          {cupos && (
            <>
              <Cupo titulo={t('usageWeek')} bucket={cupos.week} t={t} idioma={idioma} />
              <Cupo titulo={t('usageSession')} bucket={cupos.session} t={t} idioma={idioma} />
            </>
          )}
          {uso && (
            <Barra
              titulo={t('usageContext')}
              valor={`${Math.round(fracCtx * 100)}%`}
              frac={fracCtx}
              pie={t('usageContextHint', { used: k(uso.used), total: k(totalCtx) }) + (uso.estimado ? t('estimatedSuffix') : '')}
            />
          )}
        </div>
      )}
    </div>
  );
}
