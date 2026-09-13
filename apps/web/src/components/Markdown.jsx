// Markdown.jsx — render de respuestas de la IA. Títulos en Semibold según diseño.
// Los bloques ```file:nombre.ext son archivos: van como tarjeta descargable.
import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { FileCard } from './FileCard';
import { IconCheck, IconCopy, IconDownload } from './Icons';
import { descargarBlob, extForLang, parseFileLang } from '../lib/archivos';

function textoDe(children) {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(textoDe).join('');
  if (children && typeof children === 'object' && children.props) return textoDe(children.props.children);
  return '';
}

function Bloque({ lang, codigo }) {
  const [copiado, setCopiado] = useState(false);
  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(codigo);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1800);
    } catch { /* portapapeles no disponible */ }
  };
  const descargar = () => descargarBlob(new Blob([codigo], { type: 'text/plain;charset=utf-8' }), `codigo.${extForLang(lang)}`);
  return (
    <div className="md-code">
      <div className="md-code__head">
        <span className="md-code__lang">{lang || 'texto'}</span>
        <span className="md-code__actions">
          <button className="md-code__btn" onClick={descargar} title="Descargar como archivo"><IconDownload size={13} /></button>
          <button className="md-code__btn" onClick={copiar} title="Copiar">
            {copiado ? <IconCheck size={13} /> : <IconCopy size={13} />}
          </button>
        </span>
      </div>
      <pre><code>{codigo}</code></pre>
    </div>
  );
}

export function Markdown({ children, streaming = false }) {
  const components = useMemo(() => ({
    pre({ children: hijo }) {
      const props = hijo?.props || {};
      const codigo = textoDe(props.children).replace(/\n$/, '');
      const info = parseFileLang(props.className);
      if (info) return <FileCard info={info} contenido={codigo} streaming={streaming} />;
      const lang = (/language-([\w.+-]+)/.exec(props.className || '') || [])[1] || '';
      return <Bloque lang={lang} codigo={codigo} />;
    },
  }), [streaming]);
  return (
    <div className="md">
      <ReactMarkdown components={components}>{children}</ReactMarkdown>
    </div>
  );
}
