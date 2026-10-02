// MascotaAgente.jsx — Gael o Leya junto al chat del agente y la pista de
// progreso sobre la barra de estado.
//   · Llega caminando desde el borde de la ventana y saluda según la hora.
//   · Mientras el agente trabaja: piensa, teclea o, en tareas de varios pasos,
//     se sube al kart y corre por la pista (cada bandera es un paso).
//   · Si el agente espera permiso o una respuesta, saluda para avisar.
//   · Al terminar celebra y propone el siguiente paso; pulsar una respuesta se
//     la manda al agente.
//   · En reposo hace gestos (mira a los lados, se estira, se rasca), suelta
//     algún consejo de vez en cuando y, sin actividad un rato, se duerme.
// Lo que dice aparece con rebote y se escribe letra a letra mientras habla.
import { useEffect, useRef, useState } from 'react';
import { useChatStore, useSessionsStore } from '../store/chatStore';
import { NOMBRES, alAzar, duracion, personajeDe, useMascota } from '../lib/mascota';
import { SpriteMascota, Bocadillo } from '../components/Mascota';
import { useAccion, useBocadillo, useCaminata, useGestos, useInactivo } from '../components/mascotaVida';
import { actividadDe, animacionDeTrabajo, preguntaFinal } from './mascotaAgente';
import { FRASES, saludoDeLaHora } from './mascotaFrases';

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

// Llega caminando una vez por arranque (en cada tamaño: panel ancho y lateral).
const yaLlego = new Set();
let yaSaludo = false;

export function MascotaAgente({ tam = 96 }) {
  const prefs = useMascota();
  const act = leerActividad(useActividad());
  const activeKey = useSessionsStore((s) => s.activeKey);
  const quieta = prefs.reducir;
  const ref = useRef(null);
  const bocadillo = useBocadillo(quieta);
  const [accion, hacer] = useAccion();
  const [pregunta, setPregunta] = useState(null);
  const [entrada] = useState(() => (yaLlego.has(tam) ? null : `entra-${tam}`));
  useEffect(() => { yaLlego.add(tam); }, [tam]);
  const { estilo, caminando, haciaIzq } = useCaminata(ref, prefs.activa ? entrada : null, 'der', quieta);
  const antes = useRef({ key: activeKey, trabajando: act.trabajando, esperando: act.esperando, dormida: false });

  const ocupada = act.trabajando || act.esperando || !!pregunta;
  const dormida = useInactivo(prefs.dormir_min, prefs.activa && prefs.dormir && !ocupada);
  const libre = prefs.activa && !ocupada && !dormida && !bocadillo.abierto && !accion && !caminando;

  // Saludo al llegar (una vez por arranque).
  useEffect(() => {
    if (!prefs.activa || caminando || yaSaludo || tam < 96) return;
    yaSaludo = true;
    hacer('wave', duracion('wave') * 2);
    bocadillo.decir(alAzar(saludoDeLaHora()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.activa, caminando]);

  // Cambios de estado del agente en la sesión que se está viendo.
  useEffect(() => {
    const prev = antes.current;
    antes.current = { key: activeKey, trabajando: act.trabajando, esperando: act.esperando, dormida };
    if (prev.key !== activeKey) { setPregunta(null); bocadillo.callar(); return; }
    if (act.esperando && !prev.esperando) {
      hacer('wave', duracion('wave') * 3);
      bocadillo.decir(alAzar(FRASES.espera), null);
      return;
    }
    if (!act.esperando && prev.esperando) bocadillo.callar();
    if (act.trabajando && !prev.trabajando) { setPregunta(null); bocadillo.callar(); return; }
    if (prev.trabajando && !act.trabajando && !act.esperando) {
      hacer('celebrate', duracion('celebrate') * 2);
      const p = prefs.preguntar ? preguntaFinal(useChatStore.getState().messages) : null;
      setTimeout(() => {
        if (p) { setPregunta(p); bocadillo.decir(p.texto, null); } else bocadillo.decir(alAzar(FRASES.listo));
      }, quieta ? 0 : 600);
    } else if (prev.dormida && !dormida) {
      hacer('stretch');
      bocadillo.decir(alAzar(FRASES.despierta));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [act.trabajando, act.esperando, activeKey, dormida]);

  // Si piensa mucho rato sin escribir nada, lo comenta.
  useEffect(() => {
    if (!act.trabajando || act.escribiendo || act.pasos > 0) return undefined;
    const t = setTimeout(() => bocadillo.decir(alAzar(FRASES.piensaMucho), 2800), 9000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [act.trabajando, act.escribiendo, act.pasos]);

  // Gestos en reposo y, de vez en cuando, un consejo.
  useGestos(libre && !quieta, hacer);
  useEffect(() => {
    if (!libre) return undefined;
    const t = setTimeout(() => { hacer('scratch', duracion('scratch') * 2); bocadillo.decir(alAzar(FRASES.suelta), 4200); }, 150_000 + Math.random() * 120_000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libre]);

  if (!prefs.activa) return null;
  const quien = personajeDe(prefs);
  const nombre = NOMBRES[quien];

  let estado = 'idle';
  let rotulo = nombre;
  if (caminando) estado = 'walk';
  else if (act.trabajando && !act.esperando) {
    estado = animacionDeTrabajo(prefs, act);
    // En kart va por la pista de abajo: aquí no se duplica.
    if (estado === 'kart') return null;
    if (bocadillo.hablando) estado = 'talk';
    rotulo = `${nombre} está ${estado === 'type' ? 'escribiendo' : 'pensando'}`;
  } else if (accion) estado = accion;
  else if (bocadillo.hablando) estado = 'talk';
  else if (act.esperando || pregunta) estado = 'wave';
  else if (dormida) {
    estado = 'sleep';
    rotulo = `${nombre} se ha dormido`;
  }

  const responder = (op) => {
    setPregunta(null);
    bocadillo.callar();
    const chat = useChatStore.getState();
    if (op.plan) chat.runPlan?.();
    else if (op.enviar) { hacer('celebrate'); chat.send(op.enviar); }
  };

  const tocar = () => {
    if (ocupada || caminando) return;
    hacer(alAzar(['wave', 'celebrate', 'scratch']));
    bocadillo.decir(alAzar(FRASES.toque), 2400);
  };

  return (
    <div className={`mascota-agente mascota-agente--${estado} ${tam < 96 ? 'is-chica' : ''}`} ref={ref} style={estilo || undefined}>
      {bocadillo.abierto && !caminando && (
        <Bocadillo
          texto={bocadillo.texto}
          mostrado={bocadillo.mostrado}
          cerrando={bocadillo.cerrando}
          className={pregunta ? 'mascota-bocadillo--pregunta' : ''}
          pie={pregunta && !bocadillo.hablando && (
            <span className="mascota-opciones" role="group" aria-label="Respuestas">
              {pregunta.opciones.map((op, i) => (
                <button
                  key={op.label}
                  type="button"
                  className={`mascota-opcion ${i === 0 ? 'is-principal' : ''}`}
                  style={{ animationDelay: `${i * 70}ms` }}
                  onClick={() => responder(op)}
                >
                  {op.label}
                </button>
              ))}
            </span>
          )}
        >
          <span className="mascota-bocadillo__nombre">{nombre}</span>
        </Bocadillo>
      )}
      {estado === 'think' && <span className="mascota-puntos" aria-hidden="true"><i /><i /><i /></span>}
      {estado === 'sleep' && <span className="mascota-zzz" aria-hidden="true"><i>z</i><i>z</i><i>Z</i></span>}
      <button
        type="button"
        className="mascota-agente__boton"
        onClick={tocar}
        onMouseEnter={() => { if (libre) hacer('wave'); }}
        aria-label={rotulo}
        title={rotulo}
      >
        <SpriteMascota personaje={quien} estado={estado} tam={tam} espejo={caminando && haciaIzq} quieta={quieta} />
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
