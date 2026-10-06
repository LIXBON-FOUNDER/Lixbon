// Tablero.jsx — columnas por estado con tarjetas que se arrastran. Soltar una
// tarjeta cambia su estado y su orden (índice fraccional) de una sola vez.
import { useState } from 'react';
import { useIssuesStore } from '../../store/issuesStore';
import { Rombos, Etiqueta, Agente, Barra } from '../../ui/Marcas';
import { Cara, nombreDe } from '../../ui/Panel';
import { IconBurbuja, IconClip, IconRama, IconCalendar } from '../../ui/icons';
import { IconPlus } from '../../../components/Icons';
import { vencimiento, nombreEstimacion, ordenEntre, esCerrado } from '../../lib/issues';

const POR_COLUMNA = 25;

export function Tarjeta({ issue, t, onAbrir, arrastrable = true, onArrastre }) {
  const estado = t.estadosPorId[issue.estado_id];
  const cerrada = esCerrado(estado);
  const venc = vencimiento(issue.fecha_limite, cerrada);
  const persona = t.gente[issue.asignado_id];
  const sub = issue.subtareas;
  const escala = t.tablero.config?.estimacion || 'fib';
  return (
    <article
      className={`ttarjeta ${cerrada ? 'is-cerrada' : ''}`}
      draggable={arrastrable}
      onDragStart={(e) => { e.dataTransfer.setData('text/lixbon-issue', issue.id); e.dataTransfer.effectAllowed = 'move'; onArrastre?.(issue.id); }}
      onDragEnd={() => onArrastre?.(null)}
      onClick={() => onAbrir(issue.id)}
    >
      <div className="ttarjeta__cab">
        <span className="ttarjeta__clave mono">{issue.clave}</span>
        {issue.etiquetas.slice(0, 2).map((id) => <Etiqueta key={id} etiqueta={t.etiquetasPorId[id]} />)}
        {issue.etiquetas.length > 2 && <span className="tdim">+{issue.etiquetas.length - 2}</span>}
        <span className="tfill" />
        {issue.prioridad > 0 && <Rombos prioridad={issue.prioridad} />}
      </div>
      <h3 className="ttarjeta__titulo">
        <button type="button" onClick={(e) => { e.stopPropagation(); onAbrir(issue.id); }}>{issue.titulo}</button>
      </h3>
      {sub.total > 0 && (
        <div className="ttarjeta__sub">
          <span>{sub.hechas} de {sub.total} subtareas</span>
          <Barra pct={(sub.hechas / sub.total) * 100} color="var(--info)" ancho="100%" />
        </div>
      )}
      {issue.rama && (
        <div className="ttarjeta__rama">
          <IconRama size={13} />
          <span className="mono">{issue.rama}</span>
          {issue.pr && <span className={`tpr is-${issue.pr.estado || 'abierto'}`}>PR {issue.pr.ref}</span>}
        </div>
      )}
      {(venc || issue.estimacion != null) && (
        <div className="ttarjeta__meta">
          {venc && <span className={`tvence is-${venc.tono}`}><IconCalendar size={13} />{venc.texto}</span>}
          <span className="tfill" />
          {issue.estimacion != null && <span className="mono tdim">{nombreEstimacion(escala, issue.estimacion)}</span>}
        </div>
      )}
      <div className="ttarjeta__pie">
        <span className="ttarjeta__gente">
          {persona && <Cara usuario={persona.usuario} size={22} />}
          {persona && !issue.agente_rol && <span className="tdim">{nombreDe(persona.usuario)}</span>}
          {issue.agente_rol && <Agente rol={issue.agente_rol} corto />}
        </span>
        <span className="tfill" />
        {issue.comentarios > 0 && <span className="ttarjeta__cuenta"><IconBurbuja size={13} />{issue.comentarios}</span>}
        {issue.vinculos > 0 && <span className="ttarjeta__cuenta"><IconClip size={13} />{issue.vinculos}</span>}
      </div>
    </article>
  );
}

function Columna({ estado, issues, t, onAbrir, arrastrando, setArrastrando }) {
  const editar = useIssuesStore((s) => s.editar);
  const abrirCreacion = useIssuesStore((s) => s.abrirCreacion);
  const [encima, setEncima] = useState(null);   // índice donde caería
  const [todas, setTodas] = useState(false);
  const visibles = todas ? issues : issues.slice(0, POR_COLUMNA);

  const soltar = (e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/lixbon-issue');
    const destino = encima ?? issues.length;
    setEncima(null);
    setArrastrando(null);
    if (!id) return;
    const resto = issues.filter((i) => i.id !== id);
    const pos = Math.min(destino, resto.length);
    const orden = ordenEntre(resto[pos - 1]?.orden, resto[pos]?.orden);
    const actual = t.issues.find((i) => i.id === id);
    if (actual && actual.estado_id === estado.id && Math.abs((actual.orden || 0) - orden) < 1e-9) return;
    editar(id, { estado_id: estado.id, orden });
  };

  return (
    <section
      className={`tcol ${arrastrando ? 'is-destino' : ''}`}
      aria-label={estado.nombre}
      onDragOver={(e) => { if (arrastrando) { e.preventDefault(); if (encima == null) setEncima(issues.length); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setEncima(null); }}
      onDrop={soltar}
    >
      <header className="tcol__cab">
        <span className="tcuadro" style={{ background: estado.color }} />
        <span className="tcol__nombre">{estado.nombre}</span>
        <span className="tcol__n">{issues.length}</span>
        <span className="tfill" />
        <button className="ic" onClick={() => abrirCreacion({ proyectoId: t.proyectoId, estadoId: estado.id })} aria-label={`Nueva issue en ${estado.nombre}`}><IconPlus size={14} /></button>
      </header>
      <div className="tcol__lista">
        {visibles.map((i, n) => (
          <div
            key={i.id}
            className={`tcol__hueco ${encima === n && arrastrando && arrastrando !== i.id ? 'is-encima' : ''}`}
            onDragOver={(e) => {
              if (!arrastrando) return;
              e.preventDefault();
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              setEncima(e.clientY < r.top + r.height / 2 ? n : n + 1);
            }}
          >
            <Tarjeta issue={i} t={t} onAbrir={onAbrir} onArrastre={setArrastrando} />
          </div>
        ))}
        {encima === issues.length && arrastrando && <div className="tcol__marca" />}
        {issues.length > POR_COLUMNA && (
          <button className="tcol__mas" onClick={() => setTodas((v) => !v)}>
            {todas ? 'Mostrar menos' : `Mostrar ${issues.length - POR_COLUMNA} más`}
          </button>
        )}
        {!issues.length && !arrastrando && (
          <button className="tcol__vacia" onClick={() => abrirCreacion({ proyectoId: t.proyectoId, estadoId: estado.id })}>
            <IconPlus size={14} /> Nueva issue
          </button>
        )}
      </div>
    </section>
  );
}

export function Tablero({ t, columnas, issues, onAbrir }) {
  const [arrastrando, setArrastrando] = useState(null);
  return (
    <div className="ttablero" style={{ '--cols': columnas.length }}>
      {columnas.map((e) => (
        <Columna
          key={e.id}
          estado={e}
          t={t}
          onAbrir={onAbrir}
          arrastrando={arrastrando}
          setArrastrando={setArrastrando}
          issues={issues.filter((i) => i.estado_id === e.id)}
        />
      ))}
    </div>
  );
}
