// CitaIssue.jsx — cuando un mensaje nombra una issue («LXB-12»), debajo se ve
// su tarjeta con estado, prioridad y persona. Pinchar la abre en Issues.
import { useMemo } from 'react';
import { useTeamStore } from '../store/teamStore';
import { useIssuesStore } from '../store/issuesStore';
import { Casilla, Rombos } from '../ui/Marcas';
import { Cara, nombreDe } from '../ui/Panel';
import { CLAVE_ISSUE } from '../lib/issues';

export function CitasIssue({ texto }) {
  const proyectos = useTeamStore((s) => s.proyectos);
  const porProyecto = useIssuesStore((s) => s.porProyecto);
  const abrir = useIssuesStore((s) => s.abrir);
  const citadas = useMemo(() => {
    const claves = [...new Set([...String(texto || '').matchAll(CLAVE_ISSUE)].map((m) => m[0]))].slice(0, 3);
    return claves.map((clave) => {
      for (const p of proyectos) {
        const i = porProyecto[p.id]?.issues.find((x) => x.clave === clave);
        if (i) return { i, p };
      }
      return null;
    }).filter(Boolean);
  }, [texto, proyectos, porProyecto]);
  if (!citadas.length) return null;
  return (
    <div className="tcitas">
      {citadas.map(({ i, p }) => {
        const estado = (p.tablero?.estados || []).find((e) => e.id === i.estado_id);
        const persona = p.miembros.find((m) => m.usuario.id === i.asignado_id);
        return (
          <button key={i.id} className="tcita" onClick={() => abrir(i.id)}>
            <span className="tcita__fila">
              {i.prioridad > 0 && <Rombos prioridad={i.prioridad} size={14} />}
              <span className="mono tdim">{i.clave}</span>
              <span className="tcita__t">{i.titulo}</span>
            </span>
            <span className="tcita__fila tcita__meta">
              <span className="tcita__estado"><Casilla estado={estado} size={14} />{estado?.nombre}</span>
              {i.subtareas.total > 0 && <span>{i.subtareas.hechas} de {i.subtareas.total} subtareas</span>}
              <span className="tfill" />
              {persona && <><Cara usuario={persona.usuario} size={18} />{nombreDe(persona.usuario)}</>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
