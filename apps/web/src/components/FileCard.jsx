// FileCard.jsx — un archivo escrito por el modelo (```file:nombre.ext): tarjeta
// con descarga y el contenido plegado.
import { useState } from 'react';
import { IconChevron, IconDownload, IconFile } from './Icons';
import { construirArchivo, descargarBlob, fmtBytes } from '../lib/archivos';
import { useT } from '../i18n/useT';

export function FileCard({ info, contenido, streaming }) {
  const t = useT('chat');
  const [abierto, setAbierto] = useState(false);
  const [estado, setEstado] = useState('');

  const descargar = async () => {
    setEstado('preparando');
    try {
      descargarBlob(await construirArchivo(info, contenido), info.name);
      setEstado('');
    } catch (err) {
      console.error('[archivo] no se pudo construir', err);
      setEstado('error');
    }
  };

  const lineas = contenido.split('\n').length;
  return (
    <div className="filecard">
      <div className="filecard__head">
        <span className="filecard__icon"><IconFile size={18} /></span>
        <div className="filecard__meta">
          <span className="filecard__name">{info.name}</span>
          <span className="filecard__info">
            {info.label} · {lineas} {lineas === 1 ? t('line') : t('lines')} · {fmtBytes(new Blob([contenido]).size)}
            {streaming && t('writingSuffix')}
          </span>
        </div>
        <button className="filecard__btn" onClick={descargar} disabled={streaming || estado === 'preparando'}>
          <IconDownload size={15} />
          <span>{estado === 'preparando' ? t('preparing') : estado === 'error' ? t('fileError') : t('download')}</span>
        </button>
      </div>
      <button className="filecard__toggle" onClick={() => setAbierto((v) => !v)} aria-expanded={abierto}>
        <IconChevron open={abierto} size={14} />
        <span>{abierto ? t('hideContent') : t('viewContent')}</span>
      </button>
      {abierto && <pre className="filecard__body"><code>{contenido}</code></pre>}
    </div>
  );
}
