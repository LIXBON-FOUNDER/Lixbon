// TeamApp.jsx — la ventana de Lixbon Team: barra de título, las columnas de
// la sección abierta y la barra de estado, con la física de paneles del IDE.
import { useEffect } from 'react';
import { useTeamStore } from './store/teamStore';
import { useCanalActivo } from './store/useCanalActivo';
import { useAcopladosStore } from './store/acopladosStore';
import { TeamTitleBar } from './layout/TeamTitleBar';
import { Indice } from './layout/Indice';
import { ChannelView } from './chat/ChannelView';
import { HiloPanel } from './chat/HiloPanel';
import { InfoDirecto } from './chat/InfoDirecto';
import { Visor } from './chat/Adjunto';
import { IssuesView } from './secciones/IssuesView';
import { RepoView } from './secciones/RepoView';
import { GenteView } from './secciones/GenteView';
import { AjustesView } from './secciones/AjustesView';
import { Calendario, SinProyectos, SinSesion } from './secciones/Varios';
import { TPanel, TGutter } from './ui/Panel';

function Chat() {
  const { anchos, hiloId, infoAbierta, proyectos } = useTeamStore();
  const canal = useCanalActivo();
  return (
    <>
      <TPanel id="indice" className="tidx" style={{ width: anchos.lista }}><Indice /></TPanel>
      <TGutter clave="lista" min={200} max={380} />
      {!proyectos.length && !canal ? <SinProyectos /> : <TPanel id="chat" className="wb__grow"><ChannelView /></TPanel>}
      {canal && hiloId && (
        <>
          <TGutter clave="hilo" min={300} max={620} lado="izquierda" />
          <TPanel id="hilo" className="tentra" style={{ width: anchos.hilo }}><HiloPanel canal={canal} raizId={hiloId} /></TPanel>
        </>
      )}
      {canal?.tipo === 'directo' && !hiloId && infoAbierta && (
        <>
          <TGutter clave="info" min={260} max={420} lado="izquierda" />
          <TPanel id="info" className="tentra" style={{ width: anchos.info }}><InfoDirecto canal={canal} /></TPanel>
        </>
      )}
    </>
  );
}

function Cuerpo() {
  const vista = useTeamStore((s) => s.vista);
  const hayProyecto = useTeamStore((s) => s.proyectos.length > 0);
  if (vista === 'calendario') return <Calendario />;
  if (vista === 'proyecto') return <AjustesView />;
  if (!hayProyecto && vista !== 'chat') return <SinProyectos />;
  if (vista === 'issues') return <IssuesView />;
  if (vista === 'repo') return <RepoView />;
  if (vista === 'gente') return <GenteView />;
  return <Chat />;
}

function Estado() {
  const { conexion, proyectoActivo } = useTeamStore();
  const ids = useAcopladosStore((s) => s.ids);
  const proyecto = proyectoActivo();
  const enLinea = (proyecto?.miembros || []).filter((m) => m.estado === 'en_linea').length;
  const n = (ids || []).length;
  return (
    <footer className="tstatus mono">
      {proyecto && <span className="tstatus__fuerte">{proyecto.nombre}</span>}
      {proyecto && <span>{enLinea} en línea</span>}
      <div className="tfill" />
      {n > 0 && <span>{n === 1 ? '1 chat acoplado al IDE' : `${n} chats acoplados al IDE`}</span>}
      <span className={`tstatus__con is-${conexion}`}><i />{conexion === 'conectado' ? 'Conectado' : conexion === 'conectando' ? 'Conectando…' : 'Sin conexión'}</span>
    </footer>
  );
}

export function TeamApp() {
  const { sesion, errorSesion, hidratar, zoom, cargando, proyectos } = useTeamStore();
  useEffect(() => { hidratar(); }, [hidratar]);
  // En <html> y no en el chasis: así Chromium recalcula vh con el zoom y el scroll no se pierde.
  useEffect(() => { document.documentElement.style.zoom = zoom === 1 ? '' : String(zoom); }, [zoom]);

  const listo = sesion === 'ok';
  const esperando = sesion === 'cargando' || (listo && cargando && !proyectos.length);
  return (
    <div className="tframe">
      <TeamTitleBar minimal={!listo} />
      <main className="tframe__body">
        {esperando && <div className="tcargando"><span className="brand">lixbon team</span><div className="trun"><i /></div></div>}
        {!esperando && (sesion === 'sin-sesion' || sesion === 'error') && <SinSesion error={sesion === 'error' ? errorSesion : ''} />}
        {!esperando && listo && <Cuerpo />}
      </main>
      {listo && <Estado />}
      <Visor />
    </div>
  );
}
