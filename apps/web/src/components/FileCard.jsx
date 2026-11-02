import { createContext, useContext, useState } from 'react';
import { IconDownload } from './Icons';
import { construirArchivo, descargarBlob, fmtBytes } from '../lib/archivos';
import { useT } from '../i18n/useT';

// El color de la etiqueta según el tipo: hojas en verde, presentaciones y PDF
// en ámbar, el resto en la tinta suave.
export const TONO_ARCHIVO = { xlsx: 'ok', csv: 'ok', pptx: 'warn', pdf: 'warn' };

// Con este contexto, «Abrir» lleva el archivo al panel de la derecha del chat;
// sin él (p. ej. una conversación compartida) el contenido se despliega aquí.
export const AbrirArchivo = createContext(null);

export async function descargarArchivo(info, contenido) {
  descargarBlob(await construirArchivo(info, contenido), info.name);
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

  const lineas = contenido.split('\n').length;
  const ext = (info.ext || 'txt').slice(0, 4).toUpperCase();

  return (
    <div className="filecard">
      <div className="filecard__head">
        <span className={`filecard__tipo ${TONO_ARCHIVO[info.ext] ? `is-${TONO_ARCHIVO[info.ext]}` : ''}`} aria-hidden="true">{ext}</span>
        <div className="filecard__meta">
          <span className="filecard__name">{info.name}</span>
          <span className="filecard__info">
            {estado === 'error' ? t('fileError') : (
              <>
                {info.label} · {lineas} {lineas === 1 ? t('line') : t('lines')} · {fmtBytes(new Blob([contenido]).size)}
                {streaming && t('writingSuffix')}
              </>
            )}
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
          disabled={streaming || estado === 'preparando'}
          aria-label={estado === 'preparando' ? t('preparing') : t('download')}
          title={estado === 'preparando' ? t('preparing') : t('download')}
        >
          <IconDownload size={16} />
        </button>
      </div>
      {abierto && <pre className="filecard__body"><code>{contenido}</code></pre>}
    </div>
  );
}
