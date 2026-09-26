// Adjunto.jsx — imágenes, vídeos, notas de voz y archivos dentro de un mensaje.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { openExternal } from '../../lib/tauri';
import { renovarUrl, formatDuracion } from '../lib/adjuntos';
import { useTeamStore } from '../store/teamStore';
import { IconDownload, IconFile, IconWarn, IconPlay, IconX } from '../../components/Icons';
import { IconPause, IconMic } from '../ui/icons';

const ANCHO_MAX = 380;
const ALTO_MAX = 300;
const BARRAS = 34;

export const peso = (bytes) => {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
};

// Reserva el hueco con la proporción real para que el hilo no salte al cargar,
// sin ampliar nunca una imagen pequeña.
function encaje(ancho, alto) {
  if (!ancho || !alto) return { maxWidth: ANCHO_MAX };
  const escala = Math.min(ANCHO_MAX / ancho, ALTO_MAX / alto, 1);
  return { width: Math.round(ancho * escala), aspectRatio: `${ancho} / ${alto}` };
}

// Las URLs firmadas caducan: se pide una nueva una sola vez.
function useUrl(adjunto) {
  const [url, setUrl] = useState(adjunto.url);
  const renovado = useRef(false);
  useEffect(() => { setUrl(adjunto.url); renovado.current = false; }, [adjunto.url]);
  const fallo = async () => {
    if (renovado.current) return false;
    renovado.current = true;
    try {
      setUrl((await renovarUrl(adjunto.id, useTeamStore.getState().llave)).url);
      return true;
    } catch {
      return false;
    }
  };
  return { url, fallo };
}

export const useVisor = create((set) => ({
  abierto: null,
  ver: (adjunto) => set({ abierto: adjunto }),
  cerrar: () => set({ abierto: null }),
}));

export function Visor() {
  const { abierto, cerrar } = useVisor();
  useEffect(() => {
    if (!abierto) return undefined;
    const alPulsar = (e) => { if (e.key === 'Escape') cerrar(); };
    window.addEventListener('keydown', alPulsar);
    return () => window.removeEventListener('keydown', alPulsar);
  }, [abierto, cerrar]);
  if (!abierto) return null;
  // Al body: dentro del panel del IDE un ancestro con transform encierra el position: fixed.
  return createPortal(
    <div className="tvisor" onClick={cerrar} role="presentation">
      <div className="tvisor__barra" onClick={(e) => e.stopPropagation()} role="presentation">
        <span className="tvisor__nombre">{abierto.nombre}</span>
        <button className="ic" onClick={() => openExternal(abierto.url)} aria-label="Abrir en el navegador"><IconDownload size={15} /></button>
        <button className="ic" onClick={cerrar} aria-label="Cerrar (Esc)"><IconX size={15} /></button>
      </div>
      <div className="tvisor__hueco" onClick={(e) => e.stopPropagation()} role="presentation">
        {abierto.tipo === 'video'
          ? <video className="tvisor__medio" src={abierto.url} controls autoPlay />
          : <img className="tvisor__medio" src={abierto.url} alt={abierto.nombre} />}
      </div>
    </div>,
    document.body,
  );
}

function Imagen({ adjunto, compacto }) {
  const { url, fallo } = useUrl(adjunto);
  const ver = useVisor((s) => s.ver);
  const [roto, setRoto] = useState(false);
  if (roto) return <Fila adjunto={adjunto} nota="No se pudo cargar la imagen. Ábrela fuera." />;
  return (
    <button className="tadj tadj--imagen" style={compacto ? undefined : encaje(adjunto.ancho, adjunto.alto)} onClick={() => ver({ ...adjunto, url })} title={adjunto.nombre}>
      <img src={url} alt={adjunto.nombre} loading="lazy" onError={async () => { if (!(await fallo())) setRoto(true); }} />
    </button>
  );
}

function Video({ adjunto, compacto }) {
  const { url, fallo } = useUrl(adjunto);
  const [roto, setRoto] = useState(false);
  if (roto) return <Fila adjunto={adjunto} nota="No se puede reproducir aquí. Ábrelo fuera." />;
  return (
    <div className="tadj tadj--video" style={compacto ? undefined : encaje(adjunto.ancho, adjunto.alto)}>
      <video src={url} controls preload="metadata" onError={async () => { if (!(await fallo())) setRoto(true); }} />
    </div>
  );
}

// Onda determinista a partir del id: cada nota se reconoce y no cambia al repintar.
function ondaDe(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return Array.from({ length: BARRAS }, (_, i) => {
    h = (h * 1103515245 + 12345) >>> 0;
    const envolvente = Math.sin((i / (BARRAS - 1)) * Math.PI) * 0.6 + 0.4;
    return Math.round((4 + (h % 18)) * envolvente + 3);
  });
}

function Audio({ adjunto }) {
  const { url, fallo } = useUrl(adjunto);
  const ref = useRef(null);
  const [sonando, setSonando] = useState(false);
  const [va, setVa] = useState(0);
  const [total, setTotal] = useState(adjunto.duracion_ms ? adjunto.duracion_ms / 1000 : 0);
  const [roto, setRoto] = useState(false);
  const [onda] = useState(() => ondaDe(adjunto.id));
  if (roto) return <Fila adjunto={adjunto} nota="No se puede reproducir aquí. Ábrelo fuera." />;

  const alternar = () => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => setRoto(true));
    else el.pause();
  };
  const saltar = (e) => {
    const el = ref.current;
    if (!el || !total) return;
    const caja = e.currentTarget.getBoundingClientRect();
    el.currentTime = ((e.clientX - caja.left) / caja.width) * total;
  };
  const parte = total ? Math.min(1, va / total) : 0;
  const esNota = /^nota-de-voz-/i.test(String(adjunto.nombre || ''));

  return (
    <div className="tadj tadj--audio">
      <audio
        ref={ref}
        src={url}
        preload="metadata"
        onPlay={() => setSonando(true)}
        onPause={() => setSonando(false)}
        onEnded={() => { setSonando(false); setVa(0); }}
        onTimeUpdate={(e) => setVa(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d) && d > 0) setTotal(d); }}
        onError={async () => { if (!(await fallo())) setRoto(true); }}
      >
        <track kind="captions" />
      </audio>
      <button className="tadj__play" onClick={alternar} aria-label={sonando ? 'Pausar' : 'Reproducir'}>
        {sonando ? <IconPause size={13} /> : <IconPlay size={13} />}
      </button>
      <button className="tadj__onda" onClick={saltar} aria-label={esNota ? 'Nota de voz' : adjunto.nombre}>
        {onda.map((h, i) => (
          <span key={i} style={{ height: h, background: i / BARRAS < parte ? 'var(--accent)' : 'var(--surface-6)' }} />
        ))}
      </button>
      <span className="tadj__reloj mono">{formatDuracion((sonando || va ? va : total) * 1000)}</span>
      {!esNota && <span className="tadj__audio-nombre"><IconMic size={11} />{adjunto.nombre}</span>}
    </div>
  );
}

function Fila({ adjunto, nota }) {
  const { url } = useUrl(adjunto);
  return (
    <button className={`tadj tadj--archivo ${nota ? 'is-mal' : ''}`} onClick={() => openExternal(url)} title={`Abrir ${adjunto.nombre}`}>
      <span className="tadj__icono">{nota ? <IconWarn size={15} /> : <IconFile size={15} />}</span>
      <span className="tadj__texto">
        <span className="tadj__nombre">{adjunto.nombre}</span>
        <span className="tadj__dato mono">{nota || peso(adjunto.bytes)}</span>
      </span>
      <IconDownload size={14} />
    </button>
  );
}

export function Adjunto({ adjunto, compacto = false }) {
  if (adjunto.tipo === 'imagen') return <Imagen adjunto={adjunto} compacto={compacto} />;
  if (adjunto.tipo === 'video') return <Video adjunto={adjunto} compacto={compacto} />;
  if (adjunto.tipo === 'audio') return <Audio adjunto={adjunto} />;
  return <Fila adjunto={adjunto} />;
}
