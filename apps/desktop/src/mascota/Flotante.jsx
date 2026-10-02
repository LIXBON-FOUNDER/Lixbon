// Flotante.jsx — Gael o Leya sobre el escritorio. Dos momentos, que decide
// el IDE (chat/avisoFlotante.js):
//   · aviso: el agente terminó (o pide permiso) y estás en otra app.
//   · látigo: sigues fuera pasado el tiempo de Ajustes › Mascota.
// «Volver a lixbon» trae el IDE al frente; «En 10 min» lo pospone.
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { SpriteMascota } from '../components/Mascota';

function leer(texto) {
  try { return texto ? JSON.parse(texto) : null; } catch { return null; }
}

export function Flotante() {
  const [d, setD] = useState(null);

  useEffect(() => {
    invoke('mascota_datos').then((t) => setD(leer(t))).catch(() => {});
    let quitar;
    listen('mascota:datos', (e) => setD(leer(e.payload))).then((f) => { quitar = f; });
    return () => quitar?.();
  }, []);

  if (!d) return null;
  const latigo = d.modo === 'latigo';
  const nombre = d.personaje === 'leya' ? 'Leya' : 'Gael';

  const volver = () => invoke('mascota_volver');
  const posponer = async () => {
    await emitTo('main', 'mascota:posponer').catch(() => {});
    invoke('mascota_flotante_cerrar');
  };

  return (
    <div className={`flotante ${latigo ? 'flotante--latigo' : ''}`}>
      <div className="flotante__bocadillo" role="alert">
        <div className="flotante__cabeza">
          <span>{nombre} · lixbon</span>
          {d.fuera && <span>fuera {d.fuera}</span>}
        </div>
        {latigo && <p className="flotante__grito">¡TLABAJA, HAY QUE TLABAJA!</p>}
        <p className="flotante__texto">{d.texto}</p>
        <div className="flotante__botones">
          <button type="button" className="flotante__btn is-principal" onClick={volver}>{latigo ? 'Ya voy' : 'Volver a lixbon'}</button>
          <button type="button" className="flotante__btn" onClick={posponer}>{latigo ? 'Déjame 10 min' : 'En 10 min'}</button>
        </div>
      </div>
      <SpriteMascota personaje={d.personaje} estado={latigo ? 'whip' : 'wave'} tam={144} quieta={d.reducir} />
    </div>
  );
}
