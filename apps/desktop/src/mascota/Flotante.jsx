// Flotante.jsx — Gael o Leya sobre el escritorio. Dos momentos, que decide
// el IDE (chat/avisoFlotante.js):
//   · aviso: el agente terminó (o pide permiso) y estás en otra app.
//   · látigo: sigues fuera pasado el tiempo de Ajustes › Mascota.
// «Volver a lixbon» trae el IDE al frente; «En 10 min» lo pospone.
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { SpriteMascota } from '../components/Mascota';
import { useBocadillo, useCaminata } from '../components/mascotaVida';

function leer(texto) {
  try { return texto ? JSON.parse(texto) : null; } catch { return null; }
}

export function Flotante() {
  const [d, setD] = useState(null);
  const ref = useRef(null);
  const quieta = !!d?.reducir;
  const bocadillo = useBocadillo(quieta);
  // Entra caminando desde el borde derecho de la pantalla (la ventana está
  // pegada a él), solo la primera vez.
  const { estilo, caminando, haciaIzq } = useCaminata(ref, d ? 'entra' : null, 'der', quieta);

  useEffect(() => {
    invoke('mascota_datos').then((t) => setD(leer(t))).catch(() => {});
    let quitar;
    listen('mascota:datos', (e) => setD(leer(e.payload))).then((f) => { quitar = f; });
    return () => quitar?.();
  }, []);

  // Cada aviso nuevo se escribe en el bocadillo (cuando ya llegó).
  useEffect(() => {
    if (d && !caminando) bocadillo.decir(d.texto, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, caminando]);

  if (!d) return null;
  const latigo = d.modo === 'latigo';
  const nombre = d.personaje === 'leya' ? 'Leya' : 'Gael';
  const estado = caminando ? 'walk' : latigo ? 'whip' : bocadillo.hablando ? 'talk' : 'wave';

  const volver = () => invoke('mascota_volver');
  const posponer = async () => {
    await emitTo('main', 'mascota:posponer').catch(() => {});
    invoke('mascota_flotante_cerrar');
  };

  return (
    <div className={`flotante ${latigo ? 'flotante--latigo' : ''}`}>
      {!caminando && (
        <div className="flotante__bocadillo" role="alert" key={d.modo}>
          <div className="flotante__cabeza">
            <span>{nombre} · lixbon</span>
            {d.fuera && <span>fuera {d.fuera}</span>}
          </div>
          {latigo && <p className="flotante__grito">¡TLABAJA, HAY QUE TLABAJA!</p>}
          <p className="flotante__texto">
            <span className="mascota-bocadillo__molde" aria-hidden="true">{d.texto}</span>
            <span className="mascota-bocadillo__escrito">{bocadillo.mostrado}</span>
          </p>
          <div className="flotante__botones">
            <button type="button" className="flotante__btn is-principal" onClick={volver}>{latigo ? 'Ya voy' : 'Volver a lixbon'}</button>
            <button type="button" className="flotante__btn" onClick={posponer}>{latigo ? 'Déjame 10 min' : 'En 10 min'}</button>
          </div>
        </div>
      )}
      <div ref={ref} style={estilo || undefined}>
        <SpriteMascota personaje={d.personaje} estado={estado} tam={144} espejo={caminando && haciaIzq} quieta={quieta} />
      </div>
    </div>
  );
}
