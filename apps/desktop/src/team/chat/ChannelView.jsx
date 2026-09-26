// ChannelView.jsx — la conversación de un canal o un directo, con su cabecera,
// el scroll que no te arranca de donde lees y el compositor.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTeamStore } from '../store/teamStore';
import { useCanalActivo } from '../store/useCanalActivo';
import { useMensajesStore } from '../store/mensajesStore';
import { useBorradorStore } from '../store/borradorStore';
import { useAcopladosStore } from '../store/acopladosStore';
import { MessageItem } from './MessageItem';
import { Composer } from './Composer';
import { Cara, nombreDe } from '../ui/Panel';
import { estadoDef } from '../lib/presencia';
import { IconPanelRight, IconUser } from '../../components/Icons';
import { IconHash, IconLock } from '../ui/icons';

const AGRUPA_MS = 5 * 60 * 1000;
const PEGADO_PX = 90;

const mismoDia = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function etiquetaDia(fecha) {
  const hoy = new Date();
  const ayer = new Date(hoy);
  ayer.setDate(hoy.getDate() - 1);
  if (mismoDia(fecha, hoy)) return 'Hoy';
  if (mismoDia(fecha, ayer)) return 'Ayer';
  return fecha.toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long',
    ...(fecha.getFullYear() !== hoy.getFullYear() ? { year: 'numeric' } : {}),
  });
}

export function useScrollPegado(dependencias, alTope) {
  const ref = useRef(null);
  const pegado = useRef(true);
  const alturaPrevia = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Al cargar historial arriba se conserva la posición de lectura.
    if (alturaPrevia.current && el.scrollHeight > alturaPrevia.current && !pegado.current) {
      el.scrollTop += el.scrollHeight - alturaPrevia.current;
    } else if (pegado.current) {
      el.scrollTop = el.scrollHeight;
    }
    alturaPrevia.current = el.scrollHeight;
  }, dependencias); // eslint-disable-line react-hooks/exhaustive-deps
  const reiniciar = () => { pegado.current = true; alturaPrevia.current = 0; };
  const onScroll = (e) => {
    const el = e.currentTarget;
    pegado.current = el.scrollHeight - el.scrollTop - el.clientHeight < PEGADO_PX;
    if (el.scrollTop < 120 && alTope()) alturaPrevia.current = el.scrollHeight;
  };
  return { ref, onScroll, reiniciar };
}

function Escribiendo({ canalId }) {
  const escribiendoEn = useTeamStore((s) => s.escribiendoEn);
  const quien = useTeamStore((s) => s.quien);
  const [, latir] = useState(0);
  const ids = escribiendoEn(canalId);
  useEffect(() => {
    if (!ids.length) return undefined;
    const t = setInterval(() => latir((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [ids.length]);
  const gente = ids.map(quien).filter(Boolean);
  return (
    <div className="tescribiendo">
      {gente.length > 0 && (
        <>
          <span className="tpuntos"><span /><span /><span /></span>
          {gente.map(nombreDe).join(', ')} {gente.length === 1 ? 'está escribiendo' : 'están escribiendo'}
        </>
      )}
    </div>
  );
}

export function Mensajes({ canal, compacto = false }) {
  const usuario = useTeamStore((s) => s.usuario);
  const quien = useTeamStore((s) => s.quien);
  const estado = useMensajesStore((s) => s.porCanal[canal.id]);
  const cargarMas = useMensajesStore((s) => s.cargarMas);
  const lista = estado?.lista || [];
  const scroll = useScrollPegado([lista.length, canal.id], () => {
    if (!estado?.hayMas || estado?.cargando) return false;
    cargarMas(canal.id);
    return true;
  });
  useEffect(() => { scroll.reiniciar(); }, [canal.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const esDirecto = canal.tipo === 'directo';
  return (
    <div className={`tmensajes ${compacto ? 'is-compacto' : ''}`} ref={scroll.ref} onScroll={scroll.onScroll}>
      {estado?.cargando && <p className="testado">Cargando…</p>}
      {estado?.cargado && !estado?.hayMas && (
        <div className="tprincipio">
          {esDirecto ? (
            <>
              <Cara usuario={canal.con} size={44} />
              <span className="tprincipio__t">{nombreDe(canal.con)}</span>
              <span className="tprincipio__s">Este es el principio de vuestra conversación. Solo la veis los dos.</span>
            </>
          ) : (
            <>
              <span className="tprincipio__t"><span className="mono">#</span> {canal.nombre}</span>
              <span className="tprincipio__s">{lista.length ? `Este es el principio de #${canal.nombre}.` : 'Todavía no hay nada por aquí. Escribe lo primero.'}</span>
            </>
          )}
        </div>
      )}
      {lista.map((m, i) => {
        const anterior = lista[i - 1];
        const fecha = new Date(m.creado_en);
        const nuevoDia = !anterior || !mismoDia(new Date(anterior.creado_en), fecha);
        const seguido = !nuevoDia && anterior?.autor_id === m.autor_id && fecha - new Date(anterior.creado_en) < AGRUPA_MS;
        return (
          <div key={m.id}>
            {nuevoDia && <div className="tdia mono"><span>{etiquetaDia(fecha)}</span><i /></div>}
            <MessageItem mensaje={m} autor={quien(m.autor_id)} propio={m.autor_id === usuario?.id} seguido={seguido} compacto={compacto} />
          </div>
        );
      })}
    </div>
  );
}

export function useSoltarArchivos(clave, canalId) {
  const añadir = useBorradorStore((s) => s.añadir);
  const [encima, setEncima] = useState(false);
  const hondo = useRef(0);
  const trae = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  return {
    encima,
    props: {
      onDragEnter: (e) => { if (trae(e)) { hondo.current += 1; setEncima(true); } },
      onDragOver: (e) => { if (trae(e)) e.preventDefault(); },
      onDragLeave: () => { hondo.current = Math.max(0, hondo.current - 1); if (!hondo.current) setEncima(false); },
      onDrop: (e) => {
        if (!trae(e)) return;
        e.preventDefault();
        hondo.current = 0;
        setEncima(false);
        añadir(clave, e.dataTransfer.files, canalId);
      },
    },
  };
}

export function BotonAcoplar({ canalId, conTexto = false }) {
  const { ids, cargar, alternar } = useAcopladosStore();
  useEffect(() => { cargar(); }, [cargar]);
  const anclado = (ids || []).includes(canalId);
  return (
    <button
      className={`ic tacoplar ${anclado ? 'is-on' : ''}`}
      onClick={() => alternar(canalId)}
      aria-label={anclado ? 'Quitar del panel del IDE' : 'Acoplar al panel del IDE'}
      title={anclado ? 'Quitar del panel del IDE' : 'Tenerla a mano en el panel derecho del IDE'}
    >
      <IconPanelRight size={15} />
      {conTexto && <span>{anclado ? 'En el IDE' : 'Acoplar al IDE'}</span>}
    </button>
  );
}

export function ChannelView() {
  const canal = useCanalActivo();
  const conexion = useTeamStore((s) => s.conexion);
  const irA = useTeamStore((s) => s.irA);
  const infoAbierta = useTeamStore((s) => s.infoAbierta);
  const alternarInfo = useTeamStore((s) => s.alternarInfo);
  const soltar = useSoltarArchivos(canal?.id, canal?.id);

  if (!canal) return <div className="tvacio">Elige un canal o una conversación para empezar.</div>;

  const esDirecto = canal.tipo === 'directo';
  const def = esDirecto ? estadoDef(canal.estado) : null;
  const miembros = canal.proyecto?.miembros || [];

  return (
    <div className="tchat" {...soltar.props}>
      {soltar.encima && <div className="tsoltar">Suelta para adjuntar</div>}
      <header className="tpanelhead">
        {esDirecto ? (
          <>
            <Cara usuario={canal.con} estado={canal.estado} size={22} />
            <span className="tpanelhead__t">{nombreDe(canal.con)}</span>
            <span className="tpanelhead__s" style={{ color: def.color }}>{def.label}</span>
          </>
        ) : (
          <>
            <span className="tpanelhead__t">
              {canal.tipo === 'privado' ? <IconLock size={14} /> : <IconHash size={14} className="tdim" />}
              {canal.nombre}
            </span>
            {canal.tema && <span className="tpanelhead__s">{canal.tema}</span>}
          </>
        )}
        <div className="tfill" />
        {!esDirecto && miembros.length > 0 && (
          <button className="lk tcaras" onClick={() => irA('gente')} title="Ver la gente del proyecto">
            <span className="tcaras__pila">
              {miembros.slice(0, 4).map((m) => <Cara key={m.usuario.id} usuario={m.usuario} size={20} />)}
            </span>
            <span className="mono">{miembros.length}</span>
          </button>
        )}
        <BotonAcoplar canalId={canal.id} />
        {esDirecto && (
          <button className={`ic ${infoAbierta ? 'is-on' : ''}`} onClick={alternarInfo} aria-label="Información del contacto">
            <IconUser size={15} />
          </button>
        )}
      </header>
      <Mensajes canal={canal} />
      <Escribiendo canalId={canal.id} />
      <Composer canal={canal} desconectado={conexion !== 'conectado'} />
    </div>
  );
}

export { Escribiendo };
