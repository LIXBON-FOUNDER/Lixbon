// NuevaIssue.jsx — el formulario de issue nueva, encima de lo que haya. Nace
// en el ciclo de hoy si el equipo trabaja por ciclos, y se puede seguir
// creando sin cerrarlo.
import { useEffect, useRef, useState } from 'react';
import { useIssuesStore } from '../../store/issuesStore';
import { useTablero } from '../../store/useTablero';
import {
  SelEstado, SelPrioridad, SelPersona, SelEtiquetas, SelCiclo, SelIniciativa, SelEstimacion, SelFecha,
} from './Propiedades';
import { IconX } from '../../../components/Icons';

export function NuevaIssue() {
  const creando = useIssuesStore((s) => s.creando);
  const cerrar = useIssuesStore((s) => s.cerrarCreacion);
  const crear = useIssuesStore((s) => s.crear);
  const abrir = useIssuesStore((s) => s.abrir);
  const t = useTablero(creando?.proyectoId);
  const pendiente = t.estados.find((e) => e.tipo === 'pendiente')?.id;
  const inicial = () => ({
    titulo: '', descripcion: '', estado_id: creando?.estadoId || pendiente, prioridad: 0, asignado_id: null,
    etiquetas: [], ciclo_id: t.tablero.config?.ciclos?.activos ? t.cicloHoy?.id || null : null,
    iniciativa_id: creando?.iniciativaId || null, estimacion: null, fecha_limite: creando?.fecha || null,
    padre_id: creando?.padreId || null,
  });
  const [d, setD] = useState(inicial);
  const [seguir, setSeguir] = useState(false);
  const [error, setError] = useState('');
  const [enviando, setEnviando] = useState(false);

  useEffect(() => { setD(inicial()); setError(''); }, [creando?.proyectoId, creando?.estadoId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Escape cierra y Ctrl Enter crea, esté donde esté el foco (tras elegir en un
  // desplegable, el foco vuelve al documento).
  const enviarRef = useRef(null);
  useEffect(() => {
    if (!creando) return undefined;
    const tecla = (e) => {
      if (e.key === 'Escape') cerrar();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); enviarRef.current?.(); }
    };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [cerrar, creando]);

  if (!creando || !t.proyecto) return null;
  const poner = (campo) => (v) => setD((x) => ({ ...x, [campo]: v }));

  const enviar = async (e) => {
    e?.preventDefault();
    if (!d.titulo.trim() || enviando) return;
    setEnviando(true);
    const { issue, error: fallo } = await crear(t.proyectoId, { ...d, titulo: d.titulo.trim() });
    setEnviando(false);
    if (fallo) { setError(fallo); return; }
    if (seguir) { setD({ ...inicial(), estado_id: d.estado_id, etiquetas: d.etiquetas, iniciativa_id: d.iniciativa_id }); return; }
    cerrar();
    if (issue && !creando.sinAbrir) abrir(issue.id);
  };

  enviarRef.current = enviar;
  return (
    <div className="tvelo" onPointerDown={(e) => { if (e.target === e.currentTarget) cerrar(); }}>
      <form className="tnueva" role="dialog" aria-label="Nueva issue" onSubmit={enviar}>
        <div className="tnueva__cab">
          <span className="tproy">{t.tablero.prefijo}</span>
          <span className="tdim">{t.proyecto.nombre}</span>
          <span className="tdim">›</span>
          <span>Nueva issue</span>
          <span className="tfill" />
          <button type="button" className="ic" onClick={cerrar} aria-label="Cerrar"><IconX size={14} /></button>
        </div>
        <input className="tnueva__titulo" autoFocus value={d.titulo} onChange={(e) => poner('titulo')(e.target.value)} placeholder="Título de la issue" aria-label="Título" maxLength={200} />
        <textarea className="tnueva__desc" value={d.descripcion} onChange={(e) => poner('descripcion')(e.target.value)} placeholder="Descripción (opcional)" aria-label="Descripción" rows={4} />
        <div className="tnueva__props">
          <SelEstado t={t} valor={d.estado_id} onCambio={poner('estado_id')} />
          <SelPrioridad valor={d.prioridad} onCambio={poner('prioridad')} />
          <SelPersona t={t} valor={d.asignado_id} onCambio={poner('asignado_id')} />
          <SelEtiquetas t={t} valor={d.etiquetas} onCambio={poner('etiquetas')} />
          <SelCiclo t={t} valor={d.ciclo_id} onCambio={poner('ciclo_id')} />
          <SelIniciativa t={t} valor={d.iniciativa_id} onCambio={poner('iniciativa_id')} />
          <SelEstimacion t={t} valor={d.estimacion} onCambio={poner('estimacion')} />
          <SelFecha valor={d.fecha_limite} onCambio={poner('fecha_limite')} />
        </div>
        {error && <p className="terror">{error}</p>}
        <div className="tnueva__pie">
          <label className="tcheck"><input type="checkbox" checked={seguir} onChange={(e) => setSeguir(e.target.checked)} /> Crear otra después</label>
          <span className="tfill" />
          <span className="tdim">Ctrl Enter</span>
          <button className="btn btn--acento" type="submit" disabled={!d.titulo.trim() || enviando}>{enviando ? 'Creando…' : 'Crear issue'}</button>
        </div>
      </form>
    </div>
  );
}
