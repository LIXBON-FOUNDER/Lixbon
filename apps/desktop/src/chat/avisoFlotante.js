// avisoFlotante.js — cuándo sale la mascota sobre las demás apps.
// Si un agente (de cualquier sesión abierta) termina o pide permiso mientras
// el IDE no tiene el foco, aparece el aviso; si pasado el tiempo de Ajustes ›
// Mascota sigues fuera, vuelve con el látigo. Al volver al IDE se va solo.
// La ventana la abre src-tauri/src/mascota.rs; aquí solo se decide qué dice.
import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useSessionsStore } from '../store/chatStore';
import { leerMascota, personajeDe } from '../lib/mascota';
import { preguntaFinal } from './estadoAgente';
import { nombreDeTarea } from './nombreDeTarea';

const POSPONER_MIN = 10;

export function useAvisoFlotante() {
  useEffect(() => {
    // En el navegador (npm run dev) no hay ventanas nativas.
    if (!window.__TAURI_INTERNALS__) return undefined;
    let enFoco = document.hasFocus();
    let visible = false;
    let latigo = null;
    let ultimo = null; // { titulo } del último aviso, para el látigo
    const quitar = [];

    const mostrar = (datos) => {
      const prefs = leerMascota();
      visible = true;
      invoke('mascota_flotante', {
        datos: JSON.stringify({ personaje: personajeDe(prefs), reducir: prefs.reducir, ...datos }),
      }).catch(() => { visible = false; });
    };

    const cerrar = () => {
      clearTimeout(latigo);
      latigo = null;
      if (visible) invoke('mascota_flotante_cerrar').catch(() => {});
      visible = false;
    };

    const programarLatigo = (min) => {
      clearTimeout(latigo);
      const prefs = leerMascota();
      if (!prefs.latigo || !ultimo) return;
      latigo = setTimeout(() => {
        if (enFoco) return;
        mostrar({
          modo: 'latigo',
          fuera: `${min} min`,
          texto: `«${ultimo.titulo}» lleva ${min} min esperando tu revisión.`,
        });
      }, min * 60_000);
    };

    const avisar = (s, pide) => {
      const prefs = leerMascota();
      if (!prefs.activa || !prefs.flotante || enFoco) return;
      const titulo = nombreDeTarea(s);
      const p = pide ? null : preguntaFinal(s.messages || []);
      ultimo = { titulo };
      mostrar({
        modo: 'aviso',
        texto: pide
          ? `El agente necesita tu permiso en «${titulo}».`
          : p?.texto.startsWith('¡Fase') ? `${p.texto.split('!')[0]}! Te espero para seguir con «${titulo}».`
          : `Terminé «${titulo}». Te espero para seguir.`,
      });
      programarLatigo(prefs.latigo_min);
    };

    // Cada sesión abierta (también las que se abran después).
    const vigiladas = new Map();
    const vigilar = () => {
      const { sessions } = useSessionsStore.getState();
      for (const [key, store] of Object.entries(sessions)) {
        if (vigiladas.has(key)) continue;
        vigiladas.set(key, store.subscribe((a, b) => {
          const espera = !!a.pendingApproval || !!a.pendingQuestion;
          const esperaba = !!b.pendingApproval || !!b.pendingQuestion;
          if (espera && !esperaba) avisar(a, true);
          else if (b.streaming && !a.streaming && !espera) avisar(a, false);
        }));
      }
      for (const [key, unsub] of vigiladas) {
        if (!sessions[key]) { unsub(); vigiladas.delete(key); }
      }
    };
    vigilar();
    quitar.push(useSessionsStore.subscribe(vigilar));

    let vivo = true;
    // Lo que se registra tarde (tras un await) se suelta al momento si el
    // efecto ya se desmontó.
    const guardar = (f) => { if (vivo) quitar.push(f); else f(); };
    (async () => {
      const win = getCurrentWindow();
      enFoco = await win.isFocused().catch(() => enFoco);
      guardar(await win.onFocusChanged(({ payload }) => {
        enFoco = payload;
        if (enFoco) cerrar();
      }));
      guardar(await listen('mascota:posponer', () => {
        visible = false;
        programarLatigo(POSPONER_MIN);
      }));
    })();

    return () => {
      vivo = false;
      cerrar();
      quitar.forEach((f) => f());
      vigiladas.forEach((u) => u());
    };
  }, []);
}
