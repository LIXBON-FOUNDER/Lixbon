// HiloPanel.jsx — el hilo abierto a la derecha del canal.
import { useEffect } from 'react';
import { useTeamStore } from '../store/teamStore';
import { useMensajesStore } from '../store/mensajesStore';
import { MessageItem } from './MessageItem';
import { Composer } from './Composer';
import { useScrollPegado, useSoltarArchivos, BotonAcoplar } from './ChannelView';
import { nombreDe } from '../ui/Panel';
import { IconX } from '../../components/Icons';

const AGRUPA_MS = 5 * 60 * 1000;

export function HiloPanel({ canal, raizId }) {
  const { quien, usuario, conexion, cerrarHilo } = useTeamStore();
  const raiz = useMensajesStore((s) => (s.porCanal[canal.id]?.lista || []).find((m) => m.id === raizId));
  const hilo = useMensajesStore((s) => s.hilos[raizId]);
  const cargarHilo = useMensajesStore((s) => s.cargarHilo);
  const cargarMasHilo = useMensajesStore((s) => s.cargarMasHilo);
  const lista = hilo?.lista || [];
  const scroll = useScrollPegado([lista.length, raizId], () => {
    if (!hilo?.hayMas || hilo?.cargando) return false;
    cargarMasHilo(canal.id, raizId);
    return true;
  });
  const soltar = useSoltarArchivos(`hilo:${raizId}`, canal.id);

  useEffect(() => { cargarHilo(canal.id, raizId); }, [cargarHilo, canal.id, raizId]);
  useEffect(() => { scroll.reiniciar(); }, [raizId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const alPulsar = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) cerrarHilo(); };
    window.addEventListener('keydown', alPulsar);
    return () => window.removeEventListener('keydown', alPulsar);
  }, [cerrarHilo]);

  return (
    <div className="tchat" {...soltar.props}>
      {soltar.encima && <div className="tsoltar">Suelta para adjuntar</div>}
      <header className="tpanelhead">
        <span className="tpanelhead__t">Hilo</span>
        <span className="tpanelhead__s mono">{canal.tipo === 'directo' ? nombreDe(canal.con) : `# ${canal.nombre}`}</span>
        <div className="tfill" />
        <BotonAcoplar canalId={canal.id} />
        <button className="ic" onClick={cerrarHilo} aria-label="Cerrar el hilo (Esc)"><IconX size={15} /></button>
      </header>
      <div className="tmensajes tmensajes--hilo" ref={scroll.ref} onScroll={scroll.onScroll}>
        {raiz ? (
          <div className="thilo__raiz">
            <MessageItem mensaje={raiz} autor={quien(raiz.autor_id)} propio={raiz.autor_id === usuario?.id} seguido={false} enHilo />
          </div>
        ) : (
          <p className="testado">El mensaje ya no está en la parte cargada del canal.</p>
        )}
        <div className="tdia mono"><span>{lista.length === 0 ? 'Sin respuestas todavía' : lista.length === 1 ? '1 respuesta' : `${lista.length} respuestas`}</span><i /></div>
        {hilo?.cargando && <p className="testado">Cargando…</p>}
        {lista.map((m, i) => {
          const anterior = lista[i - 1];
          const seguido = anterior?.autor_id === m.autor_id && new Date(m.creado_en) - new Date(anterior.creado_en) < AGRUPA_MS;
          return <MessageItem key={m.id} mensaje={m} autor={quien(m.autor_id)} propio={m.autor_id === usuario?.id} seguido={Boolean(seguido)} enHilo />;
        })}
      </div>
      <Composer canal={canal} desconectado={conexion !== 'conectado'} hiloDe={raizId} />
    </div>
  );
}
