// FileQuickView.jsx — vista rápida de solo lectura del archivo elegido en
// Archivos. Ya no hay editor: esto es texto plano, sin resaltado ni edición.
// Para editar a mano, "Revelar en el explorador" abre el sistema operativo.
import { useEffect, useState } from 'react';
import { readFileContent, revealInOs } from '../../lib/tauri';
import { useFileViewStore } from '../../store/fileViewStore';
import { IconX, IconFolderOpen } from '../../components/Icons';

const MAX_CHARS = 20000;

export function FileQuickView() {
  const { peekedPath, peekedName, clear } = useFileViewStore();
  const [content, setContent] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!peekedPath) return;
    setContent(null);
    setError('');
    readFileContent(peekedPath)
      .then((text) => setContent(text.length > MAX_CHARS
        ? text.slice(0, MAX_CHARS) + '\n… (recortado, ábrelo desde el explorador para verlo entero)'
        : text))
      .catch((e) => setError(String(e)));
  }, [peekedPath]);

  if (!peekedPath) return null;

  return (
    <div className="quickview">
      <div className="quickview__head">
        <span className="quickview__name" title={peekedPath}>{peekedName}</span>
        <span className="quickview__actions">
          <button className="icon-btn" title="Revelar en el explorador del sistema" onClick={() => revealInOs(peekedPath)}>
            <IconFolderOpen size={14} />
          </button>
          <button className="icon-btn" title="Cerrar vista rápida" onClick={clear}>
            <IconX size={14} />
          </button>
        </span>
      </div>
      <div className="quickview__body">
        {error ? (
          <p className="filetree__hint">{error}</p>
        ) : content === null ? (
          <span className="skeleton" style={{ display: 'block', height: 60, margin: 10, borderRadius: 8 }} />
        ) : (
          <pre className="quickview__pre">{content}</pre>
        )}
      </div>
    </div>
  );
}
