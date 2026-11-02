// Iconos de Lixbon (@lixbon/icons). Original único: shared/icons; no copiar en las apps.
//   <Icono nombre="chat" />            en línea
//   <Icono nombre="chat" relleno />    gemela rellena, para el ítem activo
// Rejilla 24, trazo 2. La línea toma currentColor; el relleno, --lx-relleno
// (#FFF en oscuro, #000 en claro). Los calados usan <mask>, así que cada
// instancia lleva ids propios (useId).
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import ICONOS from './iconos-datos.js';

export const NOMBRES = Object.keys(ICONOS);

export function Icono({ nombre, relleno = false, size = 18, className = '', ...props }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const icono = ICONOS[nombre];
  if (!icono) return null;
  const html = ((relleno && icono.relleno) || icono.linea).split('__ID__').join(uid);
  return (
    <svg
      className={`ico ${className}`.trim()}
      data-ico={nombre}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: html }}
      {...props}
    />
  );
}

// Interruptor: el estado apagado y el encendido van dentro del mismo botón; el
// botón lleva `ia ia-<interruptor>`, `on` y la clase de usePulso().
export function IconoDoble({ off, on, rellenoOn = false, size = 18 }) {
  return (
    <>
      <span className="v-off"><Icono nombre={off} size={size} /></span>
      <span className="v-on"><Icono nombre={on} relleno={rellenoOn} size={size} /></span>
    </>
  );
}

// Alterna p1/p2 en cada pulsación para que la animación vuelva a empezar.
export function usePulso() {
  const [n, setN] = useState(0);
  const pulsar = useCallback(() => setN((v) => v + 1), []);
  return [n === 0 ? '' : n % 2 ? 'p1' : 'p2', pulsar];
}

// Animación al pulsar en toda la web sin tocar cada botón: al pulsar un botón
// o enlace con un icono dentro, se le pone `ia ia-<id>` y p1/p2 alternadas.
// Se mueve el icono, no el botón. Los que llevan estado (menú, paneles,
// desplegables e interruptores) ya gestionan su clase `ia` a mano y se saltan.
const CON_ESTADO = new Set(['menu', 'abajo', 'panel', 'panel-der', 'panel-inf']);

export function instalarPulsos() {
  if (typeof document === 'undefined' || document.__lxPulsos) return;
  document.__lxPulsos = true;
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const el = e.target.closest?.('button, a, [role="button"], [role="tab"], [role="menuitem"], [role="option"]');
    if (!el || el.disabled || (el.classList.contains('ia') && !el.classList.contains('ia-auto'))) return;
    if (el.querySelector('.ia:not(.ia-auto)')) return; // lleva su propio interruptor
    const ico = el.querySelector('svg.ico[data-ico]');
    const id = ico?.dataset.ico;
    if (!id || CON_ESTADO.has(id)) return;
    const previo = el.dataset.iaPulso;
    if (previo && previo !== id) el.classList.remove(`ia-${previo}`);
    el.dataset.iaPulso = id;
    const n = el.classList.contains('p1') ? 'p2' : 'p1';
    el.classList.remove('p1', 'p2');
    el.classList.add('ia', 'ia-auto', `ia-${id}`, n);
  }, { passive: true, capture: true });
}

// Interruptor autónomo: el envoltorio lleva `ia ia-<tipo>` y `on`, y late al
// cambiar de estado (copiar → hecho, micrófono grabando, reproducir → pausa).
const INTERRUPTORES = {
  copiar: ['copiar', 'hecho', false],
  microfono: ['microfono', 'microfono', true],
  reproducir: ['reproducir', 'pausa', false],
  corazon: ['corazon', 'corazon', true],
  tema: ['claro', 'oscuro', false],
};

export function Interruptor({ tipo, on = false, size = 18, className = '' }) {
  const [off, encendido, rellenoOn] = INTERRUPTORES[tipo];
  const [pulso, pulsar] = usePulso();
  const previo = useRef(on);
  useEffect(() => {
    if (previo.current !== on) pulsar();
    previo.current = on;
  }, [on, pulsar]);
  return (
    <span className={`ia ia-${tipo} ${on ? 'on' : ''} ${pulso} ${className}`.replace(/\s+/g, ' ').trim()}>
      <IconoDoble off={off} on={encendido} rellenoOn={rellenoOn} size={size} />
    </span>
  );
}
