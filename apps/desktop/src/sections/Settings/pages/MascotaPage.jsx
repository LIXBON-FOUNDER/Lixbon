// MascotaPage.jsx — Ajustes → Mascota: Gael y Leya. Son los mismos ajustes
// que en lixbon.com (se guardan en la cuenta), así que cambiarlos aquí también
// los cambia en la web.
import { Segmented } from '../../../components/Segmented';
import { Switch } from '../../../components/Switch';
import { Select } from '../../../components/Select';
import { IconMascota } from '../../../components/Icons';
import { SpriteMascota } from '../../../components/Mascota';
import { fijarMascota, useMascota } from '../../../lib/mascota';
import { PageHead, SectionHead } from '../SettingsParts';

const PERSONAJES = [
  { value: 'gael', label: 'Gael', sub: 'Tranquilo, de pocas palabras' },
  { value: 'leya', label: 'Leya', sub: 'Directa y bromista' },
  { value: 'ambos', label: 'Ambos', sub: 'Se turnan cada vez que abres el IDE' },
];
const minutos = (lista) => lista.map((n) => ({ value: n, label: `${n} min` }));

function Fila({ label, hint, children }) {
  return (
    <div className="srow">
      <div className="srow__text">
        <span className="srow__label">{label}</span>
        {hint && <span className="srow__hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function MascotaPage() {
  const m = useMascota();
  const set = (k) => (v) => fijarMascota({ [k]: v });
  const off = !m.activa;
  const vista = m.personaje === 'leya' ? 'leya' : 'gael';

  return (
    <div className="spage">
      <PageHead icon={IconMascota} title="Mascota" sub="Gael y Leya te acompañan mientras trabaja el agente. Se guarda en tu cuenta: la web usa los mismos ajustes." />

      <section className="ssec rise rise--1">
        <div className="ssec ssec--card ssec--rows">
          <div className="srow mascota-ajustes">
            <span className="mascota-ajustes__escena">
              <SpriteMascota personaje={vista} estado={off ? 'sleep' : 'idle'} tam={96} quieta={off || m.reducir} />
              {m.personaje === 'ambos' && !off && <SpriteMascota personaje="leya" estado="idle" tam={96} quieta={m.reducir} />}
            </span>
            <div className="srow__text">
              <span className="srow__label">Mostrar la mascota</span>
              <span className="srow__hint">En el chat del agente, en la pista de progreso y en los avisos fuera de la app.</span>
            </div>
            <Switch checked={m.activa} onChange={set('activa')} label="Mostrar la mascota" />
          </div>
        </div>
      </section>

      <section className={`ssec rise rise--2 ${off ? 'is-apagada' : ''}`}>
        <SectionHead label="Personaje" />
        <div className="mascota-elegir" role="group" aria-label="Personaje">
          {PERSONAJES.map((p) => (
            <button
              key={p.value}
              type="button"
              disabled={off}
              aria-pressed={m.personaje === p.value}
              className={`mascota-elegir__op ${m.personaje === p.value ? 'is-activa' : ''}`}
              onClick={() => fijarMascota({ personaje: p.value })}
            >
              <span className="mascota-elegir__retrato">
                {p.value === 'ambos'
                  ? <><SpriteMascota personaje="gael" tam={48} quieta /><SpriteMascota personaje="leya" tam={48} quieta /></>
                  : <SpriteMascota personaje={p.value} tam={48} quieta />}
              </span>
              <span className="mascota-elegir__nombre">{p.label}</span>
              <span className="mascota-elegir__sub">{p.sub}</span>
            </button>
          ))}
        </div>
      </section>

      <section className={`ssec rise rise--3 ${off ? 'is-apagada' : ''}`}>
        <SectionHead label="Mientras el agente trabaja" />
        <div className="ssec ssec--card ssec--rows">
          <Fila label="Animación" hint="«Según la tarea» teclea en respuestas cortas y se sube al kart cuando el agente encadena pasos.">
            <Segmented size="sm" width={92} value={m.trabajo} onChange={set('trabajo')}
              options={[{ value: 'escribir', label: 'Escribir' }, { value: 'conducir', label: 'Conducir' }, { value: 'auto', label: 'Según tarea' }]} />
          </Fila>
          <Fila label="Preguntar al terminar" hint="Propone el siguiente paso («¿Continuar con la siguiente fase?»); pulsar una respuesta se la manda al agente.">
            <Switch checked={m.preguntar} onChange={set('preguntar')} label="Preguntar al terminar" disabled={off} />
          </Fila>
          <Fila label="Dormirse con inactividad" hint="Se echa una siesta si no pasa nada. Despierta al mover el ratón o escribir.">
            <span className="mascota-fila__controles">
              {m.dormir && <Select value={m.dormir_min} onChange={set('dormir_min')} options={minutos([1, 2, 5, 10, 15, 30])} disabled={off} className="mascota-minutos" />}
              <Switch checked={m.dormir} onChange={set('dormir')} label="Dormirse con inactividad" disabled={off} />
            </span>
          </Fila>
        </div>
      </section>

      <section className={`ssec rise rise--4 ${off ? 'is-apagada' : ''}`}>
        <SectionHead label="Fuera de la app" hint="Cuando el agente termina o pide permiso y estás en otra ventana." />
        <div className="ssec ssec--card ssec--rows">
          <Fila label="Aviso flotante" hint="La mascota aparece sobre las demás apps, en la esquina de la pantalla.">
            <Switch checked={m.flotante} onChange={set('flotante')} label="Aviso flotante" disabled={off} />
          </Fila>
          <Fila label="Látigo si no vuelves" hint="«Tlabaja, hay que tlabaja», si sigues fuera pasado este tiempo.">
            <span className="mascota-fila__controles">
              {m.latigo && <Select value={m.latigo_min} onChange={set('latigo_min')} options={minutos([1, 2, 3, 5, 10])} disabled={off || !m.flotante} up className="mascota-minutos" />}
              <Switch checked={m.latigo} onChange={set('latigo')} label="Látigo si no vuelves" disabled={off || !m.flotante} />
            </span>
          </Fila>
          <Fila label="Reducir movimiento" hint="Sprites quietos. También se respeta la preferencia del sistema.">
            <Switch checked={m.reducir} onChange={set('reducir')} label="Reducir movimiento" disabled={off} />
          </Fila>
        </div>
      </section>
    </div>
  );
}
