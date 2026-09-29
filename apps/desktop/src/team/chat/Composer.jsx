// Composer.jsx — escribir en un canal o en un hilo: texto, adjuntos y notas de voz.
// El borrador vive en borradorStore para que una subida sobreviva al cambio de canal.
import { useEffect, useRef, useState } from 'react';
import { useTeamStore } from '../store/teamStore';
import { useMensajesStore } from '../store/mensajesStore';
import { useBorradorStore } from '../store/borradorStore';
import { grabar, sePuedeGrabar, MAX_MS } from '../lib/grabadora';
import { formatDuracion } from '../lib/adjuntos';
import { peso } from './Adjunto';
import { nombreDe } from '../ui/Panel';
import { IconClip, IconX, IconTrash, IconCheck, IconFile, IconWarn, IconArrowUp } from '../../components/Icons';
import { IconMic, IconVideo } from '../ui/icons';

const ALTO_MAX = 160;
const BARRAS = 28;

function Tira({ clave, piezas }) {
  const quitar = useBorradorStore((s) => s.quitar);
  return (
    <div className="ttira">
      {piezas.map((p) => (
        <div key={p.localId} className={`ttira__pieza ${p.error ? 'is-mal' : ''}`} title={p.nombre}>
          {p.vista && p.tipo === 'imagen' ? <img className="ttira__vista" src={p.vista} alt="" />
            : p.vista && p.tipo === 'video' ? <video className="ttira__vista" src={p.vista} muted preload="metadata" />
              : <span className="ttira__marca">{p.esVoz ? <IconMic size={15} /> : p.tipo === 'video' ? <IconVideo size={15} /> : <IconFile size={15} />}</span>}
          <span className="ttira__texto">
            <span className="ttira__nombre">{p.esVoz ? 'Nota de voz' : p.nombre}</span>
            <span className="ttira__dato mono">
              {p.error ? <><IconWarn size={11} /> {p.error}</> : p.esVoz && p.duracionLocal ? formatDuracion(p.duracionLocal) : peso(p.bytes)}
            </span>
          </span>
          {p.subiendo && <span className="ttira__barra"><span style={{ width: `${Math.round(p.progreso * 100)}%` }} /></span>}
          <button className="ic" onClick={() => quitar(clave, p.localId)} aria-label={p.subiendo ? 'Cancelar la subida' : 'Quitar'}><IconX size={12} /></button>
        </div>
      ))}
    </div>
  );
}

export function Composer({ canal, desconectado, hiloDe = null, compacto = false }) {
  const usuario = useTeamStore((s) => s.usuario);
  const avisarEscribiendo = useTeamStore((s) => s.avisarEscribiendo);
  const enviar = useMensajesStore((s) => s.enviar);
  const clave = hiloDe ? `hilo:${hiloDe}` : canal.id;
  const borrador = useBorradorStore((s) => s.porCanal[clave]);
  const { escribir, añadir, listoParaEnviar, vaciar, añadirVoz } = useBorradorStore.getState();
  const texto = borrador?.texto || '';
  const piezas = borrador?.adjuntos || [];

  const [quejas, setQuejas] = useState([]);
  const [grabando, setGrabando] = useState(false);
  const [va, setVa] = useState(0);
  const [onda, setOnda] = useState(() => new Array(BARRAS).fill(0));
  const campoRef = useRef(null);
  const archivosRef = useRef(null);
  const mandosRef = useRef(null);

  useEffect(() => { campoRef.current?.focus(); }, [clave]);
  useEffect(() => {
    const el = campoRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, ALTO_MAX)}px`;
  }, [texto, clave]);
  useEffect(() => () => mandosRef.current?.cancelar(), []);

  const puedeMandar = listoParaEnviar(clave) && !grabando;
  const subiendo = piezas.some((p) => p.subiendo);

  const mandar = () => {
    if (!puedeMandar) return;
    enviar(canal.id, texto, usuario?.id, piezas.filter((p) => p.adjunto).map((p) => p.adjunto), hiloDe);
    vaciar(clave);
    setQuejas([]);
  };

  const meter = async (archivos) => setQuejas(await añadir(clave, archivos, canal.id));

  const empezarGrabar = async () => {
    setQuejas([]);
    try {
      mandosRef.current = await grabar({
        onTiempo: setVa,
        onNivel: (n) => setOnda((prev) => [...prev.slice(1), n]),
        onTope: () => setQuejas([`Una nota de voz dura como mucho ${formatDuracion(MAX_MS)}.`]),
      });
      setVa(0);
      setOnda(new Array(BARRAS).fill(0));
      setGrabando(true);
    } catch (e) {
      setQuejas([e.message]);
    }
  };
  const soltar = () => { mandosRef.current = null; setGrabando(false); setVa(0); };
  const pararGrabar = async () => {
    const mandos = mandosRef.current;
    if (!mandos) return;
    const { file, duracion_ms } = await mandos.parar();
    soltar();
    if (duracion_ms >= 500) añadirVoz(clave, file, duracion_ms, canal.id);
  };
  const tirarGrabacion = () => { mandosRef.current?.cancelar(); soltar(); };

  const destino = hiloDe ? 'Responder en el hilo' : canal.tipo === 'directo' ? `Escribe a ${nombreDe(canal.con)}` : `Escribe a #${canal.nombre}`;

  return (
    <div className={`tcomposer ${compacto ? 'is-compacto' : ''}`}>
      <div className="tcomposer__caja">
        {piezas.length > 0 && <Tira clave={clave} piezas={piezas} />}
        {quejas.length > 0 && (
          <div className="tcomposer__quejas">
            <div>{quejas.map((q) => <p key={q}>{q}</p>)}</div>
            <button className="ic" onClick={() => setQuejas([])} aria-label="Descartar"><IconX size={13} /></button>
          </div>
        )}
        {grabando ? (
          <div className="tgrabando">
            <span className="tgrabando__punto" />
            <span className="mono">{formatDuracion(va)}</span>
            <div className="tgrabando__onda">
              {onda.map((n, i) => <span key={i} style={{ height: `${Math.max(12, Math.round(n * 100))}%` }} />)}
            </div>
            <button className="ic" onClick={tirarGrabacion} aria-label="Descartar la nota"><IconTrash size={15} /></button>
            <button className="tcomposer__enviar" onClick={pararGrabar} aria-label="Añadir la nota"><IconCheck size={14} /></button>
          </div>
        ) : (
          <>
            <textarea
              ref={campoRef}
              className="tcomposer__campo"
              value={texto}
              rows={compacto ? 1 : 2}
              placeholder={destino}
              aria-label={destino}
              spellCheck
              onChange={(e) => { escribir(clave, e.target.value); if (e.target.value.trim()) avisarEscribiendo(canal.id); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); mandar(); } }}
              onPaste={(e) => {
                const archivos = Array.from(e.clipboardData?.files || []);
                if (archivos.length) { e.preventDefault(); meter(archivos); }
              }}
            />
            <div className="tcomposer__barra">
              <input ref={archivosRef} type="file" multiple hidden onChange={(e) => { meter(e.target.files); e.target.value = ''; }} />
              <button className="ic" onClick={() => archivosRef.current?.click()} aria-label="Adjuntar archivos"><IconClip size={14} /></button>
              {sePuedeGrabar() && <button className="ic" onClick={empezarGrabar} aria-label="Grabar una nota de voz"><IconMic size={14} /></button>}
              <div className="tcomposer__fill" />
              {desconectado
                ? <span className="tcomposer__nota">Sin conexión: se enviará al volver</span>
                : !compacto && <span className="tcomposer__nota mono">Enter envía · Mayús Enter salto</span>}
              <button className="tcomposer__enviar" onClick={mandar} disabled={!puedeMandar} aria-label={subiendo ? 'Esperando a que terminen las subidas' : 'Enviar'}>
                <IconArrowUp size={14} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
