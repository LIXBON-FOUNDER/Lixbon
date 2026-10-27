import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { FileCard } from './FileCard';
import { IconCheck, IconCopy, IconCorreo, IconDownload } from './Icons';
import { descargarBlob, extForLang, parseFileLang } from '../lib/archivos';
import { useT } from '../i18n/useT';

function textoDe(children) {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(textoDe).join('');
  if (children && typeof children === 'object' && children.props) return textoDe(children.props.children);
  return '';
}

function Bloque({ lang, codigo }) {
  const t = useT('common');
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
        <span className="md-code__lang">{lang || t('plainText')}</span>
        <span className="md-code__actions">
          <button className="md-code__btn" onClick={descargar} title={t('downloadAsFile')}><IconDownload size={13} /></button>
          <button className="md-code__btn" onClick={copiar} title={t('copy')}>
            {copiado ? <IconCheck size={13} /> : <IconCopy size={13} />}
          </button>
        </span>
      </div>
      <pre><code>{codigo}</code></pre>
    </div>
  );
}

// Un bloque ```email: cabeceras «Para:» / «Asunto:» (o To/Subject), una línea
// en blanco y el cuerpo. Se copia entero o se abre en la app de correo.
function leerCorreo(codigo) {
  const lineas = codigo.split('\n');
  const cab = {};
  let i = 0;
  for (; i < lineas.length; i += 1) {
    const m = /^\s*(para|to|asunto|subject|cc)\s*:\s*(.*)$/i.exec(lineas[i]);
    if (!m) break;
    const k = m[1].toLowerCase();
    cab[k === 'to' ? 'para' : k === 'subject' ? 'asunto' : k] = m[2].trim();
  }
  return { para: cab.para || '', asunto: cab.asunto || '', cc: cab.cc || '', cuerpo: lineas.slice(i).join('\n').trim() };
}

function Correo({ codigo }) {
  const t = useT('common');
  const [copiado, setCopiado] = useState(false);
  const c = leerCorreo(codigo);
  const copiar = async () => {
    try {
      await navigator.clipboard.writeText([c.asunto && `${t('emailSubject')}: ${c.asunto}`, c.cuerpo].filter(Boolean).join('\n\n'));
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1800);
    } catch { /* portapapeles no disponible */ }
  };
  const params = new URLSearchParams();
  if (c.asunto) params.set('subject', c.asunto);
  if (c.cc) params.set('cc', c.cc);
  if (c.cuerpo) params.set('body', c.cuerpo);
  const mailto = `mailto:${encodeURIComponent(c.para).replace(/%40/g, '@').replace(/%2C/g, ',')}?${params.toString().replace(/\+/g, '%20')}`;
  return (
    <div className="md-correo">
      <div className="md-correo__head">
        <span className="md-correo__icono"><IconCorreo size={16} /></span>
        <div className="md-correo__meta">
          {c.asunto && <strong className="md-correo__asunto">{c.asunto}</strong>}
          {c.para && <span className="md-correo__para">{t('emailTo')}: {c.para}</span>}
        </div>
        <button type="button" className="md-code__btn" onClick={copiar} title={t('copy')}>
          {copiado ? <IconCheck size={14} /> : <IconCopy size={14} />}
        </button>
        <a className="md-correo__abrir" href={mailto}>{t('openInMail')}</a>
      </div>
      <div className="md-correo__cuerpo">{c.cuerpo}</div>
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
      if (/^(email|correo|mail)$/i.test(lang)) return <Correo codigo={codigo} />;
      return <Bloque lang={lang} codigo={codigo} />;
    },
    img({ src, alt }) {
      if (!/^https:\/\//.test(src || '')) return null;
      return (
        <a className="md-img" href={src} target="_blank" rel="noopener noreferrer">
          <img src={src} alt={alt || ''} loading="lazy" referrerPolicy="no-referrer"
            onError={(e) => { e.currentTarget.parentElement.hidden = true; }} />
          {alt && <span className="md-img__pie">{alt}</span>}
        </a>
      );
    },
  }), [streaming]);
  return (
    <div className="md">
      <ReactMarkdown components={components}>{children}</ReactMarkdown>
    </div>
  );
}
