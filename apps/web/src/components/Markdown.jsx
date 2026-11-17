import { createContext, useContext, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { FileCard, GrupoArchivos } from './FileCard';
import { Icono, IconCorreo, IconDownload, IconCopiar, IconExternal, IconPencil } from './Icons';
import { descargarBlob, extForLang, parseFileLang } from '../lib/archivos';
import { useT } from '../i18n/useT';
import '../styles/markdown.css';

// Lo que una pieza de la respuesta le pide al chat («Hacerlo más formal»):
// ChatPage lo provee con su `send`. Sin proveedor (conversación compartida)
// esas acciones no se muestran.
export const PedirAlChat = createContext(null);

// El texto que sigue al lenguaje de un bloque (```js src/carrito.js o
// ```copiar Mensaje para WhatsApp) pasa al <pre> como data-titulo.
function remarkTitulo() {
  return (tree) => {
    const visitar = (n) => {
      if (n.type === 'code' && n.meta) {
        n.data = { ...(n.data || {}), hProperties: { ...((n.data || {}).hProperties || {}), 'data-titulo': n.meta.trim() } };
      }
      (n.children || []).forEach(visitar);
    };
    visitar(tree);
  };
}

// GFM (tablas, tachado, listas de tareas, enlaces sueltos) y colores de
// sintaxis. Sin lenguaje declarado no se adivina: un bloque de texto plano
// coloreado al azar se lee peor que sin colores.
const REMARK = [remarkGfm, remarkTitulo];
const REHYPE = [[rehypeHighlight, { detect: false }]];

function textoDe(children) {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(textoDe).join('');
  if (children && typeof children === 'object' && children.props) return textoDe(children.props.children);
  return '';
}

// Nombre legible y color de cada lenguaje (el cuadrito de la cabecera).
const LENGUAJES = {
  javascript: ['JavaScript', '#C9A227'], js: ['JavaScript', '#C9A227'], jsx: ['JSX', '#61DAFB'], mjs: ['JavaScript', '#C9A227'],
  typescript: ['TypeScript', '#3178C6'], ts: ['TypeScript', '#3178C6'], tsx: ['TSX', '#3178C6'],
  python: ['Python', '#4B8BBE'], py: ['Python', '#4B8BBE'], html: ['HTML', '#E34C26'], xml: ['XML', '#E37933'],
  css: ['CSS', '#8E6BD8'], scss: ['SCSS', '#C6538C'], json: ['JSON', '#5B6EE1'], yaml: ['YAML', '#CB4B3A'], yml: ['YAML', '#CB4B3A'],
  sql: ['SQL', '#D9883A'], java: ['Java', '#B07219'], kotlin: ['Kotlin', '#A97BFF'], go: ['Go', '#00ADD8'], rust: ['Rust', '#DEA584'],
  c: ['C', '#6E7CB9'], cpp: ['C++', '#6E7CB9'], cs: ['C#', '#68217A'], csharp: ['C#', '#68217A'], php: ['PHP', '#777BB4'],
  ruby: ['Ruby', '#CC342D'], rb: ['Ruby', '#CC342D'], swift: ['Swift', '#F05138'], dart: ['Dart', '#00B4AB'],
  markdown: ['Markdown', '#6B7280'], md: ['Markdown', '#6B7280'], diff: ['Cambios', '#5DBB7C'], dockerfile: ['Dockerfile', '#2496ED'],
  bash: ['Terminal', '#8C8C8C'], sh: ['Terminal', '#8C8C8C'], shell: ['Terminal', '#8C8C8C'], zsh: ['Terminal', '#8C8C8C'],
  console: ['Terminal', '#8C8C8C'], powershell: ['PowerShell', '#5391FE'], ps1: ['PowerShell', '#5391FE'],
};
const TERMINAL = /^(bash|sh|shell|zsh|console|powershell|ps1)$/i;
const PLEGAR_DESDE = 20;
const PLEGADO = 12;

function Copiar({ texto, etiqueta }) {
  const t = useT('common');
  const [copiado, setCopiado] = useState(false);
  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1800);
    } catch { /* portapapeles no disponible */ }
  };
  return (
    <button type="button" className={`md-btn ${copiado ? 'is-hecho' : ''}`} onClick={copiar} aria-live="polite">
      <IconCopiar hecho={copiado} size={15} />
      <span>{copiado ? t('copied') : (etiqueta || t('copy'))}</span>
    </button>
  );
}

function Bloque({ lang, titulo, codigo, children }) {
  const t = useT('common');
  const lineas = codigo.split('\n');
  const largo = lineas.length > PLEGAR_DESDE;
  const [abierto, setAbierto] = useState(false);
  const plegado = largo && !abierto;
  const clave = (lang || '').toLowerCase();
  const [nombre, color] = LENGUAJES[clave] || [lang || t('plainText'), '#8C8C8C'];
  const term = TERMINAL.test(clave);
  const descargar = () => descargarBlob(new Blob([codigo], { type: 'text/plain;charset=utf-8' }),
    titulo && /\.\w+$/.test(titulo) ? titulo.split('/').pop() : `codigo.${extForLang(lang)}`);
  // Terminal: «$» delante de cada orden (no de los comentarios ni de las
  // líneas vacías); el resto, números de línea tenues.
  const margen = lineas.map((l, i) => (term ? (l.trim() && !l.trim().startsWith('#') ? '$' : '') : String(i + 1)));
  return (
    <figure className={`md-code ${term ? 'md-code--term' : ''} ${clave === 'diff' ? 'md-code--diff' : ''} ${plegado ? 'is-plegado' : ''}`}
      style={plegado ? { '--plegado': PLEGADO } : undefined}>
      <figcaption className="md-code__head">
        <span className="md-code__lang"><i style={{ background: color }} />{nombre}</span>
        {titulo && <span className="md-code__archivo">{titulo}</span>}
        {!titulo && lineas.length > 1 && <span className="md-code__meta">{t('nLines', { n: lineas.length })}</span>}
        <span className="md-code__actions">
          <button type="button" className="md-btn md-btn--icono" onClick={descargar} title={t('downloadAsFile')} aria-label={t('downloadAsFile')}>
            <IconDownload size={15} />
          </button>
          <Copiar texto={codigo} />
        </span>
      </figcaption>
      <div className="md-code__cuerpo">
        <span className="md-code__margen" aria-hidden="true">{margen.join('\n')}</span>
        <pre>{children || <code>{codigo}</code>}</pre>
      </div>
      {largo && (
        <div className="md-code__mas">
          <button type="button" className="md-btn md-btn--sec" onClick={() => setAbierto((v) => !v)} aria-expanded={abierto}>
            <Icono nombre="abajo" size={15} style={abierto ? { transform: 'rotate(180deg)' } : undefined} />
            {abierto ? t('showLess') : t('showAllLines', { n: lineas.length })}
          </button>
        </div>
      )}
    </figure>
  );
}

// Un bloque ```email: cabeceras «Para:» / «Asunto:» (o To/Subject), una línea
// en blanco y el cuerpo. Se copia entero o se abre en Gmail con todo relleno.
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

const FORMAL = /\b(estimad[oa]s?|atentamente|cordialmente|cordial saludo|dear|sincerely|regards)\b/i;

function Correo({ codigo }) {
  const t = useT('common');
  const pedir = useContext(PedirAlChat);
  const c = leerCorreo(codigo);
  const gmail = new URLSearchParams({ view: 'cm', fs: '1' });
  if (c.para) gmail.set('to', c.para);
  if (c.cc) gmail.set('cc', c.cc);
  if (c.asunto) gmail.set('su', c.asunto);
  if (c.cuerpo) gmail.set('body', c.cuerpo);
  const palabras = c.cuerpo ? c.cuerpo.split(/\s+/).filter(Boolean).length : 0;
  const formal = FORMAL.test(c.cuerpo);
  return (
    <div className="md-correo">
      <div className="md-correo__head">
        <span className="md-correo__titulo"><IconCorreo size={18} />{t('emailDraft')}</span>
        <span className="md-code__actions">
          <Copiar texto={[c.asunto && `${t('emailSubject')}: ${c.asunto}`, c.cuerpo].filter(Boolean).join('\n\n')} />
          <a className="md-btn md-btn--sec" href={`https://mail.google.com/mail/?${gmail.toString()}`} target="_blank" rel="noopener noreferrer">
            <IconExternal size={15} />{t('openInGmail')}
          </a>
        </span>
      </div>
      {(c.para || c.asunto || c.cc) && (
        <dl className="md-correo__campos">
          {c.para && <div><dt>{t('emailTo')}</dt><dd>{c.para}</dd></div>}
          {c.cc && <div><dt>Cc</dt><dd>{c.cc}</dd></div>}
          {c.asunto && <div><dt>{t('emailSubject')}</dt><dd>{c.asunto}</dd></div>}
        </dl>
      )}
      <div className="md-correo__cuerpo">{c.cuerpo.split(/\n{2,}/).map((parrafo, i) => <p key={i}>{parrafo}</p>)}</div>
      <div className="md-correo__pie">
        <span>{t('nWords', { n: palabras })}</span>
        <span>{formal ? t('toneFormal') : t('toneWarm')}</span>
        {pedir && (
          <button type="button" className="md-btn" onClick={() => pedir(formal ? t('makeWarmerAsk') : t('makeFormalAsk'))}>
            <IconPencil size={15} />{formal ? t('makeWarmer') : t('makeFormal')}
          </button>
        )}
      </div>
    </div>
  );
}

// ```copiar <etiqueta>: un texto pensado para pegarlo en otra app. Si la
// etiqueta nombra una red con límite, se cuenta contra él.
const LIMITES = [
  [/instagram|bio/i, 150], [/\b(x|twitter|tweet|tuit)\b/i, 280], [/\bsms\b/i, 160],
  [/meta ?descrip|descripci[oó]n meta|meta description/i, 160], [/t[ií]tulo seo|seo title/i, 60],
];

function Copiable({ etiqueta, texto }) {
  const t = useT('common');
  const limite = (LIMITES.find(([re]) => re.test(etiqueta || '')) || [])[1];
  const n = [...texto].length;
  return (
    <div className="md-copia">
      <div className="md-copia__cab">
        <span>{etiqueta || t('textToCopy')}</span>
        <Copiar texto={texto} />
      </div>
      <div className="md-copia__txt">{texto}</div>
      <div className={`md-copia__pie ${limite && n > limite ? 'is-pasado' : ''}`}>
        {limite ? t('charsOf', { n, max: limite }) : t('nChars', { n })}
      </div>
    </div>
  );
}

const ARCHIVO = /```file:([^\n`]+)\n([\s\S]*?)```/g;

export function Markdown({ children, streaming = false }) {
  const components = useMemo(() => ({
    pre({ children: hijo, node, ...resto }) {
      const props = hijo?.props || {};
      const codigo = textoDe(props.children).replace(/\n$/, '');
      // mdast-util-to-hast pone las hProperties en el <code>, no en el <pre>.
      const titulo = props['data-titulo'] || resto['data-titulo'] || '';
      const info = parseFileLang(props.className);
      if (info) return <FileCard info={info} contenido={codigo} streaming={streaming} />;
      const lang = (/language-([\w.+-]+)/.exec(props.className || '') || [])[1] || '';
      if (/^(email|correo|mail)$/i.test(lang)) return <Correo codigo={codigo} />;
      if (/^(copiar|copy|copiable)$/i.test(lang)) return <Copiable etiqueta={titulo} texto={codigo} />;
      return <Bloque lang={lang} titulo={titulo} codigo={codigo}>{hijo}</Bloque>;
    },
    table({ children: filas }) {
      // Envoltorio con scroll: una tabla ancha no rompe el ancho del hilo.
      return <div className="md-tabla"><table>{filas}</table></div>;
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
  // Dos o más archivos en la respuesta: al final, «N archivos · Descargar todo».
  const archivos = useMemo(() => {
    if (streaming || typeof children !== 'string') return [];
    return [...children.matchAll(ARCHIVO)].map((m) => ({ className: `language-file:${m[1].trim()}`, contenido: m[2].replace(/\n$/, '') }));
  }, [children, streaming]);
  return (
    <div className="md">
      <ReactMarkdown components={components} remarkPlugins={REMARK} rehypePlugins={REHYPE}>{children}</ReactMarkdown>
      {archivos.length > 1 && <GrupoArchivos archivos={archivos} />}
    </div>
  );
}
