// Mientras se genera una imagen: un lienzo con la proporción pedida, una
// trama que se retira de arriba abajo sobre una mancha de color que se va
// aclarando, la fase en palabras y el porcentaje con su barra.
// El gateway responde de una vez (sin pasos intermedios), así que el
// porcentaje se estima con lo que suelen tardar las imágenes de este usuario
// y nunca pasa del 95 % hasta que llega la imagen.
import { useEffect, useState } from 'react';
import { Icono } from './Icons';
import { useT } from '../i18n/useT';

const CLAVE = 'lixbon.imagen.duracion';
const POR_DEFECTO = 25000;

function duracionEsperada() {
  try { return Number(localStorage.getItem(CLAVE)) || POR_DEFECTO; } catch { return POR_DEFECTO; }
}

/** Guarda cuánto tardó la última imagen (media móvil) para la próxima estimación. */
export function anotarDuracionImagen(ms) {
  if (!(ms > 2000 && ms < 600000)) return;
  try { localStorage.setItem(CLAVE, String(Math.round(duracionEsperada() * 0.6 + ms * 0.4))); } catch { /* sin almacenamiento */ }
}

const FASES = ['imgPhase1', 'imgPhase2', 'imgPhase3', 'imgPhase4'];

export function GenerandoImagen({ inicio, ancho = 1, alto = 1, onDetener }) {
  const t = useT('visuals');
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setAhora(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const total = duracionEsperada();
  const pct = Math.min(95, Math.round(((ahora - (inicio || ahora)) / total) * 95));
  const fase = FASES[Math.min(3, Math.floor(pct / 25))];
  const quedan = Math.max(1, Math.round((total - (ahora - inicio)) / 1000));
  return (
    <div className="gen-img" role="status" aria-live="polite" style={{ '--p': `${pct}%`, '--ratio': `${ancho} / ${alto}` }}>
      <div className="gen-img__lienzo">
        <div className="gen-img__mancha" style={{ filter: `blur(${Math.round(28 - pct * 0.24)}px)`, opacity: 0.35 + pct / 160 }} />
        <div className="gen-img__trama" style={{ '--retira': `${pct}%` }} />
        <div className="gen-img__chapa">
          <Icono nombre="visuals" size={16} />
          <span>{t(fase)}</span>
          <b>{pct} %</b>
        </div>
      </div>
      <div className="gen-img__barra"><i /></div>
      <div className="gen-img__pie">
        <span>{pct < 95 ? t('imgSecondsLeft', { n: quedan }) : t('imgAlmost')}</span>
        {onDetener && <button type="button" className="pill-btn pill-btn--ghost pill-btn--chico" onClick={onDetener}>{t('imgStop')}</button>}
      </div>
    </div>
  );
}
