// Carril.jsx — la columna de iconos de Lixbon Team: una sección por icono,
// con el aviso de lo pendiente encima y tu cara abajo.
import { useEffect, useRef, useState } from 'react';
import { useTeamStore } from '../store/teamStore';
import { useIssuesStore } from '../store/issuesStore';
import { ESTADOS } from '../lib/presencia';
import { esCerrado } from '../lib/issues';
import { Cara } from '../ui/Panel';
import { IconCheck } from '../../components/Icons';
import {
  IconInicio, IconBurbuja, IconIssues, IconCapas, IconCalendar, IconRama, IconPeople, IconAjustesEquipo,
} from '../ui/icons';

export const SECCIONES = [
  { id: 'inicio', nombre: 'Inicio', Icono: IconInicio },
  { id: 'chat', nombre: 'Chat', Icono: IconBurbuja },
  { id: 'issues', nombre: 'Issues', Icono: IconIssues },
  { id: 'proyectos', nombre: 'Proyectos y ciclos', Icono: IconCapas },
  { id: 'calendario', nombre: 'Calendario', Icono: IconCalendar },
  { id: 'repo', nombre: 'Repositorio', Icono: IconRama },
  { id: 'gente', nombre: 'Gente', Icono: IconPeople },
];

function Yo() {
  const { usuario, presencia, cambiarPresencia, salir } = useTeamStore();
  const [abierto, setAbierto] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!abierto) return undefined;
    const fuera = (e) => { if (!ref.current?.contains(e.target)) setAbierto(false); };
    window.addEventListener('pointerdown', fuera);
    return () => window.removeEventListener('pointerdown', fuera);
  }, [abierto]);
  return (
    <div className="tcarril__yo" ref={ref}>
      <button className="tcarril__cara" onClick={() => setAbierto((v) => !v)} aria-label="Tu estado">
        <Cara usuario={usuario} estado={presencia} size={30} />
      </button>
      {abierto && (
        <div className="tmenu tcarril__menu">
          <div className="tcap">Tu estado</div>
          {ESTADOS.map((e) => (
            <button key={e.id} className={`tmenu__item ${presencia === e.id ? 'is-on' : ''}`} onClick={() => { cambiarPresencia(e.id); setAbierto(false); }}>
              <span className="tpunto" style={{ color: e.color }} />
              <span className="tmenu__txt"><span>{e.label}</span></span>
              {presencia === e.id && <IconCheck size={13} />}
            </button>
          ))}
          {!window.__TAURI_INTERNALS__ && (
            <button className="tmenu__item" onClick={salir}><span className="tmenu__txt"><span>Cerrar sesión</span></span></button>
          )}
        </div>
      )}
    </div>
  );
}

export function Carril() {
  const { vista, irA, volverAlChat, noLeidos, proyectoId, usuario } = useTeamStore();
  const tablero = useTeamStore((s) => s.proyectoActivo()?.tablero);
  const issues = useIssuesStore((s) => s.del(proyectoId).issues);
  const sinLeer = Object.values(noLeidos).reduce((a, n) => a + n, 0);
  const estados = Object.fromEntries((tablero?.estados || []).map((e) => [e.id, e]));
  const mias = issues.filter((i) => i.asignado_id === usuario?.id && !esCerrado(estados[i.estado_id])).length;
  const aviso = { chat: sinLeer, issues: mias };

  return (
    <nav className="tcarril" aria-label="Secciones">
      {SECCIONES.map(({ id, nombre, Icono }) => {
        const on = vista === id || (id === 'issues' && vista === 'issue');
        const n = aviso[id] || 0;
        return (
          <button
            key={id}
            className={`tcarril__btn ${on ? 'is-on' : ''}`}
            aria-current={on ? 'page' : undefined}
            aria-label={n ? `${nombre}, ${n}` : nombre}
            title={nombre}
            onClick={() => {
              if (id === 'chat') volverAlChat();
              else if (id === 'issues' && on) useIssuesStore.getState().cerrar();
              else irA(id);
            }}
          >
            <Icono size={19} />
            {n > 0 && <span className={`tcarril__num ${id === 'issues' ? 'is-suave' : ''}`}>{n > 99 ? '99+' : n}</span>}
          </button>
        );
      })}
      <div className="tfill" />
      <button
        className={`tcarril__btn ${vista === 'proyecto' ? 'is-on' : ''}`}
        aria-label="Ajustes del equipo"
        title="Ajustes del equipo"
        onClick={() => irA('proyecto')}
      >
        <IconAjustesEquipo size={19} />
      </button>
      <Yo />
    </nav>
  );
}
