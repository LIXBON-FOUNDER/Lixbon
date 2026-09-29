// TeamTitleBar.jsx — la barra de la ventana de Team, calcada de la del IDE:
// marca, proyecto, secciones en el centro y los controles de ventana.
import { useEffect, useRef, useState } from 'react';
import { useTeamStore } from '../store/teamStore';
import { TeamMark } from '../../components/Logo';
import { WindowControls } from '../../layout/WindowControls';
import { Cara } from '../ui/Panel';
import { IconChevronDown, IconPlus, IconSliders, IconCheck } from '../../components/Icons';
import { IconCalendar } from '../ui/icons';

const SECCIONES = [
  { id: 'chat', label: 'Chat' },
  { id: 'issues', label: 'Issues' },
  { id: 'repo', label: 'Repositorio' },
  { id: 'gente', label: 'Gente' },
];
const TAB_W = 92;

export const inicialesDe = (nombre) => String(nombre || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();

function ProyectoMenu() {
  const { proyectos, proyectoActivo, irAProyecto, crearProyecto } = useTeamStore();
  const [abierto, setAbierto] = useState(false);
  const [nombre, setNombre] = useState('');
  const [error, setError] = useState('');
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
  const crear = async (e) => {
    e.preventDefault();
    if (!nombre.trim()) return;
    const fallo = await crearProyecto(nombre.trim());
    if (fallo) { setError(fallo); return; }
    setNombre('');
    setError('');
    setAbierto(false);
  };
  return (
    <div className="tproymenu" ref={ref}>
      <button className="projbtn" onClick={() => setAbierto((v) => !v)}>
        {actual && <span className="tproy">{inicialesDe(actual.nombre)}</span>}
        {actual ? actual.nombre : 'Sin proyecto'}
        <IconChevronDown size={12} />
      </button>
      {abierto && (
        <div className="tmenu tproymenu__pop">
          {proyectos.map((p) => (
            <button key={p.id} className={`tmenu__item ${p.id === actual?.id ? 'is-on' : ''}`} onClick={() => { irAProyecto(p.id); setAbierto(false); }}>
              <span className="tproy">{inicialesDe(p.nombre)}</span>
              <span className="tmenu__txt"><span>{p.nombre}</span><span className="tmenu__ayuda">{p.miembros.length} personas · {p.rol === 'lider' ? 'líder' : 'integrante'}</span></span>
              {p.id === actual?.id && <IconCheck size={13} />}
            </button>
          ))}
          <form className="tproymenu__nuevo" onSubmit={crear}>
            <IconPlus size={13} />
            <input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Proyecto nuevo" maxLength={60} aria-label="Nombre del proyecto nuevo" />
          </form>
          {error && <p className="terror">{error}</p>}
        </div>
      )}
    </div>
  );
}

export function TeamTitleBar({ minimal = false }) {
  const vista = useTeamStore((s) => s.vista);
  const irA = useTeamStore((s) => s.irA);
  const volverAlChat = useTeamStore((s) => s.volverAlChat);
  const usuario = useTeamStore((s) => s.usuario);
  const presencia = useTeamStore((s) => s.presencia);
  const pendientes = useTeamStore((s) => s.proyectoActivo()?.linear_team_id);
  const idx = SECCIONES.findIndex((t) => t.id === vista);

  return (
    <header className="titlebar">
      <div className="titlebar__brand" data-tauri-drag-region>
        <TeamMark size={18} />
        <span className="titlebar__word">lixbon</span>
        <span className="ttitle__team">team</span>
      </div>
      {!minimal && <ProyectoMenu />}
      <div className="titlebar__drag" data-tauri-drag-region />
      {!minimal && (
        <nav className={`modeswitch ${idx < 0 ? 'is-idle' : ''}`} aria-label="Sección">
          <span className="modeswitch__thumb" style={{ width: TAB_W, transform: `translateX(${Math.max(0, idx) * TAB_W}px)` }} />
          {SECCIONES.map((t) => (
            <button
              key={t.id}
              className={`modeswitch__tab ${vista === t.id ? 'is-active' : ''}`}
              style={{ width: TAB_W }}
              onClick={() => (t.id === 'chat' ? volverAlChat() : irA(t.id))}
            >
              {t.label}
              {t.id === 'issues' && !pendientes && <span className="ttab__dot" title="Sin vincular a Linear" />}
            </button>
          ))}
        </nav>
      )}
      <div className="titlebar__drag" data-tauri-drag-region />
      {!minimal && (
        <div className="titlebar__tools">
          <button className={`ic ${vista === 'calendario' ? 'is-on' : ''}`} onClick={() => irA('calendario')} aria-label="Calendario"><IconCalendar size={16} /></button>
          <button className={`ic ${vista === 'proyecto' ? 'is-on' : ''}`} onClick={() => irA('proyecto')} aria-label="Ajustes del proyecto"><IconSliders size={16} /></button>
          <button className="ttitle__yo" onClick={() => irA('proyecto')} aria-label="Tu cuenta">
            <Cara usuario={usuario} estado={presencia} size={24} />
          </button>
        </div>
      )}
      <WindowControls />
    </header>
  );
}
