// El anillo del cuadro de mensaje: cuánto del cupo semanal se ha usado, con
// el color según ese porcentaje (verde, ámbar, rojo). Al pulsarlo se abre,
// ahí mismo, el detalle: contexto de la conversación, sesión y semana (lo
// mismo que Ajustes › Uso, sin salir del chat).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useDismiss } from '../hooks/useDismiss';
import { useSalida } from '../hooks/useSalida';
import { useT } from '../i18n/useT';
import { cuando } from '../lib/cuando';
import { useAuth } from '../hooks/useAuth';
import '../styles/contexto.css';

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
// Verde hasta la mitad, ámbar hasta el 80 % y rojo desde ahí.
export const tonoUso = (frac) => (frac >= 0.8 ? 'is-danger' : frac >= 0.5 ? 'is-warn' : 'is-ok');
export const fraccionDe = (bucket) => {
  if (!bucket || bucket.unlimited) return 0;
  const pct = bucket.percent ?? (bucket.limit ? (bucket.used / bucket.limit) * 100 : 0);
  return Math.min(1, Math.max(0, pct / 100));
};

// Barra de muescas: el cupo en N rayitas finas, encendidas hasta el uso. Va
// con el dibujo de píxeles de la portada y se lee mejor que una barra lisa.
const MUESCAS = 40;
export function Muescas({ frac }) {
  const llenas = Math.round(frac * MUESCAS);
  return (
    <div className={`ctx-muescas ${tonoUso(frac)}`} aria-hidden="true">
      {Array.from({ length: MUESCAS }, (_, i) => <span key={i} className={i < llenas ? 'is-on' : ''} style={{ '--i': i * 12 }} />)}
    </div>
  );
}

// Ritmo de la semana: si sigue gastando como hasta ahora, cuánto llevará al
// reiniciarse. La ventana semanal dura 7 días; el primer día no se proyecta (con tan pocos datos el ritmo exagera).
const SEMANA_MS = 7 * 24 * 3600 * 1000;
export function ritmoSemana(bucket, ahora = Date.now()) {
  if (!bucket || bucket.unlimited || !bucket.reset_at) return null;
  const transcurrido = SEMANA_MS - (new Date(bucket.reset_at).getTime() - ahora);
  if (!(transcurrido >= 24 * 3600 * 1000) || transcurrido > SEMANA_MS) return null;
  return fraccionDe(bucket) * (SEMANA_MS / transcurrido);
}

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

// Sesión y semana: el porcentaje junto al nombre y, a la derecha, cuándo
// se reinicia.
function Cupo({ titulo, bucket, t, tu, idioma }) {
  if (!bucket) return null;
  if (bucket.unlimited) return <Barra titulo={titulo} valor={t('usageUnlimited')} frac={0} />;
  const frac = fraccionDe(bucket);
  return (
    <div className="ctx-pop__fila">
      <div className="ctx-pop__cab">
        <span>{titulo} <b className="ctx-pop__valor">{Math.round(frac * 100)}%</b></span>
        <span className="ctx-pop__dato">
          {bucket.reset_at ? tu('resetsIn', { when: cuando(bucket.reset_at, idioma) }) : t('usageNotStarted')}
        </span>
      </div>
      <Muescas frac={frac} />
    </div>
  );
}

const PARTES = [
  { id: 'system', clave: 'ctxSystem' },
  { id: 'tools', clave: 'ctxTools' },
  { id: 'summary', clave: 'ctxSummary' },
  { id: 'messages', clave: 'ctxMessages' },
];

/** Contexto de la conversación: cuánto ocupa y en qué (sistema, herramientas,
 *  mensajes), como una barra por tramos. El reparto lo estima el gateway y
 *  suma exactamente el recuento real del modelo. */
function Contexto({ uso, tu }) {
  const total = uso.total || 4096;
  const usado = Math.min(uso.used, total);
  const partes = uso.breakdown
    ? PARTES.map((p) => ({ ...p, n: uso.breakdown[p.id] || 0 })).filter((p) => p.n > 0)
    : [{ id: 'messages', clave: 'ctxMessages', n: usado }];
  // La respuesta también ocupa ventana: va con los mensajes.
  const suma = partes.reduce((a, p) => a + p.n, 0);
  if (suma < usado) partes[partes.length - 1].n += usado - suma;
  const libre = Math.max(0, total - usado);
  const pct = Math.round((usado / total) * 100);
  return (
    <section className="ctx-pop__bloque">
      <div className="ctx-pop__cab">
        <span>{tu('ctxTitle')} <b className="ctx-pop__valor">{pct}%</b></span>
        <span className="ctx-pop__dato">{tu('ctxOf', { used: k(usado), total: k(total) })}</span>
      </div>
      <div className="ctx-tramos" aria-hidden="true">
        {partes.map((p) => <span key={p.id} className={`is-${p.id}`} style={{ flexGrow: p.n }} />)}
        <span className="is-free" style={{ flexGrow: libre }} />
      </div>
      <dl className="ctx-leyenda">
        {[...partes, { id: 'free', clave: 'ctxFree', n: libre }].map((p) => (
          <div key={p.id}>
            <dt><i className={`is-${p.id}`} />{tu(p.clave)}</dt>
            <dd>{k(p.n)}</dd>
          </div>
        ))}
      </dl>
      {uso.estimado && <p className="ctx-pop__pie">{tu('ctxEstimated')}</p>}
    </section>
  );
}

/** Tokens de la última respuesta: entrada (con la parte en caché) y salida,
 *  como un resumen de pedido: concepto a la izquierda, cifra a la derecha y
 *  una sola línea antes del total. Con herramientas, todos los pasos. */
function UltimaRespuesta({ turno, tu }) {
  const nueva = Math.max(0, turno.input - turno.cached);
  return (
    <section className="ctx-pop__bloque">
      <h3 className="ctx-pop__etq">{turno.steps > 1 ? tu('lastReplySteps', { n: turno.steps }) : tu('lastReply')}</h3>
      <dl className="ctx-tokens">
        <div><dt>{tu('tokIn')}</dt><dd>{k(nueva)}</dd></div>
        <div><dt>{tu('tokCached')}</dt><dd>{k(turno.cached)}</dd></div>
        <div><dt>{tu('tokOut')}</dt><dd>{k(turno.output)}</dd></div>
        <div className="is-total"><dt>{tu('tokTotal')}</dt><dd>{k(turno.input + turno.output)}</dd></div>
      </dl>
      {turno.cached > 0 && <p className="ctx-pop__pie">{tu('cachedHint')}</p>}
    </section>
  );
}

export function ContextoUso({ uso }) {
  const t = useT('chat');
  const tu = useT('cupo');
  const { user } = useAuth();
  const [abierto, setAbierto] = useState(false);
  const [cupos, setCupos] = useState(undefined); // undefined: sin pedir; null: no disponible
  const raiz = useRef(null);
  const cerrar = useCallback(() => setAbierto(false), []);
  useDismiss(abierto, raiz, cerrar);
  const salida = useSalida(abierto, 140);

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
  // Sin sesión no hay cupo que mostrar; con sesión el anillo está siempre,
  // en 0 % mientras llega el dato.
  if (!user && !uso) return null;
  const frac = fraccionDe(semana);
  const pct = Math.round(frac * 100);
  const ritmo = ritmoSemana(semana);
  const r = 10;
  const circ = 2 * Math.PI * r;
  const idioma = document.documentElement.lang || 'es';
  const totalCtx = uso ? uso.total || 4096 : 0;

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
        {/* Sin cifra: el número está en el detalle, al pulsar. */}
        <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
          <circle cx="13" cy="13" r={r} className="chat-input__ctx-fondo" />
          <circle
            cx="13" cy="13" r={r}
            className="chat-input__ctx-uso"
            strokeDasharray={circ}
            strokeDashoffset={circ * (1 - frac)}
            transform="rotate(-90 13 13)"
          />
        </svg>
      </button>
      {salida.montado && (
        <div className={`ctx-pop ${salida.cerrando ? 'is-cerrando' : ''}`} role="dialog" aria-label={t('usagePanelTitle')}>
          {/* Cabecera: la cifra que resume el anillo, grande, y cuándo se
              reinicia en gris. Debajo, cada parte en su bloque de otro tono. */}
          <header className="ctx-pop__resumen">
            <span className="ctx-pop__etq">{tu('weekUsage')}</span>
            <div className="ctx-pop__grande">
              <strong>{semana?.unlimited ? t('usageUnlimited') : `${pct}%`}</strong>
              <span className="ctx-pop__dato">
                {cupos === undefined ? t('usageLoading')
                  : semana?.reset_at ? tu('resetsIn', { when: cuando(semana.reset_at, idioma) }) : ''}
              </span>
            </div>
            {semana && !semana.unlimited && <Muescas frac={frac} />}
            {ritmo !== null && (
              <p className={`ctx-pop__ritmo ${tonoUso(Math.min(1, ritmo))}`}>
                {ritmo >= 1 ? tu('paceOver') : tu('paceAt', { pct: Math.round(ritmo * 100) })}
              </p>
            )}
          </header>
          {uso && <Contexto uso={{ ...uso, total: totalCtx }} tu={tu} />}
          {uso?.turno && <UltimaRespuesta turno={uso.turno} tu={tu} />}
          {cupos?.session && (
            <section className="ctx-pop__bloque">
              <Cupo titulo={tu('session')} bucket={cupos.session} t={t} tu={tu} idioma={idioma} />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
