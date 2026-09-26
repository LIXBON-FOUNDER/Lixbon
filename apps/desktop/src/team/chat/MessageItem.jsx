// MessageItem.jsx — un mensaje. El nombre de quien habla ocupa el canalón,
// el mismo hueco donde el editor pone el número de línea.
import { Fragment, useEffect, useRef, useState } from 'react';
import { openExternal } from '../../lib/tauri';
import { useMensajesStore } from '../store/mensajesStore';
import { useTeamStore } from '../store/teamStore';
import { Adjunto } from './Adjunto';
import { hace } from '../lib/tiempo';
import { Cara, nombreDe, tintaDe } from '../ui/Panel';
import { IconPencil, IconTrash } from '../../components/Icons';
import { IconReply } from '../ui/icons';

const ENLACE = /(https?:\/\/[^\s<>"']+)/g;

export const hora = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

// Sin dangerouslySetInnerHTML: cada trozo entra como texto y React lo escapa.
function enLinea(texto, base) {
  return String(texto).split(/(`[^`\n]+`)/g).flatMap((parte, i) => {
    if (/^`[^`\n]+`$/.test(parte)) return [<code key={`${base}c${i}`} className="tmsg__code">{parte.slice(1, -1)}</code>];
    return parte.split(ENLACE).map((t, j) => (j % 2 === 1
      ? <button key={`${base}l${i}.${j}`} className="tmsg__enlace" onClick={() => openExternal(t)} title={t}>{t}</button>
      : <Fragment key={`${base}t${i}.${j}`}>{t}</Fragment>));
  });
}

function Texto({ texto }) {
  const bloques = String(texto).split(/```[\w-]*\n?([\s\S]*?)```/g);
  return bloques.map((b, i) => (i % 2 === 1
    ? <pre key={i} className="tmsg__pre mono">{b.replace(/\n$/, '')}</pre>
    : b.trim() ? <p key={i} className="tmsg__texto">{enLinea(b.replace(/^\n|\n$/g, ''), i)}</p> : null));
}

const enRejilla = (adjuntos) => adjuntos.length > 1 && adjuntos.every((a) => a.tipo === 'imagen' || a.tipo === 'video');

function Editor({ inicial, onGuardar, onCancelar }) {
  const [texto, setTexto] = useState(inicial);
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);
  return (
    <div className="tmsg__editor">
      <textarea
        ref={ref}
        value={texto}
        rows={1}
        onChange={(e) => { setTexto(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`; }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onGuardar(texto); }
          if (e.key === 'Escape') { e.preventDefault(); onCancelar(); }
        }}
        aria-label="Editar el mensaje"
      />
      <div className="tmsg__editor-pie">
        <button className="btn btn--primary btn--sm" onClick={() => onGuardar(texto)}>Guardar</button>
        <button className="lk" onClick={onCancelar}>Cancelar</button>
        <span className="mono">Enter guarda · Esc cancela</span>
      </div>
    </div>
  );
}

function BarraHilo({ mensaje, nuevas, abierta, onAbrir }) {
  const quien = useTeamStore((s) => s.quien);
  const caras = (mensaje.respondientes || []).map(quien).filter(Boolean).slice(0, 3);
  return (
    <button className={`thilobar ${abierta ? 'is-on' : ''}`} onClick={onAbrir}>
      <span className="thilobar__caras">{caras.map((u) => <Cara key={u.id} usuario={u} size={18} />)}</span>
      <span className="thilobar__n">{mensaje.respuestas === 1 ? '1 respuesta' : `${mensaje.respuestas} respuestas`}</span>
      {nuevas > 0 && <span className="thilobar__nuevo">{nuevas} nuevas</span>}
      {mensaje.ultima_respuesta_en && <span className="thilobar__cuando">última {hace(mensaje.ultima_respuesta_en)}</span>}
    </button>
  );
}

export function MessageItem({ mensaje, autor, propio, seguido, enHilo = false, compacto = false }) {
  const reintentar = useMensajesStore((s) => s.reintentar);
  const editarMsg = useMensajesStore((s) => s.editar);
  const borrarMsg = useMensajesStore((s) => s.borrar);
  const abrirHilo = useTeamStore((s) => s.abrirHilo);
  const hiloId = useTeamStore((s) => s.hiloId);
  const nuevas = useTeamStore((s) => s.hilosNuevos[mensaje.id] || 0);
  const [editando, setEditando] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [queja, setQueja] = useState('');

  const borrado = Boolean(mensaje.borrado_en);
  const firme = !mensaje.pendiente && !borrado;
  const mio = propio && firme;
  const tieneHilo = !enHilo && !mensaje.responde_a && mensaje.respuestas > 0;
  const nombre = propio ? 'Tú' : nombreDe(autor);

  const intentar = async (fn) => {
    setQueja('');
    try { await fn(); } catch (e) { setQueja(e.message); }
  };

  const clases = [
    'tmsg', seguido && 'is-seguido', mensaje.pendiente && 'is-pendiente', mensaje.fallido && 'is-fallido',
    borrado && 'is-borrado', mensaje.borrandose && 'is-yendose', hiloId === mensaje.id && !enHilo && 'is-en-hilo',
    (enHilo || compacto) && 'tmsg--apilado',
  ].filter(Boolean).join(' ');

  const cabecera = (enHilo || compacto)
    ? !seguido && (
      <div className="tmsg__cab">
        <span className="tmsg__autor" style={{ color: tintaDe(mensaje.autor_id, propio) }}>{nombre}</span>
        <time className="mono" dateTime={mensaje.creado_en}>{hora(mensaje.creado_en)}</time>
      </div>
    )
    : (
      <div className="tmsg__canalon">
        {!seguido && <span className="tmsg__autor" style={{ color: tintaDe(mensaje.autor_id, propio) }} title={nombreDe(autor)}>{nombre}</span>}
        <time className="mono" dateTime={mensaje.creado_en}>{hora(mensaje.creado_en)}</time>
      </div>
    );

  return (
    <article className={clases}>
      {cabecera}
      <div className="tmsg__cuerpo">
        {borrado ? (
          <p className="tmsg__lapida">Mensaje borrado por su autor.</p>
        ) : editando ? (
          <Editor inicial={mensaje.texto} onCancelar={() => setEditando(false)} onGuardar={(t) => { setEditando(false); intentar(() => editarMsg(mensaje.canal_id, mensaje.id, t)); }} />
        ) : (
          <>
            {mensaje.texto && <Texto texto={mensaje.texto} />}
            {mensaje.editado_en && <span className="tmsg__editado" title={`Editado ${hace(mensaje.editado_en)}`}>(editado)</span>}
            {mensaje.adjuntos?.length > 0 && (
              <div className={`tmsg__adjuntos ${enRejilla(mensaje.adjuntos) ? 'is-rejilla' : ''}`}>
                {mensaje.adjuntos.map((a) => <Adjunto key={a.id} adjunto={a} compacto={enRejilla(mensaje.adjuntos)} />)}
              </div>
            )}
          </>
        )}
        {tieneHilo && <BarraHilo mensaje={mensaje} nuevas={nuevas} abierta={hiloId === mensaje.id} onAbrir={() => abrirHilo(mensaje.id)} />}
        {confirmando && (
          <div className="tmsg__seguro">
            <span>¿Borrar este mensaje?{tieneHilo ? ` Sus ${mensaje.respuestas} respuestas se quedan.` : ''}</span>
            <button className="btn btn--sm tmsg__borrar" onClick={() => { setConfirmando(false); intentar(() => borrarMsg(mensaje.canal_id, mensaje.id)); }}>Borrar</button>
            <button className="lk" onClick={() => setConfirmando(false)}>Cancelar</button>
          </div>
        )}
        {queja && <p className="tmsg__fallo">{queja} <button className="lk" onClick={() => setQueja('')}>Vale</button></p>}
        {mensaje.fallido && (
          <p className="tmsg__fallo">No se pudo enviar. <button className="lk" onClick={() => reintentar(mensaje.canal_id, mensaje.client_id)}>Reintentar</button></p>
        )}
      </div>
      {firme && !editando && !confirmando && (
        <div className="tmsg__acciones">
          {!enHilo && !mensaje.responde_a && (
            <button className="ic" onClick={() => abrirHilo(mensaje.id)} aria-label="Responder en un hilo"><IconReply size={14} /></button>
          )}
          {mio && <button className="ic" onClick={() => setEditando(true)} aria-label="Editar"><IconPencil size={14} /></button>}
          {mio && <button className="ic tmsg__malo" onClick={() => setConfirmando(true)} aria-label="Borrar"><IconTrash size={14} /></button>}
        </div>
      )}
    </article>
  );
}
