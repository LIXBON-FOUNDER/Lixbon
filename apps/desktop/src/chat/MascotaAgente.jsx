// MascotaAgente.jsx — Gael o Leya junto al chat del agente y la pista de
// progreso sobre la barra de estado.
//   · Mientras el agente trabaja: piensa, teclea o, en tareas de varios pasos,
//     se sube al kart y corre por la pista (cada bandera es un paso).
//   · Si el agente espera permiso o una respuesta, saluda para avisar.
//   · Al terminar propone el siguiente paso; pulsar una respuesta se la manda
//     al agente.
//   · Sin actividad un rato, se duerme.
import { useEffect, useRef, useState } from 'react';
import { useChatStore, useSessionsStore } from '../store/chatStore';
import { NOMBRES, personajeDe, useMascota } from '../lib/mascota';
import { SpriteMascota, Bocadillo } from '../components/Mascota';
import { actividadDe, animacionDeTrabajo, preguntaFinal } from './mascotaAgente';

const TOQUES = ['¡Hola!', 'Aquí sigo.', 'Pídeme algo y me pongo a ello.', 'Puedes ocultarme en Ajustes › Mascota.'];

/** true tras `minutos` sin teclado ni ratón. */
function useInactivo(minutos, activo) {
  const [inactivo, setInactivo] = useState(false);
  useEffect(() => {
    if (!activo) { setInactivo(false); return undefined; }
    let t;
    const despertar = () => {
      setInactivo(false);
      clearTimeout(t);
      t = setTimeout(() => setInactivo(true), minutos * 60_000);
    };
    const eventos = ['pointermove', 'pointerdown', 'keydown', 'wheel'];
    eventos.forEach((e) => window.addEventListener(e, despertar, { passive: true }));
    despertar();
    return () => { clearTimeout(t); eventos.forEach((e) => window.removeEventListener(e, despertar)); };
  }, [minutos, activo]);
  return inactivo;
}

function useActividad() {
  return useChatStore((s) => {
    const a = actividadDe(s);
    // Selector estable: solo cambia cuando cambia algo que se pinta.
    return `${a.trabajando}|${a.esperando}|${a.escribiendo}|${a.pasos}|${a.accion}`;
  });
}

function leerActividad(clave) {
  const [trabajando, esperando, escribiendo, pasos, ...accion] = clave.split('|');
  return { trabajando: trabajando === 'true', esperando: esperando === 'true', escribiendo: escribiendo === 'true', pasos: Number(pasos), accion: accion.join('|') };
}

export function MascotaAgente({ tam = 96 }) {
  const prefs = useMascota();
  const act = leerActividad(useActividad());
  const activeKey = useSessionsStore((s) => s.activeKey);
  const [pregunta, setPregunta] = useState(null);
  const [momento, setMomento] = useState(null);
  const tMomento = useRef(null);
  const antes = useRef({ key: activeKey, trabajando: act.trabajando });

  const decir = (texto, ms = 2600) => {
    clearTimeout(tMomento.current);
    setMomento(texto);
    tMomento.current = setTimeout(() => setMomento(null), ms);
  };
  useEffect(() => () => clearTimeout(tMomento.current), []);

  // Fin de un turno en la sesión que se está viendo → pregunta (o "¡Listo!").
  useEffect(() => {
    const prev = antes.current;
    antes.current = { key: activeKey, trabajando: act.trabajando };
    if (prev.key !== activeKey) { setPregunta(null); return; }
    if (act.trabajando) { setPregunta(null); return; }
    if (!prev.trabajando || act.esperando) return;
    const p = prefs.preguntar ? preguntaFinal(useChatStore.getState().messages) : null;
    if (p) setPregunta(p);
    else decir('¡Listo!');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [act.trabajando, activeKey]);

  const ocupada = act.trabajando || act.esperando || !!pregunta;
  const dormida = useInactivo(prefs.dormir_min, prefs.activa && prefs.dormir && !ocupada);

  if (!prefs.activa) return null;
  const quien = personajeDe(prefs);
  const nombre = NOMBRES[quien];

  let estado = 'idle';
  let rotulo = nombre;
  if (act.trabajando && !act.esperando) {
    estado = animacionDeTrabajo(prefs, act);
    // En kart va por la pista de abajo: aquí no se duplica.
    if (estado === 'kart') return null;
    rotulo = `${nombre} está ${estado === 'type' ? 'escribiendo' : 'pensando'}`;
  } else if (act.esperando || pregunta || momento) {
    estado = 'wave';
  } else if (dormida) {
    estado = 'sleep';
    rotulo = `${nombre} se ha dormido`;
  }

  const responder = (op) => {
    setPregunta(null);
    const chat = useChatStore.getState();
    if (op.plan) chat.runPlan?.();
    else if (op.enviar) chat.send(op.enviar);
  };

  const tocar = () => {
    if (ocupada) return;
    decir(TOQUES[Math.floor(Math.random() * TOQUES.length)]);
  };

  return (
    <div className={`mascota-agente mascota-agente--${estado} ${tam < 96 ? 'is-chica' : ''}`}>
      {act.esperando && (
        <Bocadillo>
          <span className="mascota-bocadillo__nombre">{nombre}</span>
          Te necesito: revisa lo que te pide el agente.
        </Bocadillo>
      )}
      {!act.esperando && pregunta && (
        <Bocadillo className="mascota-bocadillo--pregunta">
          <span className="mascota-bocadillo__nombre">{nombre}</span>
          <span>{pregunta.texto}</span>
          <span className="mascota-opciones">
            {pregunta.opciones.map((op, i) => (
              <button
                key={op.label}
                type="button"
                className={`mascota-opcion ${i === 0 ? 'is-principal' : ''}`}
                onClick={() => responder(op)}
              >
                {op.label}
              </button>
            ))}
          </span>
        </Bocadillo>
      )}
      {!act.esperando && !pregunta && momento && <Bocadillo>{momento}</Bocadillo>}
      {estado === 'think' && <span className="mascota-puntos" aria-hidden="true"><i /><i /><i /></span>}
      {estado === 'sleep' && <span className="mascota-zzz" aria-hidden="true"><i>z</i><i>z</i><i>Z</i></span>}
      <button type="button" className="mascota-agente__boton" onClick={tocar} aria-label={rotulo} title={rotulo}>
        <SpriteMascota personaje={quien} estado={estado} tam={tam} quieta={prefs.reducir} />
      </button>
    </div>
  );
}

/** La pista: aparece sobre la barra de estado mientras el agente va en kart.
    No se sabe cuántos pasos hará, así que avanza cada vez menos (nunca llega
    a la meta hasta que termina) y pone una bandera por paso. */
export function PistaAgente() {
  const prefs = useMascota();
  const act = leerActividad(useActividad());
  if (!prefs.activa || !act.trabajando || act.esperando) return null;
  if (animacionDeTrabajo(prefs, act) !== 'kart') return null;

  const quien = personajeDe(prefs);
  const avance = (n) => 1 - Math.exp(-n / 10);
  const p = avance(act.pasos);
  const banderas = Array.from({ length: Math.min(act.pasos, 14) }, (_, i) => avance(i + 1));

  return (
    <div className="pista" role="status" aria-label={`${NOMBRES[quien]} trabajando: paso ${act.pasos}. ${act.accion}`}>
      <div className="pista__carril" aria-hidden="true">
        <span className="pista__hecho" style={{ width: `${p * 100}%` }} />
        {banderas.map((x, i) => <span key={i} className="pista__bandera" style={{ left: `${x * 100}%` }} />)}
        <span className="pista__meta" />
      </div>
      <span className="pista__rotulo mono">{NOMBRES[quien].toUpperCase()} · PASO {act.pasos}</span>
      {act.accion && <span className="pista__accion">{act.accion}</span>}
      <div className="pista__kart" style={{ left: `calc(${p * 100}% - ${Math.round(p * 160)}px)` }}>
        <span className="pista__polvo" aria-hidden="true" />
        <SpriteMascota personaje={quien} estado="kart" tam={96} quieta={prefs.reducir} />
      </div>
    </div>
  );
}
