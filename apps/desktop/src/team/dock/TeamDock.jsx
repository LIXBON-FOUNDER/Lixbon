// TeamDock.jsx — Lixbon Team en el panel derecho del IDE: solo las
// conversaciones que el usuario acopla, una a la vez, para contestar sin
// dejar de mirar el código.
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTeamStore } from '../store/teamStore';
import { useAcopladosStore } from '../store/acopladosStore';
import { useWorkbenchStore } from '../../store/workbenchStore';
import { Mensajes, Escribiendo, useSoltarArchivos } from '../chat/ChannelView';
import { HiloPanel } from '../chat/HiloPanel';
import { Composer } from '../chat/Composer';
import { Visor } from '../chat/Adjunto';
import { Cara, nombreDe } from '../ui/Panel';
import { LogoMark } from '../../components/Logo';
import { IconPlus, IconX, IconExternal, IconCheck } from '../../components/Icons';
import { IconHash, IconLock } from '../ui/icons';
import '../styles/team.css';

function todasLasConversaciones(proyectos, directos) {
  return [
    ...proyectos.flatMap((p) => p.canales.map((c) => ({ id: c.id, nombre: `#${c.nombre}`, sub: p.nombre, canal: c }))),
    ...directos.map((d) => ({ id: d.id, nombre: nombreDe(d.con), sub: 'Directo', canal: d })),
  ];
}

function Elegir({ onCerrar }) {
  const { proyectos, directos } = useTeamStore();
  const { ids, alternar } = useAcopladosStore();
  const ref = useRef(null);
  useEffect(() => {
    const fuera = (e) => { if (!ref.current?.contains(e.target)) onCerrar(); };
    window.addEventListener('pointerdown', fuera);
    return () => window.removeEventListener('pointerdown', fuera);
  }, [onCerrar]);
  return (
    <div className="tmenu tdock__elegir" ref={ref}>
      <div className="tcap">Qué conversaciones se ven aquí</div>
      <div className="tdock__lista">
        {todasLasConversaciones(proyectos, directos).map((c) => {
          const on = (ids || []).includes(c.id);
          return (
            <button key={c.id} className={`tmenu__item ${on ? 'is-on' : ''}`} onClick={() => alternar(c.id)}>
              {c.canal.tipo === 'directo' ? <Cara usuario={c.canal.con} estado={c.canal.estado} size={18} /> : c.canal.tipo === 'privado' ? <IconLock size={13} /> : <IconHash size={13} />}
              <span className="tmenu__txt"><span>{c.nombre}</span><span className="tmenu__ayuda">{c.sub}</span></span>
              {on && <IconCheck size={13} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function TeamDock({ onClose }) {
  const { sesion, proyectos, directos, canalId, hiloId, abrirCanal, conexion, noLeidos } = useTeamStore();
  const { ids, cargar } = useAcopladosStore();
  const setRightView = useWorkbenchStore((s) => s.setRightView);
  const [eligiendo, setEligiendo] = useState(false);
  useEffect(() => { cargar(); }, [cargar]);

  const todas = todasLasConversaciones(proyectos, directos);
  const acopladas = (ids || []).map((id) => todas.find((c) => c.id === id)).filter(Boolean);
  const activa = acopladas.find((c) => c.id === canalId) || null;
  const canal = activa ? useTeamStore.getState().canalActivo() : null;
  const soltar = useSoltarArchivos(canal?.id, canal?.id);

  useEffect(() => {
    if (!activa && acopladas[0]) abrirCanal(acopladas[0].id);
  }, [activa, acopladas.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="tdock" {...soltar.props}>
      {soltar.encima && <div className="tsoltar">Suelta para adjuntar</div>}
      <div className="panelhead tdock__head">
        <div className="tdock__pills">
          {acopladas.map((c) => (
            <button key={c.id} className={`tdock__pill ${c.id === canalId ? 'is-on' : ''}`} onClick={() => abrirCanal(c.id)} title={c.sub}>
              {c.nombre}
              {c.id !== canalId && noLeidos[c.id] > 0 && <span className="mono tacento">{noLeidos[c.id]}</span>}
            </button>
          ))}
        </div>
        <div className="panelhead__fill" />
        <div className="tdock__rel">
          <button className="ic" onClick={() => setEligiendo((v) => !v)} aria-label="Elegir qué conversaciones se ven aquí"><IconPlus size={15} /></button>
          {eligiendo && <Elegir onCerrar={() => setEligiendo(false)} />}
        </div>
        <button className="ic" onClick={() => invoke('team_abrir').catch(() => {})} aria-label="Abrir Lixbon Team en su ventana"><IconExternal size={14} /></button>
        <button className="ic" onClick={() => setRightView('agent')} aria-label="Volver al agente" title="Volver al agente"><LogoMark size={14} /></button>
        {onClose && <button className="ic" onClick={onClose} aria-label="Cerrar panel"><IconX size={15} /></button>}
      </div>

      {sesion !== 'ok' ? (
        <div className="tvacio">{sesion === 'error' ? 'No se pudo conectar con Lixbon Team.' : 'Conectando con Lixbon Team…'}</div>
      ) : !acopladas.length ? (
        <div className="tvacio">
          <p>Acopla las conversaciones que quieras tener junto al editor.</p>
          <button className="btn btn--primary btn--sm" onClick={() => setEligiendo(true)}><IconPlus size={13} /> Elegir conversaciones</button>
        </div>
      ) : canal && hiloId ? (
        <HiloPanel canal={canal} raizId={hiloId} />
      ) : canal ? (
        <>
          <Mensajes canal={canal} compacto />
          <Escribiendo canalId={canal.id} />
          <Composer canal={canal} desconectado={conexion !== 'conectado'} compacto />
        </>
      ) : null}
      <Visor />
    </div>
  );
}
