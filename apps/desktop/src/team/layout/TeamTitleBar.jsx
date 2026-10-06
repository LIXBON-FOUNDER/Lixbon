// TeamTitleBar.jsx — la barra de la ventana de Team, calcada de la del IDE:
// marca, equipo, el buscador en el centro y los controles de ventana (solo en
// la app de escritorio: en team.lixbon.com los pone el navegador).
import { useEffect, useRef, useState } from 'react';
import { useTeamStore } from '../store/teamStore';
import { TeamMark } from '../../components/Logo';
import { WindowControls } from '../../layout/WindowControls';
import { IconChevronDown, IconPlus, IconCheck } from '../../components/Icons';
import { Buscador } from './Buscador';

export const inicialesDe = (nombre) => String(nombre || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();

function ProyectoMenu() {
  const { proyectos, proyectoActivo, irAProyecto, irA } = useTeamStore();
  const [abierto, setAbierto] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!abierto) return undefined;
    const fuera = (e) => { if (!ref.current?.contains(e.target)) setAbierto(false); };
    const esc = (e) => { if (e.key === 'Escape') setAbierto(false); };
    window.addEventListener('pointerdown', fuera);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', fuera); window.removeEventListener('keydown', esc); };
  }, [abierto]);
  const actual = proyectoActivo();
  return (
    <div className="tproymenu" ref={ref}>
      <button className="projbtn" onClick={() => setAbierto((v) => !v)}>
        {actual && <span className="tproy">{actual.tablero?.prefijo || inicialesDe(actual.nombre)}</span>}
        {actual ? actual.nombre : 'Sin equipo'}
        <IconChevronDown size={12} />
      </button>
      {abierto && (
        <div className="tmenu tproymenu__pop">
          {proyectos.map((p) => (
            <button key={p.id} className={`tmenu__item ${p.id === actual?.id ? 'is-on' : ''}`} onClick={() => { irAProyecto(p.id); setAbierto(false); }}>
              <span className="tproy">{p.tablero?.prefijo || inicialesDe(p.nombre)}</span>
              <span className="tmenu__txt"><span>{p.nombre}</span><span className="tmenu__ayuda">{p.tablero?.prefijo ? `${p.tablero.prefijo} · ` : ''}{p.miembros.length} personas · {p.rol === 'lider' ? 'líder' : 'integrante'}</span></span>
              {p.id === actual?.id && <IconCheck size={13} />}
            </button>
          ))}
          <button className="tmenu__item" onClick={() => { setAbierto(false); irA('nuevo'); }}>
            <IconPlus size={13} />
            <span className="tmenu__txt"><span>Nuevo equipo</span></span>
          </button>
        </div>
      )}
    </div>
  );
}

export function TeamTitleBar({ minimal = false }) {
  return (
    <header className="titlebar">
      <div className="titlebar__brand" data-tauri-drag-region>
        <TeamMark size={18} />
        <span className="titlebar__word">lixbon</span>
        <span className="ttitle__team">team</span>
      </div>
      {!minimal && <ProyectoMenu />}
      <div className="titlebar__drag" data-tauri-drag-region />
      {!minimal && <Buscador />}
      <div className="titlebar__drag" data-tauri-drag-region />
      {window.__TAURI_INTERNALS__ ? <WindowControls /> : <span className="ttitle__hueco" />}
    </header>
  );
}
