import { createContext, useContext, useState } from 'react';
import { Icono, IconDownload } from './Icons';
import { Rombos } from './Pulido';
import { construirArchivo, descargarBlob, fmtBytes, parseFileLang } from '../lib/archivos';
import { crearZip } from '../lib/zip';
import { useT } from '../i18n/useT';

// Cada tipo con su color y su icono: se reconoce de un vistazo.
const TIPO = {
  pdf: ['#D9534F', 'docs'], docx: ['#3D7BE0', 'texto'], xlsx: ['#2E9E5B', 'archivo-tabla'],
  pptx: ['#E07B39', 'tablero'], csv: ['#3AA17E', 'archivo-tabla'], md: ['#6B7280', 'archivo-markdown'],
  txt: ['#7C7C7C', 'texto'], html: ['#C9643B', 'navegador'], svg: ['#B0579E', 'paleta'],
  json: ['#5B6EE1', 'archivo-codigo'], ics: ['#D2553F', 'calendario'], vcf: ['#2B8DB3', 'usuario'],
  epub: ['#7A5BB5', 'libro'], zip: ['#8C7A4B', 'comprimir'],
};
const CODIGO = ['#C9A227', 'codigo'];

export function tipoDe(ext) {
  return TIPO[ext] || CODIGO;
}

/** El tile del documento: color del tipo, icono y la extensión abajo. */
export function DocTile({ ext, size = 'm' }) {
  const [color, icono] = tipoDe(ext);
  return (
    <span className={`doc-tile doc-tile--${size}`} style={{ '--c': color }} aria-hidden="true">
      <Icono nombre={icono} size={size === 's' ? 12 : 14} />
      {size !== 's' && <b>{(ext || 'txt').slice(0, 4).toUpperCase()}</b>}
    </span>
  );
}

// Con este contexto, «Abrir» lleva el archivo al panel de la derecha del chat;
// sin él (p. ej. una conversación compartida) el contenido se despliega aquí.
export const AbrirArchivo = createContext(null);

export async function descargarArchivo(info, contenido) {
  descargarBlob(await construirArchivo(info, contenido), info.name);
}

const contar = (re, s) => (s.match(re) || []).length;

/** Lo que se dice del archivo, en palabras: páginas, pestañas, diapositivas… */
function datosDe(t, info, contenido) {
  const tam = fmtBytes(new Blob([contenido]).size);
  const tipo = t(`fileKind.${info.ext}`) !== `fileKind.${info.ext}` ? t(`fileKind.${info.ext}`) : info.label;
  switch (info.ext) {
    case 'pdf':
    case 'docx': {
      const n = Math.max(1, Math.ceil(contenido.length / 2800));
      return [tipo, t(n === 1 ? 'onePage' : 'nPages', { n })];
    }
    case 'pptx': {
      const n = Math.max(1, contar(/^## /gm, contenido));
      return [tipo, t(n === 1 ? 'oneSlide' : 'nSlides', { n })];
    }
    case 'xlsx': {
      const n = Math.max(1, contar(/^## /gm, contenido));
      return [tipo, t(n === 1 ? 'oneSheet' : 'nSheets', { n })];
    }
    case 'csv': {
      const n = Math.max(0, contenido.trim().split('\n').length - 1);
      return [tipo, t('nRows', { n }), tam];
    }
    default:
      return [tipo, tam];
  }
}

export function FileCard({ info, contenido, streaming }) {
  const t = useT('chat');
  const [abierto, setAbierto] = useState(false);
  const [estado, setEstado] = useState('');
  const abrirEnPanel = useContext(AbrirArchivo);

  const descargar = async () => {
    setEstado('preparando');
    try {
      await descargarArchivo(info, contenido);
      setEstado('');
    } catch (err) {
      console.error('[archivo] no se pudo construir', err);
      setEstado('error');
    }
  };

  // Mientras se escribe: el tile en gris con un brillo, lo que lleva hasta
  // ahora y los rombos. Sin porcentaje inventado: no se sabe cuánto falta.
  if (streaming) {
    const [, detalle] = datosDe(t, info, contenido);
    return (
      <div className="filecard is-creando" role="status">
        <div className="filecard__head">
          <span className="doc-tile doc-tile--m is-creando" aria-hidden="true"><b>{(info.ext || 'txt').slice(0, 4).toUpperCase()}</b></span>
          <div className="filecard__meta">
            <span className="filecard__name">{info.name}</span>
            <span className="filecard__info">{t('fileWriting', { detalle })}</span>
          </div>
          <Rombos className="filecard__rombos" />
        </div>
      </div>
    );
  }

  return (
    <div className="filecard">
      <div className="filecard__head">
        <DocTile ext={info.ext} />
        <div className="filecard__meta">
          <span className="filecard__name">{info.name}</span>
          <span className={`filecard__info ${estado === 'error' ? 'is-error' : ''}`}>
            {estado === 'error' ? t('fileError') : datosDe(t, info, contenido).join(' · ')}
          </span>
        </div>
        {abrirEnPanel ? (
          <button className="filecard__abrir" onClick={() => abrirEnPanel({ info, contenido })}>{t('open')}</button>
        ) : (
          <button className="filecard__abrir" onClick={() => setAbierto((v) => !v)} aria-expanded={abierto}>
            {abierto ? t('hideContent') : t('open')}
          </button>
        )}
        <button
          className="filecard__btn"
          onClick={descargar}
          disabled={estado === 'preparando'}
          aria-busy={estado === 'preparando'}
          aria-label={estado === 'preparando' ? t('preparing') : t('download')}
          title={estado === 'preparando' ? t('preparing') : t('download')}
        >
          {estado === 'preparando' ? <Rombos /> : <IconDownload size={16} />}
        </button>
      </div>
      {abierto && <pre className="filecard__body"><code>{contenido}</code></pre>}
    </div>
  );
}

/** Dos o más archivos en una respuesta: «N archivos · Descargar todo» (ZIP). */
export function GrupoArchivos({ archivos }) {
  const t = useT('chat');
  const [estado, setEstado] = useState('');
  const todo = async () => {
    setEstado('preparando');
    try {
      const partes = [];
      for (const a of archivos) {
        const info = parseFileLang(a.className);
        if (!info) continue;
        const blob = await construirArchivo(info, a.contenido);
        partes.push({ name: info.name, code: new Uint8Array(await blob.arrayBuffer()) });
      }
      descargarBlob(crearZip(partes), 'archivos-lixbon.zip');
      setEstado('');
    } catch (err) {
      console.error('[archivo] no se pudo crear el zip', err);
      setEstado('error');
    }
  };
  return (
    <div className="filegrupo">
      <span>{estado === 'error' ? t('fileError') : t('nFiles', { n: archivos.length })}</span>
      <button type="button" className={`pill-btn pill-btn--outline pill-btn--chico ${estado === 'preparando' ? 'is-esperando' : ''}`}
        onClick={todo} disabled={estado === 'preparando'} aria-busy={estado === 'preparando'}>
        {estado === 'preparando' ? <Rombos /> : <IconDownload size={15} />}
        {estado === 'preparando' ? t('preparingZip') : t('downloadAll')}
      </button>
    </div>
  );
}
