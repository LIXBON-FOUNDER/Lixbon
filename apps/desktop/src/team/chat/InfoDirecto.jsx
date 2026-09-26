// InfoDirecto.jsx — la ficha de la persona con la que hablas en un directo.
import { useTeamStore } from '../store/teamStore';
import { useMensajesStore } from '../store/mensajesStore';
import { useAcopladosStore } from '../store/acopladosStore';
import { estadoDef } from '../lib/presencia';
import { hace } from '../lib/tiempo';
import { Cara, nombreDe } from '../ui/Panel';
import { IconFile, IconImage, IconPanelRight } from '../../components/Icons';
import { IconMic } from '../ui/icons';

const SIN_MENSAJES = [];

export function InfoDirecto({ canal }) {
  const proyectos = useTeamStore((s) => s.proyectos);
  const irAProyecto = useTeamStore((s) => s.irAProyecto);
  const lista = useMensajesStore((s) => s.porCanal[canal.id]?.lista) || SIN_MENSAJES;
  const { ids, alternar } = useAcopladosStore();
  const u = canal.con;
  const def = estadoDef(canal.estado);
  const comunes = proyectos.filter((p) => p.miembros.some((m) => m.usuario.id === u?.id));
  const compartido = lista.flatMap((m) => (m.adjuntos || []).map((a) => ({ ...a, cuando: m.creado_en }))).slice(-6).reverse();
  const anclado = (ids || []).includes(canal.id);

  return (
    <div className="tinfo">
      <div className="tinfo__quien">
        <Cara usuario={u} size={64} />
        <span className="tinfo__nombre">{[u?.first_name, u?.last_name].filter(Boolean).join(' ') || nombreDe(u)}</span>
        {u?.username && <span className="mono tinfo__user">@{u.username}</span>}
        <span className="tinfo__estado"><span className="tpunto" style={{ background: def.color }} />{def.label}</span>
      </div>
      <button className={`btn btn--sm ${anclado ? 'btn--ghost' : 'btn--primary'} tinfo__btn`} onClick={() => alternar(canal.id)}>
        <IconPanelRight size={13} />{anclado ? 'Quitar del IDE' : 'Acoplar al IDE'}
      </button>
      {comunes.length > 0 && (
        <section className="tinfo__bloque">
          <span className="tcap">Proyectos en común</span>
          {comunes.map((p) => {
            const rol = p.miembros.find((m) => m.usuario.id === u?.id)?.rol;
            return (
              <button key={p.id} className="lk tinfo__fila" onClick={() => irAProyecto(p.id)}>
                <span className="tproy">{p.nombre.slice(0, 2).toUpperCase()}</span>
                <span className="tinfo__fila-n">{p.nombre}</span>
                <span className="mono tdim">{rol === 'lider' ? 'Líder' : 'Integrante'}</span>
              </button>
            );
          })}
        </section>
      )}
      {compartido.length > 0 && (
        <section className="tinfo__bloque">
          <span className="tcap">Compartido aquí</span>
          {compartido.map((a) => (
            <div key={a.id} className="tinfo__fila mono">
              {a.tipo === 'imagen' ? <IconImage size={13} /> : a.tipo === 'audio' ? <IconMic size={13} /> : <IconFile size={13} />}
              <span className="tinfo__fila-n">{a.tipo === 'audio' && /^nota-de-voz-/.test(a.nombre) ? 'Nota de voz' : a.nombre}</span>
              <span className="tdim">{hace(a.cuando)}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
