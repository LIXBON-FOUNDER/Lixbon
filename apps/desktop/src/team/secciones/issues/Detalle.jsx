// Detalle.jsx — una issue entera: título y descripción editables, subtareas,
// el trabajo en el IDE (rama, PR, agente), la actividad con los comentarios y,
// a la derecha, sus propiedades.
import { useEffect, useRef, useState } from 'react';
import { useTeamStore } from '../../store/teamStore';
import { useIssuesStore } from '../../store/issuesStore';
import { TPanel, Cara, nombreDe } from '../../ui/Panel';
import { Casilla, Agente, Barra } from '../../ui/Marcas';
import { IconAgente, IconRama, IconClip, IconVolver } from '../../ui/icons';
import { IconX, IconPlus, IconTrash } from '../../../components/Icons';
import {
  SelEstado, SelPrioridad, SelPersona, SelEtiquetas, SelCiclo, SelIniciativa, SelEstimacion, SelFecha, SelAgente,
} from './Propiedades';
import { prioridadDe, ROLES_AGENTE, haceRato, fechaCorta, esCerrado, nombreEstimacion } from '../../lib/issues';
import { delegarAlOrquestador, abrirEnElIde, enTauri } from '../../lib/ide';

function Autotexto({ valor, onGuardar, className, placeholder, multilinea = false, etiqueta }) {
  const [texto, setTexto] = useState(valor || '');
  const ref = useRef(null);
  useEffect(() => { if (document.activeElement !== ref.current) setTexto(valor || ''); }, [valor]);
  useEffect(() => {
    if (!multilinea || !ref.current) return;
    ref.current.style.height = 'auto';
    ref.current.style.height = `${ref.current.scrollHeight}px`;
  }, [texto, multilinea]);
  const guardar = () => { if (texto.trim() !== (valor || '').trim()) onGuardar(texto); };
  const Tag = multilinea ? 'textarea' : 'input';
  return (
    <Tag
      ref={ref}
      className={className}
      value={texto}
      placeholder={placeholder}
      aria-label={etiqueta}
      rows={multilinea ? 3 : undefined}
      onChange={(e) => setTexto(e.target.value)}
      onBlur={guardar}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { setTexto(valor || ''); e.currentTarget.blur(); }
        if (e.key === 'Enter' && (!multilinea || e.ctrlKey || e.metaKey)) { e.preventDefault(); e.currentTarget.blur(); }
      }}
    />
  );
}

function frase(a, t) {
  const quien = (id) => nombreDe(t.gente[Number(id)]?.usuario) || 'alguien';
  const d = a.despues;
  switch (a.campo) {
    case 'creada': return 'creó la issue';
    case 'titulo': return `la renombró a «${d}»`;
    case 'descripcion': return 'editó la descripción';
    case 'estado_id': return <>la movió a <b>{t.estadosPorId[d]?.nombre || 'otro estado'}</b></>;
    case 'prioridad': return <>puso prioridad <b>{prioridadDe(Number(d)).nombre.toLowerCase()}</b></>;
    case 'asignado_id': return d ? <>se la asignó a <b>{quien(d)}</b></> : 'quitó la asignación';
    case 'agente_rol': return d ? <>la delegó al agente <b>{ROLES_AGENTE[d]?.nombre.toLowerCase() || d}</b></> : 'quitó el agente';
    case 'ciclo_id': return d ? <>la pasó al <b>ciclo {t.ciclosPorId[d]?.numero ?? ''}</b></> : 'la sacó del ciclo';
    case 'iniciativa_id': return d ? <>la metió en <b>{t.iniciativasPorId[d]?.nombre || 'un proyecto'}</b></> : 'la sacó del proyecto';
    case 'fecha_limite': return d ? <>puso fecha límite el <b>{fechaCorta(d)}</b></> : 'quitó la fecha límite';
    case 'estimacion': return d ? <>la estimó en <b>{nombreEstimacion(t.tablero.config?.estimacion, Number(d))}</b></> : 'quitó la estimación';
    case 'etiquetas': return 'cambió las etiquetas';
    case 'padre_id': return d ? 'la convirtió en subtarea' : 'la sacó de su issue padre';
    case 'vinculo': return <>vinculó <span className="mono">{String(d).replace(':', ' ')}</span></>;
    default: return `cambió ${a.campo}`;
  }
}

function Subtareas({ issue, t }) {
  const crear = useIssuesStore((s) => s.crear);
  const abrir = useIssuesStore((s) => s.abrir);
  const editar = useIssuesStore((s) => s.editar);
  const [nueva, setNueva] = useState('');
  const [anadiendo, setAnadiendo] = useState(false);
  const lista = issue.subtareas_lista || [];
  const hechas = lista.filter((x) => esCerrado(t.estadosPorId[x.estado_id])).length;
  const hecho = t.estados.find((e) => e.tipo === 'hecho');
  const pendiente = t.estados.find((e) => e.tipo === 'pendiente');
  const enviar = async (e) => {
    e.preventDefault();
    if (!nueva.trim()) return;
    await crear(t.proyectoId, { titulo: nueva.trim(), padre_id: issue.id, ciclo_id: issue.ciclo_id, iniciativa_id: issue.iniciativa_id });
    setNueva('');
  };
  return (
    <section className="tdet__sec" aria-label="Subtareas">
      <div className="tdet__seccab">
        <h2>Subtareas</h2>
        {lista.length > 0 && <><span className="tdim">{hechas} de {lista.length}</span><Barra pct={(hechas / lista.length) * 100} color="var(--info)" ancho={120} /></>}
        <span className="tfill" />
        <button className="tbtn tbtn--plano" onClick={() => setAnadiendo(true)}><IconPlus size={13} /> Añadir</button>
      </div>
      {lista.map((x) => {
        const e = t.estadosPorId[x.estado_id];
        const cerrada = esCerrado(e);
        return (
          <div key={x.id} className={`tsubt ${cerrada ? 'is-hecha' : ''}`}>
            <button className="tsubt__casilla" onClick={() => editar(x.id, { estado_id: cerrada ? pendiente?.id : hecho?.id })} aria-label={cerrada ? 'Reabrir' : 'Marcar como hecha'}>
              <Casilla estado={e} size={16} />
            </button>
            <button className="tsubt__abrir" onClick={() => abrir(x.id)}>
              <span className="mono tdim">{x.clave}</span>
              <span className="tsubt__titulo">{x.titulo}</span>
            </button>
            {t.gente[x.asignado_id] && <Cara usuario={t.gente[x.asignado_id].usuario} size={20} />}
          </div>
        );
      })}
      {anadiendo && (
        <form className="tsubt tsubt--nueva" onSubmit={enviar}>
          <Casilla estado={pendiente} size={16} />
          <input autoFocus value={nueva} onChange={(e) => setNueva(e.target.value)} onBlur={() => { if (!nueva.trim()) setAnadiendo(false); }} placeholder="Título de la subtarea · Enter para crear" aria-label="Nueva subtarea" />
        </form>
      )}
      {!lista.length && !anadiendo && <p className="tnota">Divide el trabajo en pasos; el avance se ve en la tarjeta.</p>}
    </section>
  );
}

function TrabajoIde({ issue, t }) {
  const editar = useIssuesStore((s) => s.editar);
  const [aviso, setAviso] = useState('');
  const vinculos = issue.vinculos_lista || [];
  const rol = ROLES_AGENTE[issue.agente_rol];
  const delegar = async () => {
    const fallo = await delegarAlOrquestador(issue, t);
    if (!fallo && !issue.agente_rol) editar(issue.id, { agente_rol: 'implementador' });
    setAviso(fallo || (enTauri() ? 'Enviada al orquestador del IDE.' : 'Copiada: pégala en el chat del IDE con /orquestar.'));
  };
  return (
    <section className="tdet__ide" aria-label="Trabajo en el IDE">
      <div className="tdet__idecab">
        <span className="tagente__ico is-grande"><IconAgente size={16} /></span>
        <span className="tdet__idetxt">
          <b>{rol ? `${rol.nombre} · ${rol.modelo}` : 'Sin agente'}</b>
          <span className="tdim">{rol ? 'Trabaja esta issue desde el orquestador del IDE.' : 'Delega la issue y un agente del orquestador la trabaja en su propia rama.'}</span>
        </span>
        <span className="tfill" />
        <button className="btn btn--ghost btn--sm" onClick={() => abrirEnElIde(issue)}>Abrir en el IDE</button>
        <button className="btn btn--acento btn--sm" onClick={delegar}><IconAgente size={13} /> Delegar al orquestador</button>
      </div>
      {vinculos.length > 0 && (
        <div className="tdet__vinculos">
          {vinculos.map((v) => (
            <span key={v.id} className="tvinc">
              {v.tipo === 'rama' ? <IconRama size={13} /> : <IconClip size={13} />}
              <span className="mono">{v.tipo === 'pr' ? `PR ${v.ref}` : v.ref}</span>
              {v.estado && <span className={`tpr is-${v.estado}`}>{v.estado}</span>}
            </span>
          ))}
        </div>
      )}
      {aviso && <p className="tnota">{aviso}</p>}
    </section>
  );
}

function Actividad({ issue, t }) {
  const comentar = useIssuesStore((s) => s.comentar);
  const borrarComentario = useIssuesStore((s) => s.borrarComentario);
  const yo = t.usuario?.id;
  const [texto, setTexto] = useState('');
  const [error, setError] = useState('');
  const items = [
    ...(issue.actividad || []).map((a) => ({ tipo: 'act', en: a.en, a })),
    ...(issue.comentarios_lista || []).map((c) => ({ tipo: 'com', en: c.creado_en, c })),
  ].sort((x, y) => x.en.localeCompare(y.en));
  const enviar = async (e) => {
    e.preventDefault();
    if (!texto.trim()) return;
    const fallo = await comentar(issue.id, texto.trim());
    if (fallo) setError(fallo);
    else { setTexto(''); setError(''); }
  };
  return (
    <section className="tdet__sec" aria-label="Actividad">
      <div className="tdet__seccab"><h2>Actividad</h2></div>
      <div className="tact">
        {items.map((it) => {
          if (it.tipo === 'act') {
            const m = t.gente[it.a.actor_id];
            return (
              <div key={`a${it.a.id}`} className="tact__linea">
                <span className="tcuadro" style={{ background: it.a.campo === 'estado_id' ? t.estadosPorId[it.a.despues]?.color || 'var(--ink-35)' : 'var(--ink-35)' }} />
                <span><b className="tact__quien">{m ? nombreDe(m.usuario) : 'Lixbon'}</b> {frase(it.a, t)} · {haceRato(it.a.en)}</span>
              </div>
            );
          }
          const c = it.c;
          const m = t.gente[c.autor_id];
          return (
            <div key={c.id} className={`tcom ${c.de_agente ? 'is-agente' : ''}`}>
              {c.de_agente
                ? <span className="tagente__ico is-grande"><IconAgente size={15} /></span>
                : <Cara usuario={m?.usuario} size={26} />}
              <div className="tcom__cuerpo">
                <span className="tcom__cab">
                  <b>{c.de_agente ? ROLES_AGENTE[c.de_agente]?.nombre || 'Agente' : nombreDe(m?.usuario)}</b>
                  {c.de_agente && <Agente rol={c.de_agente} corto />}
                  <span className="tdim">· {haceRato(c.creado_en)}</span>
                  {c.autor_id === yo && <button className="ic tcom__borrar" onClick={() => borrarComentario(c.id)} aria-label="Borrar comentario"><IconX size={12} /></button>}
                </span>
                <span className="tcom__texto">{c.texto}</span>
              </div>
            </div>
          );
        })}
      </div>
      <form className="tcomponer" onSubmit={enviar}>
        <textarea value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Escribe un comentario…" aria-label="Comentario"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) enviar(e); }} rows={2} />
        <div className="tcomponer__pie">
          <span className="tdim">Ctrl Enter para enviar</span>
          <span className="tfill" />
          <button className="btn btn--sm" type="submit" disabled={!texto.trim()}>Comentar</button>
        </div>
        {error && <p className="terror">{error}</p>}
      </form>
    </section>
  );
}

function Prop({ nombre, children }) {
  return <div className="tprop"><span className="tprop__nombre">{nombre}</span>{children}</div>;
}

export function DetalleIssue({ t }) {
  const { abierta: issue, cargandoAbierta, errorAbierta, cerrar, editar, borrar, abrir } = useIssuesStore();
  const [confirmar, setConfirmar] = useState(false);
  const cambiar = (campo) => (v) => editar(issue.id, { [campo]: v });

  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !e.target.closest('input, textarea')) cerrar(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [cerrar]);

  if (!issue) {
    return (
      <TPanel id="issue" className="wb__grow">
        <p className="testado">{errorAbierta || (cargandoAbierta ? 'Abriendo la issue…' : '')}</p>
        {errorAbierta && <button className="btn btn--ghost" onClick={cerrar}>Volver</button>}
      </TPanel>
    );
  }
  const estado = t.estadosPorId[issue.estado_id];
  const padre = issue.padre_id ? t.issues.find((x) => x.id === issue.padre_id) : null;
  const creador = t.gente[issue.creado_por];

  return (
    <>
      <TPanel id="issue" className="wb__grow tdet">
        <div className="tdet__barra">
          <button className="ic" onClick={cerrar} aria-label="Volver a las issues"><IconVolver size={15} /></button>
          <nav className="tdet__ruta" aria-label="Ruta">
            <span className="tproy">{t.tablero.prefijo}</span>
            <span>{t.proyecto.nombre}</span><span className="tdim">/</span>
            {padre && <><button className="tlink" onClick={() => abrir(padre.id)}>{padre.clave}</button><span className="tdim">/</span></>}
            <span className="mono">{issue.clave}</span>
          </nav>
          <span className="tfill" />
          <button className="ic" onClick={() => navigator.clipboard?.writeText(`${issue.clave} ${issue.titulo}`)} title="Copiar clave y título" aria-label="Copiar clave y título"><IconClip size={15} /></button>
          {confirmar ? (
            <span className="tdet__confirmar">
              ¿Borrar {issue.clave}?
              <button className="btn btn--sm btn--danger" onClick={async () => { await borrar(issue.id); }}>Borrar</button>
              <button className="btn btn--sm btn--ghost" onClick={() => setConfirmar(false)}>No</button>
            </span>
          ) : (
            <button className="ic" onClick={() => setConfirmar(true)} aria-label="Borrar issue"><IconTrash size={15} /></button>
          )}
        </div>
        <div className="tdet__scroll">
          <div className="tdet__col">
            <Autotexto className="tdet__titulo" valor={issue.titulo} onGuardar={(v) => v.trim() && editar(issue.id, { titulo: v.trim() })} etiqueta="Título" />
            <Autotexto className="tdet__desc" multilinea valor={issue.descripcion} onGuardar={(v) => editar(issue.id, { descripcion: v })}
              placeholder="Añade una descripción: contexto, qué hay que hacer y cómo saber que está hecho." etiqueta="Descripción" />
            <Subtareas issue={issue} t={t} />
            <TrabajoIde issue={issue} t={t} />
            <Actividad issue={issue} t={t} />
          </div>
        </div>
      </TPanel>
      <TPanel id="propiedades" as="aside" className="tpropiedades" aria-label="Propiedades">
        <div className="tidx__sec">PROPIEDADES</div>
        <Prop nombre="Estado"><SelEstado t={t} valor={issue.estado_id} onCambio={cambiar('estado_id')} /></Prop>
        <Prop nombre="Prioridad"><SelPrioridad valor={issue.prioridad} onCambio={cambiar('prioridad')} /></Prop>
        <Prop nombre="Asignada a"><SelPersona t={t} valor={issue.asignado_id} onCambio={cambiar('asignado_id')} /></Prop>
        <Prop nombre="Agente"><SelAgente valor={issue.agente_rol} onCambio={cambiar('agente_rol')} /></Prop>
        <Prop nombre="Etiquetas"><SelEtiquetas t={t} valor={issue.etiquetas} onCambio={cambiar('etiquetas')} /></Prop>
        <Prop nombre="Ciclo"><SelCiclo t={t} valor={issue.ciclo_id} onCambio={cambiar('ciclo_id')} /></Prop>
        <Prop nombre="Proyecto"><SelIniciativa t={t} valor={issue.iniciativa_id} onCambio={cambiar('iniciativa_id')} /></Prop>
        <Prop nombre="Estimación"><SelEstimacion t={t} valor={issue.estimacion} onCambio={cambiar('estimacion')} /></Prop>
        <Prop nombre="Fecha límite"><SelFecha valor={issue.fecha_limite} cerrada={esCerrado(estado)} onCambio={cambiar('fecha_limite')} /></Prop>
        <span className="tfill" />
        <p className="tnota tprop__pie">
          Creada {haceRato(issue.creado_en)}{creador ? ` por ${nombreDe(creador.usuario)}` : ''}<br />
          Actualizada {haceRato(issue.actualizado_en)}
        </p>
      </TPanel>
    </>
  );
}
