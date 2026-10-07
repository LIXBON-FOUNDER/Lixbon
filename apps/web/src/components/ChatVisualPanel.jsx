// ChatVisualPanel.jsx — Visuals dentro del chat: cuando el modelo entrega una
// página (```file:index.html) se abre un panel junto a la conversación con la
// vista en vivo, y al terminar se guarda como visual de esa conversación.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '../i18n/link';
import { documentoPreview, resolverPagina, rotuloDe } from '../lib/visuals';
import { IconExternal, IconFile, IconLayers, IconTrash, IconX } from './Icons';

export const VISUAL_CHAT_PROMPT = '\n\nVISUALS: si el usuario pide VER algo visual (una página web, landing, interfaz, dashboard, '
  + 'componente, prototipo, logo o icono SVG), entrégalo como diseño: el HTML completo en un bloque ```file:index.html '
  + '(varias pantallas = varios bloques file:otra.html enlazados con href relativo; SVG en ```file:logo.svg). '
  + 'Se abre en un panel junto al chat y se guarda en Lixbon Visuals. HTML autocontenido (<!doctype html>, viewport, '
  + 'estilos en <style>; puedes usar <script src="https://cdn.tailwindcss.com"></script> y Google Fonts), textos reales '
  + 'sin lorem ipsum, imágenes https://picsum.photos/seed/<palabra>/<ancho>/<alto>, iconos SVG inline, responsive y '
  + 'accesible. Para cambiar un diseño que ya existe usa ```edit:index.html con pares <<<<<<< SEARCH / ======= / '
  + '>>>>>>> REPLACE copiando el SEARCH exacto de los archivos actuales. Fuera del bloque, una frase como mucho. '
  + 'Si solo preguntan cómo programar algo, responde con código normal (```html), no con file:.';

/** El texto sin los bloques de páginas: se ven en el panel, no en el hilo. */
export function sinBloquesVisuales(texto) {
  return (texto || '').replace(/```\s*(?:file|edit):\s*[\w./-]+\.(?:html?|svg)[^\n`]*\n[\s\S]*?(?:\n```|$)/g, '').trim();
}

export function VisualChip({ nombres, escribiendo, onOpen, t }) {
  return (
    <button type="button" className={`chat-vchip ${escribiendo ? 'is-busy' : ''}`} onClick={onOpen}>
      <IconLayers size={15} />
      <span className="chat-vchip__txt">
        <strong>{escribiendo ? t('visualWriting', { name: escribiendo }) : t('visualChip')}</strong>
        <small>{nombres.join(', ')}</small>
      </span>
      {!escribiendo && <span className="chat-vchip__cta">{t('visualShow')}</span>}
    </button>
  );
}

export function ChatVisualPanel({ visual, paginas, vivo, error, onClose, onDiscard, t }) {
  const [pagina, setPagina] = useState(null);
  const lista = vivo?.files?.length ? vivo.files : paginas;
  const nueva = vivo?.abierto?.name || vivo?.cambiadas?.[vivo.cambiadas.length - 1]?.name;
  useEffect(() => { if (nueva) setPagina(nueva); }, [nueva]);
  const actual = lista.find((f) => f.name === pagina) || lista[0] || null;
  const doc = useMemo(() => documentoPreview(actual), [actual]);
  const frameRef = useRef(null);
  useEffect(() => {
    const onMessage = (e) => {
      const m = e.data || {};
      if (m.type !== 'lixbon:navigate' || e.source !== frameRef.current?.contentWindow) return;
      const destino = resolverPagina(lista.map((f) => f.name), m.page, m.texto, Object.fromEntries(lista.map((f) => [f.name, rotuloDe(f.code)])));
      if (destino) setPagina(destino);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [lista]);

  return (
    <aside className="chat-visual" aria-label={t('visualPanelTitle')}>
      <header className="chat-visual__head">
        <IconLayers size={16} />
        <div className="chat-visual__titles">
          <strong>{visual?.title || t('visualPanelTitle')}</strong>
          <small>{vivo ? t('visualLive') : visual ? (visual.label || t('visualSaved')) : t('visualNotSaved')}</small>
        </div>
        {visual && (
          <>
            <Link to={`/visuals/${visual.id}`} className="pill-btn chat-visual__btn"><IconExternal size={14} /> {t('openInVisuals')}</Link>
            <button type="button" className="icon-btn" onClick={onDiscard} title={t('discardVisual')} aria-label={t('discardVisual')} disabled={!!vivo}><IconTrash size={15} /></button>
          </>
        )}
        <button type="button" className="icon-btn" onClick={onClose} title={t('closePanel')} aria-label={t('closePanel')}><IconX size={16} /></button>
      </header>
      {lista.length > 1 && (
        <div className="chat-visual__tabs" role="tablist">
          {lista.map((f) => (
            <button key={f.name} role="tab" aria-selected={actual?.name === f.name} className={actual?.name === f.name ? 'is-on' : ''} onClick={() => setPagina(f.name)}>
              <IconFile size={12} /> {f.name.replace(/\.(html?|svg)$/, '')}
            </button>
          ))}
        </div>
      )}
      {error && <p className="chat-visual__error" role="alert">{error}</p>}
      <div className="chat-visual__stage">
        {actual ? <iframe ref={frameRef} title={actual.name} sandbox="allow-scripts allow-forms allow-modals" srcDoc={doc} />
          : <p className="chat-visual__empty">{vivo ? t('visualStarting') : t('visualEmpty')}</p>}
      </div>
    </aside>
  );
}
