import { useEffect, useState } from 'react';
import { IconX, IconCopiar } from './Icons';
import { Markdown } from './Markdown';
import { TONO_ARCHIVO, descargarArchivo } from './FileCard';
import { fmtBytes } from '../lib/archivos';
import { useT } from '../i18n/useT';

// Filas de un CSV sencillo (sin comillas con comas dentro): basta para verlo.
const filasCsv = (texto) => texto.split('\n').filter(Boolean).slice(0, 500).map((l) => l.split(','));

function Vista({ info, contenido }) {
  if (info.ext === 'md') return <div className="panel-archivo__doc"><Markdown>{contenido}</Markdown></div>;
  if (info.ext === 'html') {
    return <iframe className="panel-archivo__web" title={info.name} sandbox="allow-scripts" srcDoc={contenido} />;
  }
  if (info.ext === 'csv') {
    const [cabeza, ...filas] = filasCsv(contenido);
    return (
      <div className="panel-archivo__tabla">
        <table>
          <thead><tr>{cabeza?.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
          <tbody>{filas.map((f, i) => <tr key={i}>{f.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
  return <pre className="panel-archivo__codigo"><code>{contenido}</code></pre>;
}

// Vista previa de un archivo creado en el chat, en el panel de la derecha:
// el documento se lee entero en vez de en una caja con scroll dentro del hilo.
export function PanelArchivo({ archivo, onClose }) {
  const t = useT('chat');
  const [copiado, setCopiado] = useState(false);
  const { info, contenido } = archivo;
  const lineas = contenido.split('\n').length;

  useEffect(() => {
    const f = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', f);
    return () => document.removeEventListener('keydown', f);
  }, [onClose]);

  const copiar = () => {
    navigator.clipboard?.writeText(contenido).then(() => {
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1600);
    }).catch(() => {});
  };

  return (
    <aside className="panel-archivo" aria-label={info.name}>
      <header className="panel-archivo__cab">
        <span className={`filecard__tipo ${TONO_ARCHIVO[info.ext] ? `is-${TONO_ARCHIVO[info.ext]}` : ''}`} aria-hidden="true">{(info.ext || 'txt').slice(0, 4).toUpperCase()}</span>
        <div className="panel-archivo__titulos">
          <strong>{info.name}</strong>
          <small>{info.label} · {lineas} {lineas === 1 ? t('line') : t('lines')} · {fmtBytes(new Blob([contenido]).size)}</small>
        </div>
        <button type="button" className="msg-accion" onClick={copiar} aria-label={copiado ? t('copied') : t('copyAnswer')} title={copiado ? t('copied') : t('copyAnswer')}>
          <IconCopiar hecho={copiado} size={16} />
        </button>
        <button type="button" className="panel-archivo__descargar" onClick={() => descargarArchivo(info, contenido).catch(() => {})}>
          {t('download')}
        </button>
        <button type="button" className="msg-accion" onClick={onClose} aria-label={t('closePanel')} title={t('closePanel')}>
          <IconX size={16} />
        </button>
      </header>
      <div className="panel-archivo__cuerpo">
        <Vista info={info} contenido={contenido} />
      </div>
    </aside>
  );
}
