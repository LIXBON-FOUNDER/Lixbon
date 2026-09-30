// TeamApp.jsx — la ventana de Lixbon Team: barra de título, las columnas de
// la sección abierta y la barra de estado, con la física de paneles del IDE.
import { useEffect, useRef } from 'react';
import { useTeamStore } from './store/teamStore';
import { useCanalActivo } from './store/useCanalActivo';
import { useAcopladosStore } from './store/acopladosStore';
import { TeamTitleBar } from './layout/TeamTitleBar';
import { Indice } from './layout/Indice';
import { ChannelView } from './chat/ChannelView';
import { HiloPanel } from './chat/HiloPanel';
import { InfoDirecto } from './chat/InfoDirecto';
import { Visor } from './chat/Adjunto';
import { IssuesView } from './secciones/issues/IssuesView';
import { NuevaIssue } from './secciones/issues/NuevaIssue';
import { RepoView } from './secciones/RepoView';
import { GenteView } from './secciones/GenteView';
import { AjustesView } from './secciones/AjustesView';
import { InicioView } from './secciones/InicioView';
import { ProyectosView } from './secciones/ProyectosView';
import { CalendarioView } from './secciones/CalendarioView';
import { NuevoEquipoView } from './secciones/NuevoEquipoView';
import { SinSesion } from './secciones/Varios';
import { Carril } from './layout/Carril';
import { useIssuesStore } from './store/issuesStore';
import { TPanel, TGutter } from './ui/Panel';

function Chat() {
  const { anchos, hiloId, infoAbierta } = useTeamStore();
  const canal = useCanalActivo();
  return (
    <>
      <TPanel id="indice" className="tidx" style={{ width: anchos.lista }}><Indice /></TPanel>
      <TGutter clave="lista" min={200} max={380} />
      <TPanel id="chat" className="wb__grow"><ChannelView /></TPanel>
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
  const hayDirectos = useTeamStore((s) => s.directos.length > 0);
  // Sin equipos, lo primero es crear uno (o esperar una invitación); los
  // directos siguen a mano en el chat.
  if (vista === 'nuevo' || (!hayProyecto && vista !== 'proyecto' && !(vista === 'chat' && hayDirectos))) return <NuevoEquipoView />;
  if (vista === 'inicio') return <InicioView />;
  if (vista === 'issues') return <IssuesView />;
  if (vista === 'proyectos') return <ProyectosView />;
  if (vista === 'calendario') return <CalendarioView />;
  if (vista === 'proyecto') return <AjustesView />;
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

/** Al abrir, Team empieza en Inicio y trae las issues de todos tus equipos
 *  (el buscador y el aviso del carril las necesitan). La tecla C crea una. */
function useArranque(listo, proyectos) {
  const empezado = useRef(false);
  useEffect(() => {
    if (!listo || !proyectos.length) return;
    if (!empezado.current) {
      empezado.current = true;
      // Salvo que el IDE ya haya pedido abrir una issue o crear una.
      const { abiertaId, creando } = useIssuesStore.getState();
      if (!abiertaId && !creando) useTeamStore.setState({ vista: 'inicio' });
    }
    const cargar = useIssuesStore.getState().cargar;
    for (const p of proyectos) cargar(p.id);
  }, [listo, proyectos]);

  // El IDE pide cosas a esta ventana desde su botón de Team.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return undefined;
    const quitar = [];
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('team:abrir-issue', (e) => { if (e.payload?.id) useIssuesStore.getState().abrir(e.payload.id); }).then((f) => quitar.push(f));
      listen('team:nueva-issue', (e) => {
        const pid = e.payload?.proyectoId;
        if (!pid) return;
        useTeamStore.setState({ proyectoId: pid });
        useIssuesStore.getState().abrirCreacion({ proyectoId: pid });
      }).then((f) => quitar.push(f));
    }).catch(() => {});
    return () => quitar.forEach((f) => f());
  }, []);

  useEffect(() => {
    const tecla = (e) => {
      if (e.key !== 'c' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      const { proyectoId, sesion } = useTeamStore.getState();
      if (sesion !== 'ok' || !proyectoId) return;
      e.preventDefault();
      useIssuesStore.getState().abrirCreacion({ proyectoId });
    };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, []);
}

export function TeamApp() {
  const { sesion, errorSesion, hidratar, cargando, proyectos } = useTeamStore();
  useEffect(() => { hidratar(); }, [hidratar]);

  const listo = sesion === 'ok';
  const esperando = sesion === 'cargando' || (listo && cargando && !proyectos.length);
  useArranque(listo && !cargando, proyectos);
  return (
    <div className="tframe">
      <TeamTitleBar minimal={!listo} />
      <main className="tframe__body">
        {esperando && <div className="tcargando"><span className="brand">lixbon team</span><div className="trun"><i /></div></div>}
        {!esperando && (sesion === 'sin-sesion' || sesion === 'error') && <SinSesion error={sesion === 'error' ? errorSesion : ''} />}
        {!esperando && listo && (
          <>
            <Carril />
            <div className="tframe__secc">
              <Cuerpo />
            </div>
          </>
        )}
      </main>
      {listo && <Estado />}
      <NuevaIssue />
      <Visor />
    </div>
  );
}
