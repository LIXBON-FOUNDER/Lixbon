// Cupo del chat: la tarjeta que sustituye a la respuesta cuando el cupo se
// agota (en vez de un error rojo) y la memoria de los avisos «cerca del
// límite» que el usuario ya cerró, para no repetirle el mismo escalón.
import { useT } from '../i18n/useT';
import { Link } from '../i18n/link';
import { useAuth } from '../hooks/useAuth';
import { cuando } from '../lib/cuando';
import { Icono } from './Icons';
import '../styles/cupo.css';

const CLAVE_CERRADOS = 'lixbon.cupo.cerrados';

function claveDe(aviso) {
  return `${aviso.scope}:${aviso.level ?? Math.floor(aviso.percent || 0)}:${aviso.reset_at || ''}`;
}

/** true si el usuario ya cerró este mismo escalón de este mismo ciclo. */
export function avisoCerrado(aviso) {
  if (!aviso || aviso.state === 'exhausted') return false;
  try {
    return (JSON.parse(localStorage.getItem(CLAVE_CERRADOS) || '[]')).includes(claveDe(aviso));
  } catch { return false; }
}

export function recordarAvisoCerrado(aviso) {
  if (!aviso || aviso.state === 'exhausted') return;
  try {
    const lista = JSON.parse(localStorage.getItem(CLAVE_CERRADOS) || '[]');
    // Solo hacen falta los últimos: cada ciclo trae claves nuevas.
    localStorage.setItem(CLAVE_CERRADOS, JSON.stringify([...lista.filter((k) => k !== claveDe(aviso)), claveDe(aviso)].slice(-12)));
  } catch { /* sin almacenamiento */ }
}

function cuandoVuelve(t, resetAt, idioma) {
  if (!resetAt) return '';
  const fecha = new Date(resetAt);
  const hoyOMañana = fecha - Date.now() < 36 * 3600 * 1000;
  return hoyOMañana
    ? t('resets', { when: cuando(resetAt, idioma), hora: fecha.toLocaleTimeString(idioma, { hour: '2-digit', minute: '2-digit' }) })
    : t('resetsDay', { when: cuando(resetAt, idioma), dia: fecha.toLocaleDateString(idioma, { weekday: 'long', day: 'numeric', month: 'long' }) });
}

/** En el hilo, en lugar de la respuesta que no se pudo generar: tintado de
 *  ámbar, con la barra llena por segmentos, cuándo se renueva y las salidas. */
export function CupoAgotado({ aviso }) {
  const t = useT('cupo');
  const { user } = useAuth();
  const idioma = document.documentElement.lang || 'es';
  const semana = aviso.scope === 'week';
  const plan = user?.plan_name || t('planFallback');
  const falta = aviso.reset_at ? Math.max(0, new Date(aviso.reset_at) - Date.now()) : 0;
  const dias = Math.floor(falta / 86400000);
  const horas = Math.floor((falta % 86400000) / 3600000);
  return (
    <div className="cupo-lleno" role="status">
      <div className="cupo-lleno__fila">
        <span className="aviso__ico"><Icono nombre="uso" size={20} /></span>
        <div className="aviso__t">
          <strong>{semana ? t('weekTitle') : t('sessionTitle')}</strong>
          <span>{semana ? t('weekText', { plan }) : t('sessionText', { plan })} {cuandoVuelve(t, aviso.reset_at, idioma)}</span>
        </div>
      </div>
      <div className="cupo-lleno__barra" aria-hidden="true">{Array.from({ length: 20 }, (_, k) => <i key={k} />)}</div>
      <div className="cupo-lleno__datos">
        <span>{t('usedLabel')} <b>100 %</b></span>
        {falta > 0 && <span>{t('renewsIn')} <b>{dias ? t('daysHours', { d: dias, h: horas }) : t('hoursOnly', { h: Math.max(1, horas) })}</b></span>}
      </div>
      <div className="cupo-lleno__acc">
        <Link to="/plans" className="pill-btn pill-btn--marca">{t('upgradePlan')}</Link>
        <Link to="/account/usage" className="pill-btn pill-btn--outline">{t('seeUsage')}</Link>
      </div>
    </div>
  );
}
