// PiezaEditor.jsx — editor visual de una pieza HTML (imagen o vídeo de marketing),
// dentro del estudio: la pieza ocupa el lienzo y las propiedades van en la columna
// de la derecha. Las ediciones se aplican sobre el DOM del iframe y al guardar se
// serializa de vuelta a HTML.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n/useT';
import { paraGuardar, paraWeb } from '../lib/visualsApi';
import { FUENTES_GOOGLE, FUENTES_MARCA, cargarMuestras, enlazarFuente, pilaDe, primeraFamilia } from '../lib/googleFonts';
import { IconCheck, IconChevron, IconPencil, IconPlay, IconRedo, IconSearch, IconStop, IconUndo } from './Icons';

const PALETA = ['#B4C64E', '#8CA038', '#4B5327', '#171717', '#F6F7ED', '#DCD6BC', '#FFFFFF', '#C4553D'];
const TEMAS = ['lima', 'tinta', 'crema'];
const PESOS = [100, 200, 300, 400, 500, 600, 700, 800, 900];
const ZOOMS = [0.1, 0.17, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3];
const TIRADORES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const FUSIONES = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'soft-light', 'difference'];
const SOMBRAS = {
  none: null,
  soft: { x: 0, y: 2, b: 8, s: 0, hex: '#000000', a: 0.12 },
  medium: { x: 0, y: 8, b: 24, s: -4, hex: '#000000', a: 0.22 },
  strong: { x: 0, y: 24, b: 48, s: -8, hex: '#000000', a: 0.35 },
  glow: { x: 0, y: 0, b: 32, s: 0, hex: '#B4C64E', a: 0.6 },
};
const ESTILO_COPIABLE = ['color', 'background-color', 'background-image', 'font-family', 'font-size', 'font-weight',
  'font-style', 'letter-spacing', 'line-height', 'text-transform', 'text-decoration-line', 'text-align',
  'border-width', 'border-style', 'border-color', 'border-radius', 'box-shadow', 'text-shadow', 'opacity', 'filter'];
let estiloCopiado = null;

const winOf = (el) => el.ownerDocument.defaultView;
const cssOf = (el) => winOf(el).getComputedStyle(el);
const px = (v) => `${Math.round(v * 100) / 100}px`;
const tieneTexto = (el) => !!(el.textContent || '').trim();

function seen(el) {
  for (let a = el; a && a.nodeType === 1; a = a.parentElement) {
    const s = cssOf(a);
    if (s.opacity === '0' || s.visibility === 'hidden' || s.display === 'none') return false;
  }
  return true;
}

function toHex(c) {
  if (/^#[0-9a-f]{6}$/i.test(c || '')) return c;
  const m = (c || '').match(/[\d.]+/g);
  if (!m || (m.length > 3 && +m[3] === 0)) return null;
  return `#${m.slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join('')}`;
}

const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

function leerSombra(valor) {
  if (!valor || valor === 'none') return null;
  const primera = valor.split(/,(?![^(]*\))/)[0];
  const color = (primera.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/i) || ['rgba(0, 0, 0, 0.25)'])[0];
  const [x = 0, y = 0, b = 0, s = 0] = (primera.replace(color, '').match(/-?[\d.]+px/g) || []).map(parseFloat);
  const c = color.match(/[\d.]+/g) || [];
  return { x, y, b, s, hex: toHex(color) || '#000000', a: c.length > 3 ? +c[3] : 1 };
}

function leerTraslado(el) {
  const v = el.style.translate || cssOf(el).translate;
  if (!v || v === 'none') return [0, 0];
  const [x, y] = v.split(/\s+/).map(parseFloat);
  return [x || 0, y || 0];
}
const fijarTraslado = (el, x, y) => { el.style.translate = x || y ? `${px(x)} ${px(y)}` : ''; };

function leerGiro(el) {
  const r = parseFloat(el.style.rotate);
  if (!Number.isNaN(r)) return r;
  const m = (el.style.transform || '').match(/rotate\((-?[\d.]+)deg\)/);
  return m ? +m[1] : 0;
}

/** El borde más cercano a una guía, si está a menos de `umbral`. */
function ajustar(bordes, guias, umbral) {
  let mejor = null;
  for (const b of bordes) {
    for (const g of guias) {
      const d = g - b;
      if (Math.abs(d) <= umbral && (!mejor || Math.abs(d) < Math.abs(mejor.d))) mejor = { d, pos: g };
    }
  }
  return mejor;
}

function rotuloDe(el, t) {
  if (el === el.ownerDocument.body) return { tag: t('editor.page'), txt: '' };
  const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 32);
  const cls = el.classList && el.classList[0];
  return { tag: `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`, txt };
}

const pathOf = (body, el) => {
  const p = [];
  for (let e = el; e && e !== body; e = e.parentNode) p.unshift([...e.parentNode.children].indexOf(e));
  return p;
};
const fromPath = (body, p) => p.reduce((el, i) => el && el.children[i], body);
const hijos = (el) => [...el.children].filter((c) => !['SCRIPT', 'STYLE', 'LINK'].includes(c.tagName));

/** Escala para que una pieza de w×h quepa en `nodo`. Las muy altas (páginas
 *  enteras) se ajustan al ancho y se recorren con scroll. */
function useEncaje(nodoRef, w, h) {
  const [escala, setEscala] = useState(0.4);
  useLayoutEffect(() => {
    const node = nodoRef.current;
    if (!node || !w || !h) return undefined;
    const fit = () => {
      const cs = getComputedStyle(node);
      const ancho = node.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const alto = node.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const porAncho = ancho / w;
      setEscala(Math.max(0.05, Math.min(1, h / w > 1.6 ? porAncho : Math.min(porAncho, alto / h))));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(node);
    return () => ro.disconnect();
  }, [nodoRef, w, h]);
  return escala;
}

const medidas = (meta) => (meta?.size || '1080x1350').split('x').map(Number);

/** Vista de una pieza a su tamaño real, escalada para caber: nítida a cualquier zoom. */
export function PiezaVista({ html, meta, baseHref, title }) {
  const [w, h] = medidas(meta);
  const ref = useRef(null);
  const escala = useEncaje(ref, w, h);
  return (
    <div className="pe-vista" ref={ref}>
      <div className="pe-wrap" style={{ width: w * escala, height: h * escala }}>
        {/* Sin scripts (las piezas animan solo con CSS) y con origen propio: así
            cargan las fuentes de marca, que un iframe sin origen no puede pedir. */}
        <iframe title={title} sandbox="allow-same-origin" srcDoc={paraWeb(html, baseHref)}
          style={{ width: w, height: h, transform: `scale(${escala})` }} />
      </div>
    </div>
  );
}

const CERRADAS_KEY = 'lixbon.pieza.secciones';
const leerCerradas = () => {
  try { return JSON.parse(localStorage.getItem(CERRADAS_KEY) || '{}'); } catch { return {}; }
};

function Sec({ id, title, abierta: inicial = true, children }) {
  const [abierta, setAbierta] = useState(() => leerCerradas()[id] ?? inicial);
  const alternar = () => {
    const v = !abierta;
    setAbierta(v);
    try { localStorage.setItem(CERRADAS_KEY, JSON.stringify({ ...leerCerradas(), [id]: v })); } catch { /* sin almacenamiento */ }
  };
  return (
    <section className={`vis-insp__sec pe-sec ${abierta ? '' : 'is-cerrada'}`}>
      <button className="pe-sec__cab" onClick={alternar} aria-expanded={abierta}>
        <h3 className="vis-insp__eyebrow">{title}</h3>
        <IconChevron size={12} open={abierta} />
      </button>
      {abierta && children}
    </section>
  );
}

function Fila({ label, children }) {
  return (
    <div className="pe-f">
      <span className="pe-f__k">{label}</span>
      <div className="pe-f__v">{children}</div>
    </div>
  );
}

function Range({ label, min, max, step, unit = '', get, set, commit }) {
  const [v, setV] = useState(() => get());
  const cambiar = (n) => { if (Number.isNaN(n)) return; setV(n); set(n); };
  const pct = ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100;
  return (
    <Fila label={label}>
      <div className="pe-slider" style={{ '--p': `${pct}%` }}>
        <span className="pe-slider__fill" />
        <input type="range" min={min} max={max} step={step} value={v} aria-label={label}
          onChange={(e) => cambiar(+e.target.value)} onPointerUp={commit} onKeyUp={commit} />
        <label className="pe-slider__num">
          <input type="number" step={step} value={+Number(v).toFixed(3)} aria-label={label}
            onChange={(e) => cambiar(+e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          {unit && <span>{unit}</span>}
        </label>
      </div>
    </Fila>
  );
}

/** Campo numérico compacto; arrastrar la etiqueta cambia el valor, como en Figma. */
function Num({ label, title, value, step = 1, min, unit, onChange, onCommit }) {
  const [v, setV] = useState(value);
  const cambiar = (n) => {
    if (Number.isNaN(n)) return;
    const x = min != null ? Math.max(min, n) : n;
    setV(x);
    onChange(x);
  };
  const arrastrar = (e) => {
    e.preventDefault();
    const nodo = e.currentTarget;
    const x0 = e.clientX;
    const v0 = +v || 0;
    nodo.setPointerCapture(e.pointerId);
    const mover = (ev) => cambiar(+(v0 + Math.round(ev.clientX - x0) * step * (ev.shiftKey ? 10 : 1)).toFixed(2));
    nodo.addEventListener('pointermove', mover);
    nodo.addEventListener('pointerup', () => { nodo.removeEventListener('pointermove', mover); onCommit(); }, { once: true });
  };
  return (
    <label className="pe-num" title={title}>
      <span className="pe-num__k" onPointerDown={arrastrar}>{label}</span>
      <input type="number" step={step} value={+Number(v).toFixed(2)} aria-label={title || label}
        onChange={(e) => cambiar(+e.target.value)} onBlur={onCommit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
      {unit && <span className="pe-num__u">{unit}</span>}
    </label>
  );
}

function Seg({ opciones, valor, cambiar, multi = false }) {
  return (
    <div className="vis-insp__seg pe-seg">
      {opciones.map(([k, rotulo, titulo]) => {
        const on = multi ? valor.includes(k) : valor === k;
        return (
          <button key={k} className={on ? 'is-on' : ''} title={titulo} aria-label={titulo} aria-pressed={on} onClick={() => cambiar(k)}>
            {rotulo}
          </button>
        );
      })}
    </div>
  );
}

function ColorPicker({ label, valor, cambiar, commit, quitar, clearLabel }) {
  const [hex, setHex] = useState(valor || '');
  const aplicar = (c, guardar = true) => { setHex(c); cambiar(c); if (guardar) commit(); };
  return (
    <Fila label={label}>
      <div className="pe-color">
        <div className="vis-insp__color">
          <span className={`vis-insp__muestra ${hex ? '' : 'is-vacia'}`} style={hex ? { background: hex } : undefined}>
            <input type="color" value={/^#[0-9a-f]{6}$/i.test(hex) ? hex : '#ffffff'} onChange={(e) => aplicar(e.target.value, false)} onBlur={commit} aria-label={label} />
          </span>
          <input className="vis-insp__hex" value={hex} placeholder="—" spellCheck={false}
            onChange={(e) => { setHex(e.target.value); if (/^#[0-9a-f]{3,8}$/i.test(e.target.value)) cambiar(e.target.value); }}
            onBlur={commit} />
          {quitar && hex && <button className="vis-insp__quitar" onClick={() => { setHex(''); quitar(); commit(); }} title={clearLabel} aria-label={clearLabel}>×</button>}
        </div>
        <div className="pe-sw">
          {PALETA.map((c) => <button key={c} style={{ background: c }} title={c} aria-label={c} onClick={() => aplicar(c)} />)}
        </div>
      </div>
    </Fila>
  );
}

function ColorField({ label, el, prop, commit, clearLabel }) {
  return (
    <ColorPicker label={label} valor={toHex(cssOf(el)[prop]) || ''} commit={commit} clearLabel={clearLabel}
      cambiar={(c) => { el.style[prop] = c; }} quitar={clearLabel ? () => { el.style[prop] = 'transparent'; } : null} />
  );
}

function ListaHijos({ items, pick, t }) {
  return (
    <div className="pe-lista">
      {items.map((k, i) => {
        const r = rotuloDe(k, t);
        return (
          <button key={i} onClick={() => pick(k)}>
            <span className="pe-lista__tag">{r.tag}</span>
            {r.txt && <span className="pe-lista__txt">{r.txt}</span>}
          </button>
        );
      })}
    </div>
  );
}

function IcoAlinear({ tipo }) {
  const v = tipo.startsWith('v') || ['top', 'bottom'].includes(tipo);
  const linea = { left: 'M2 1v12', hcenter: 'M7 1v12', right: 'M12 1v12', top: 'M1 2h12', vcenter: 'M1 7h12', bottom: 'M1 12h12' }[tipo];
  const cajas = v
    ? { top: [[3, 3, 3, 8], [8, 3, 3, 5]], vcenter: [[3, 2, 3, 10], [8, 4, 3, 6]], bottom: [[3, 3, 3, 8], [8, 6, 3, 5]] }[tipo]
    : { left: [[3, 3, 8, 3], [3, 8, 5, 3]], hcenter: [[2, 3, 10, 3], [4, 8, 6, 3]], right: [[3, 3, 8, 3], [6, 8, 5, 3]] }[tipo];
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d={linea} stroke="currentColor" strokeWidth="1.3" />
      {cajas.map(([x, y, w, h], i) => <rect key={i} x={x} y={y} width={w} height={h} rx="1" fill="currentColor" opacity=".55" />)}
    </svg>
  );
}

function Geometria({ doc, el, commit, touch, t }) {
  const [tx, ty] = leerTraslado(el);
  const vivo = (fn) => (v) => { fn(v); touch(); };
  const alinear = (tipo) => {
    const W = doc.documentElement.clientWidth;
    const H = doc.documentElement.clientHeight;
    const r = el.getBoundingClientRect();
    const [x, y] = leerTraslado(el);
    const dx = { left: -r.left, hcenter: (W - r.width) / 2 - r.left, right: W - r.right }[tipo] ?? 0;
    const dy = { top: -r.top, vcenter: (H - r.height) / 2 - r.top, bottom: H - r.bottom }[tipo] ?? 0;
    fijarTraslado(el, x + dx, y + dy);
    commit(true);
  };
  return (
    <Sec id="pos" title={t('editor.position')}>
      <div className="pe-alinear" role="group" aria-label={t('editor.alignPage')}>
        {['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom'].map((k) => (
          <button key={k} className="vis-tool vis-tool--icono" onClick={() => alinear(k)} title={t(`editor.aligns.${k}`)} aria-label={t(`editor.aligns.${k}`)}>
            <IcoAlinear tipo={k} />
          </button>
        ))}
      </div>
      <div className="pe-xywh">
        <Num label="X" title={t('editor.offsetX')} value={tx} unit="px" onCommit={() => commit()}
          onChange={vivo((v) => fijarTraslado(el, v, leerTraslado(el)[1]))} />
        <Num label="Y" title={t('editor.offsetY')} value={ty} unit="px" onCommit={() => commit()}
          onChange={vivo((v) => fijarTraslado(el, leerTraslado(el)[0], v))} />
        <Num label="An" title={t('editor.width')} value={Math.round(el.getBoundingClientRect().width)} min={1} unit="px" onCommit={() => commit()}
          onChange={vivo((v) => { el.style.boxSizing = 'border-box'; el.style.maxWidth = 'none'; el.style.width = px(v); })} />
        <Num label="Al" title={t('editor.height')} value={Math.round(el.getBoundingClientRect().height)} min={1} unit="px" onCommit={() => commit()}
          onChange={vivo((v) => { el.style.boxSizing = 'border-box'; el.style.height = px(v); })} />
        <Num label="↻" title={t('editor.rotate')} value={leerGiro(el)} step={0.5} unit="°" onCommit={() => commit()}
          onChange={vivo((v) => {
            el.style.transform = (el.style.transform || '').replace(/rotate\([^)]*\)/, '').trim();
            el.style.rotate = v ? `${v}deg` : '';
          })} />
      </div>
      <div className="pe-acciones">
        <button className="vis-tool" onClick={() => { el.style.width = ''; el.style.height = ''; commit(true); }}>{t('editor.fitContent')}</button>
        <button className="vis-tool" onClick={() => { fijarTraslado(el, 0, 0); el.style.rotate = ''; commit(true); }}>{t('editor.resetPos')}</button>
      </div>
    </Sec>
  );
}

function Disposicion({ el, commit, touch, t }) {
  const cs = cssOf(el);
  const modoDe = () => (cs.display.includes('flex') ? (cs.flexDirection.startsWith('column') ? 'col' : 'row') : 'block');
  const [modo, setModo] = useState(modoDe);
  const [justify, setJustify] = useState(cs.justifyContent);
  const [items, setItems] = useState(cs.alignItems);
  const cambiarModo = (m) => {
    if (m === 'block') { el.style.display = 'block'; } else { el.style.display = 'flex'; el.style.flexDirection = m === 'col' ? 'column' : 'row'; }
    setModo(m);
    commit();
  };
  const opts = (prefijo) => [['flex-start', t(`editor.flex.start`)], ['center', t('editor.flex.center')], ['flex-end', t('editor.flex.end')],
    [prefijo === 'j' ? 'space-between' : 'stretch', t(prefijo === 'j' ? 'editor.flex.between' : 'editor.flex.stretch')]];
  return (
    <Sec id="layout" title={t('editor.layout')} abierta={false}>
      <Fila label={t('editor.layoutMode')}>
        <Seg valor={modo} cambiar={cambiarModo}
          opciones={['block', 'row', 'col'].map((k) => [k, t(`editor.layoutModes.${k}`)])} />
      </Fila>
      {modo !== 'block' && (
        <>
          <Range label={t('editor.gap')} min={0} max={160} step={1} unit="px" commit={commit}
            get={() => parseFloat(cs.rowGap) || 0} set={(v) => { el.style.gap = px(v); touch(); }} />
          <Fila label={t('editor.justify')}>
            <Seg valor={justify} cambiar={(v) => { el.style.justifyContent = v; setJustify(v); commit(); }} opciones={opts('j')} />
          </Fila>
          <Fila label={t('editor.alignItems')}>
            <Seg valor={items} cambiar={(v) => { el.style.alignItems = v; setItems(v); commit(); }} opciones={opts('a')} />
          </Fila>
        </>
      )}
    </Sec>
  );
}

function SelectorFuente({ doc, el, commit, t }) {
  const [actual, setActual] = useState(() => primeraFamilia(cssOf(el).fontFamily));
  const [abierto, setAbierto] = useState(false);
  const [q, setQ] = useState('');
  const [cargando, setCargando] = useState(null);
  const [error, setError] = useState('');
  const enPieza = useMemo(() => {
    const vistas = new Set();
    for (const n of [doc.body, ...doc.body.querySelectorAll('*')]) {
      vistas.add(primeraFamilia(cssOf(n).fontFamily));
      if (vistas.size > 12) break;
    }
    return [...vistas].filter(Boolean);
  }, [doc]);

  const grupos = [['piece', enPieza], ['brand', FUENTES_MARCA], ...Object.entries(FUENTES_GOOGLE)];
  const filtro = q.trim().toLowerCase();
  const visibles = grupos
    .map(([k, fs]) => [k, fs.filter((f) => f.toLowerCase().includes(filtro))])
    .filter(([, fs]) => fs.length);
  const exacta = grupos.some(([, fs]) => fs.some((f) => f.toLowerCase() === filtro));

  const elegir = async (nombre) => {
    setError('');
    setCargando(nombre);
    const titulo = nombre.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
    let elegido = nombre;
    let ok = await enlazarFuente(doc, nombre);
    if (!ok && titulo !== nombre) { ok = await enlazarFuente(doc, titulo); elegido = titulo; }
    setCargando(null);
    if (!ok) { setError(t('editor.fontNotFound', { name: nombre })); return; }
    el.style.fontFamily = pilaDe(elegido);
    setActual(elegido);
    setAbierto(false);
    setQ('');
    commit(true);
  };

  return (
    <div className="pe-fuente">
      <button className="pe-fuente__actual" onClick={() => { cargarMuestras(Object.values(FUENTES_GOOGLE).flat()); setAbierto(!abierto); }}
        aria-expanded={abierto} style={{ fontFamily: `"${actual}", sans-serif` }}>
        <span>{actual || '—'}</span>
        <IconChevron size={12} open={abierto} />
      </button>
      {abierto && (
        <div className="pe-fuente__panel">
          <label className="pe-fuente__buscar">
            <IconSearch size={13} />
            <input autoFocus value={q} placeholder={t('editor.fontSearch')} spellCheck={false}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) elegir(visibles[0]?.[1][0] && !exacta && filtro ? q.trim() : (visibles[0]?.[1][0] || q.trim())); if (e.key === 'Escape') setAbierto(false); }} />
          </label>
          <div className="pe-fuente__lista">
            {filtro && !exacta && (
              <button className="pe-fuente__google" onClick={() => elegir(q.trim())}>{t('editor.fontUseGoogle', { name: q.trim() })}</button>
            )}
            {visibles.map(([k, fs]) => (
              <div key={k} className="pe-fuente__grupo">
                <span className="pe-fuente__cat">{t(`editor.fontGroups.${k}`)}</span>
                {fs.map((f) => (
                  <button key={f} className={f === actual ? 'is-on' : ''} onClick={() => elegir(f)} style={{ fontFamily: `"${f}", sans-serif` }}>
                    {f}{cargando === f && <small>{t('editor.fontLoading')}</small>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      {error && <p className="pe-error">{error}</p>}
    </div>
  );
}

function Tipografia({ doc, el, cs, commit, touch, t }) {
  const decoraciones = () => [cs.fontStyle === 'italic' && 'i', cs.textDecorationLine.includes('underline') && 'u',
    cs.textDecorationLine.includes('line-through') && 's'].filter(Boolean);
  const [estilo, setEstilo] = useState(decoraciones);
  const [caso, setCaso] = useState(cs.textTransform);
  const alternar = (k) => {
    const on = !estilo.includes(k);
    if (k === 'i') el.style.fontStyle = on ? 'italic' : 'normal';
    else {
      const actual = new Set(cs.textDecorationLine.split(' ').filter((x) => x !== 'none'));
      const linea = k === 'u' ? 'underline' : 'line-through';
      if (on) actual.add(linea); else actual.delete(linea);
      el.style.textDecorationLine = [...actual].join(' ') || 'none';
    }
    setEstilo(decoraciones());
    commit();
  };
  const alineado = cs.textAlign === 'start' ? 'left' : cs.textAlign;
  const [alinear, setAlinear] = useState(alineado);

  return (
    <Sec id="type" title={t('editor.typography')}>
      <Fila label={t('editor.font')}>
        <SelectorFuente doc={doc} el={el} commit={commit} t={t} />
      </Fila>
      <Range label={t('editor.size')} min={8} max={260} step={1} unit="px" commit={commit}
        get={() => parseFloat(cs.fontSize)} set={(v) => { el.style.fontSize = px(v); touch(); }} />
      <Fila label={t('editor.weight')}>
        <select className="vis-insp__valor pe-select" defaultValue={String(Math.round(+cs.fontWeight / 100) * 100)}
          onChange={(e) => { el.style.fontWeight = e.target.value; commit(); }}>
          {PESOS.map((w) => <option key={w} value={w}>{t(`editor.weights.${w}`)}</option>)}
        </select>
      </Fila>
      <Fila label={t('editor.style')}>
        <Seg multi valor={estilo} cambiar={alternar} opciones={[
          ['i', <em key="i">I</em>, t('editor.italic')],
          ['u', <u key="u">U</u>, t('editor.underline')],
          ['s', <s key="s">S</s>, t('editor.strike')],
        ]} />
      </Fila>
      <Fila label={t('editor.case')}>
        <Seg valor={caso} cambiar={(v) => { el.style.textTransform = v; setCaso(v); commit(); }} opciones={[
          ['none', '—', t('editor.cases.none')], ['uppercase', 'AA', t('editor.cases.upper')],
          ['lowercase', 'aa', t('editor.cases.lower')], ['capitalize', 'Aa', t('editor.cases.cap')],
        ]} />
      </Fila>
      <Fila label={t('editor.align')}>
        <Seg valor={alinear} cambiar={(v) => { el.style.textAlign = v; setAlinear(v); commit(); }}
          opciones={['left', 'center', 'right', 'justify'].map((k) => [k, t(`editor.${k === 'justify' ? 'textJustify' : k}`)])} />
      </Fila>
      <Range label={t('editor.lineHeight')} min={0.8} max={2.4} step={0.02} commit={commit}
        get={() => { const l = parseFloat(cs.lineHeight); return Number.isNaN(l) ? 1.2 : +(l / parseFloat(cs.fontSize)).toFixed(2); }}
        set={(v) => { el.style.lineHeight = v; touch(); }} />
      <Range label={t('editor.letterSpacing')} min={-0.1} max={0.5} step={0.005} unit="em" commit={commit}
        get={() => +((parseFloat(cs.letterSpacing) || 0) / parseFloat(cs.fontSize)).toFixed(3)}
        set={(v) => { el.style.letterSpacing = `${v}em`; touch(); }} />
    </Sec>
  );
}

function Degradado({ el, cs, commit, touch, t }) {
  const leer = () => {
    const m = /linear-gradient\((.*)\)/.exec(cs.backgroundImage);
    if (!m) return null;
    const colores = m[1].match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/gi) || [];
    const ang = /(-?[\d.]+)deg/.exec(m[1]);
    return { a: ang ? +ang[1] : 180, c1: toHex(colores[0]) || '#B4C64E', c2: toHex(colores[colores.length - 1]) || '#171717' };
  };
  const [g, setG] = useState(leer);
  const ref = useRef(g);
  const aplicar = (n) => {
    ref.current = n;
    el.style.backgroundImage = n ? `linear-gradient(${n.a}deg, ${n.c1}, ${n.c2})` : 'none';
    touch();
  };
  if (!g) {
    return (
      <button className="vis-tool pe-mas" onClick={() => { const n = { a: 135, c1: '#B4C64E', c2: '#4B5327' }; aplicar(n); setG(n); commit(); }}>
        + {t('editor.addGradient')}
      </button>
    );
  }
  return (
    <div className="pe-sub">
      <div className="pe-sub__cab">
        <span>{t('editor.gradient')}</span>
        <button className="vis-insp__quitar" onClick={() => { aplicar(null); setG(null); commit(); }} title={t('editor.remove')} aria-label={t('editor.remove')}>×</button>
      </div>
      <ColorPicker label={t('editor.colorFrom')} valor={g.c1} commit={commit} cambiar={(c) => aplicar({ ...ref.current, c1: c })} />
      <ColorPicker label={t('editor.colorTo')} valor={g.c2} commit={commit} cambiar={(c) => aplicar({ ...ref.current, c2: c })} />
      <Range label={t('editor.angle')} min={0} max={360} step={1} unit="°" commit={commit} get={() => g.a} set={(v) => aplicar({ ...ref.current, a: v })} />
    </div>
  );
}

function Borde({ el, cs, commit, touch, t }) {
  const [trazo, setTrazo] = useState(cs.borderTopStyle === 'none' ? 'solid' : cs.borderTopStyle);
  return (
    <Sec id="border" title={t('editor.border')} abierta={false}>
      <Range label={t('editor.borderWidth')} min={0} max={40} step={1} unit="px" commit={commit}
        get={() => parseFloat(cs.borderTopWidth) || 0}
        set={(v) => { el.style.borderWidth = px(v); el.style.borderStyle = v ? trazo : 'none'; touch(); }} />
      <Fila label={t('editor.borderStyle')}>
        <Seg valor={trazo} cambiar={(v) => { el.style.borderStyle = v; setTrazo(v); commit(); }}
          opciones={['solid', 'dashed', 'dotted'].map((k) => [k, t(`editor.borderStyles.${k}`)])} />
      </Fila>
      <ColorField label={t('editor.borderColor')} el={el} prop="borderColor" commit={commit} />
      <Range label={t('editor.radius')} min={0} max={400} step={1} unit="px" commit={commit}
        get={() => parseFloat(cs.borderTopLeftRadius) || 0} set={(v) => { el.style.borderRadius = px(v); touch(); }} />
    </Sec>
  );
}

function CamposSombra({ el, prop, commit, touch, t }) {
  const [s, setS] = useState(() => leerSombra(cssOf(el)[prop]));
  const [ver, setVer] = useState(0);
  const ref = useRef(s);
  const aplicar = (n) => {
    ref.current = n;
    setS(n);
    el.style[prop] = n
      ? `${px(n.x)} ${px(n.y)} ${px(n.b)}${prop === 'boxShadow' ? ` ${px(n.s)}` : ''} ${rgba(n.hex, n.a)}`
      : 'none';
    touch();
  };
  const campo = (k) => (v) => aplicar({ ...(ref.current || SOMBRAS.soft), [k]: v });
  return (
    <>
      <Fila label={t('editor.shadowPreset')}>
        <select className="vis-insp__valor pe-select" value="" onChange={(e) => { aplicar(SOMBRAS[e.target.value]); setVer((n) => n + 1); commit(); }}>
          <option value="" disabled>{t('editor.shadowChoose')}</option>
          {Object.keys(SOMBRAS).map((k) => <option key={k} value={k}>{t(`editor.shadowPresets.${k}`)}</option>)}
        </select>
      </Fila>
      {s && (
        <div key={ver} className="pe-sub">
          <div className="pe-xywh">
            <Num label="X" title={t('editor.shadowX')} value={s.x} unit="px" onChange={campo('x')} onCommit={() => commit()} />
            <Num label="Y" title={t('editor.shadowY')} value={s.y} unit="px" onChange={campo('y')} onCommit={() => commit()} />
            <Num label="B" title={t('editor.blur')} value={s.b} min={0} unit="px" onChange={campo('b')} onCommit={() => commit()} />
            {prop === 'boxShadow' && <Num label="S" title={t('editor.spread')} value={s.s} unit="px" onChange={campo('s')} onCommit={() => commit()} />}
          </div>
          <ColorPicker label={t('editor.shadowColor')} valor={s.hex} commit={commit} cambiar={(c) => campo('hex')(c)} />
          <Range label={t('editor.shadowAlpha')} min={0} max={1} step={0.01} commit={commit} get={() => s.a} set={campo('a')} />
        </div>
      )}
    </>
  );
}

function Sombra({ el, commit, touch, t }) {
  const [destino, setDestino] = useState('boxShadow');
  return (
    <Sec id="shadow" title={t('editor.shadow')} abierta={false}>
      {tieneTexto(el) && (
        <Fila label={t('editor.shadowTarget')}>
          <Seg valor={destino} cambiar={setDestino} opciones={[['boxShadow', t('editor.shadowTargets.box')], ['textShadow', t('editor.shadowTargets.text')]]} />
        </Fila>
      )}
      <CamposSombra key={destino} el={el} prop={destino} commit={commit} touch={touch} t={t} />
    </Sec>
  );
}

function Efectos({ el, cs, commit, touch, t }) {
  const leerBlur = (v) => { const m = /blur\(([\d.]+)px\)/.exec(v || ''); return m ? +m[1] : 0; };
  const fijarBlur = (prop, v) => {
    const resto = (el.style[prop] || '').replace(/blur\([^)]*\)/, '').trim();
    el.style[prop] = [resto, v ? `blur(${v}px)` : ''].filter(Boolean).join(' ');
    touch();
  };
  const capa = (arriba) => {
    const zs = hijos(el.parentElement).filter((x) => x !== el).map((x) => parseInt(cssOf(x).zIndex, 10) || 0);
    if (cssOf(el).position === 'static') el.style.position = 'relative';
    // Con z negativo el elemento pasaría detrás del fondo del padre si este no aísla su apilamiento.
    if (!arriba && el.parentElement !== el.ownerDocument.body) el.parentElement.style.isolation = 'isolate';
    el.style.zIndex = String(arriba ? Math.max(0, ...zs) + 1 : Math.min(0, ...zs) - 1);
    commit();
  };
  return (
    <Sec id="fx" title={t('editor.effects')} abierta={false}>
      <Range label={t('editor.opacity')} min={0} max={1} step={0.01} commit={commit}
        get={() => +cs.opacity} set={(v) => { el.style.opacity = v; touch(); }} />
      <Range label={t('editor.layerBlur')} min={0} max={40} step={0.5} unit="px" commit={commit}
        get={() => leerBlur(cs.filter)} set={(v) => fijarBlur('filter', v)} />
      <Range label={t('editor.backdropBlur')} min={0} max={40} step={0.5} unit="px" commit={commit}
        get={() => leerBlur(cs.backdropFilter)} set={(v) => fijarBlur('backdropFilter', v)} />
      <Fila label={t('editor.blend')}>
        <select className="vis-insp__valor pe-select" defaultValue={cs.mixBlendMode} onChange={(e) => { el.style.mixBlendMode = e.target.value; commit(); }}>
          {FUSIONES.map((k) => <option key={k} value={k}>{t(`editor.blends.${k}`)}</option>)}
        </select>
      </Fila>
      <Fila label={t('editor.layer')}>
        <div className="pe-acciones pe-acciones--fila">
          <button className="vis-tool" onClick={() => capa(true)}>{t('editor.front')}</button>
          <button className="vis-tool" onClick={() => capa(false)}>{t('editor.back')}</button>
        </div>
      </Fila>
    </Sec>
  );
}

function Lados({ titulo, el, cs, prop, min, commit, touch, t }) {
  const lados = ['Top', 'Right', 'Bottom', 'Left'];
  return (
    <Fila label={titulo}>
      <div className="pe-xywh pe-xywh--4">
        {lados.map((l) => (
          <Num key={l} label={{ Top: '↑', Right: '→', Bottom: '↓', Left: '←' }[l]} title={`${titulo} · ${t(`editor.sides.${l.toLowerCase()}`)}`}
            value={parseFloat(cs[`${prop}${l}`]) || 0} min={min} onCommit={() => commit()}
            onChange={(v) => { el.style[`${prop}${l}`] = px(v); touch(); }} />
        ))}
      </div>
    </Fila>
  );
}

function Inspector({ doc, el, pick, commit, t, touch, insertar }) {
  const isBody = el === doc.body;
  const isImg = el.tagName === 'IMG';
  const cs = cssOf(el);
  const [html, setHtml] = useState(() => el.innerHTML.trim());
  const [src, setSrc] = useState(() => el.getAttribute('src') || '');
  const [encaje, setEncaje] = useState(cs.objectFit);
  const [hayEstilo, setHayEstilo] = useState(!!estiloCopiado);
  const kids = hijos(el);
  const temaActual = TEMAS.find((x) => doc.body.classList.contains(`t-${x}`));

  const copiarEstilo = () => {
    estiloCopiado = Object.fromEntries(ESTILO_COPIABLE.map((p) => [p, cs.getPropertyValue(p)]));
    setHayEstilo(true);
  };
  const pegarEstilo = () => {
    Object.entries(estiloCopiado || {}).forEach(([p, v]) => el.style.setProperty(p, v));
    commit(true);
  };

  return (
    <>
      {isBody && [...doc.body.classList].some((c) => c.startsWith('t-')) && (
        <Sec id="theme" title={t('editor.theme')}>
          <Seg valor={temaActual} opciones={TEMAS.map((x) => [x, t(`editor.themes.${x}`)])} cambiar={(x) => {
            [...doc.body.classList].filter((c) => c.startsWith('t-')).forEach((c) => doc.body.classList.remove(c));
            doc.body.classList.add(`t-${x}`);
            commit(true);
          }} />
        </Sec>
      )}

      {!isBody && !isImg && (
        <Sec id="text" title={t('editor.text')}>
          <textarea className="vis-insp__texto" rows={3} value={html}
            onChange={(e) => { setHtml(e.target.value); el.innerHTML = e.target.value; touch(); }} onBlur={() => commit()} />
          <p className="vis-insp__nota">{t('editor.markHint')}</p>
        </Sec>
      )}

      {isImg && (
        <Sec id="image" title={t('editor.image')}>
          <Fila label={t('editor.imageUrl')}>
            <input className="vis-insp__valor pe-input" value={src} spellCheck={false} placeholder="https://…"
              onChange={(e) => setSrc(e.target.value)}
              onBlur={() => { if (src && src !== el.getAttribute('src')) { el.setAttribute('src', src); commit(); } }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          </Fila>
          <Fila label={t('editor.fit')}>
            <Seg valor={encaje} cambiar={(v) => { el.style.objectFit = v; setEncaje(v); commit(); }}
              opciones={['cover', 'contain', 'fill'].map((k) => [k, t(`editor.fits.${k}`)])} />
          </Fila>
        </Sec>
      )}

      {!isBody && <Geometria doc={doc} el={el} commit={commit} touch={touch} t={t} />}

      {kids.length > 0 && !isImg && <Disposicion el={el} commit={commit} touch={touch} t={t} />}

      {tieneTexto(el) && !isImg && <Tipografia doc={doc} el={el} cs={cs} commit={commit} touch={touch} t={t} />}

      <Sec id="colors" title={t('editor.colors')}>
        {!isImg && tieneTexto(el) && <ColorField label={t('editor.colorText')} el={el} prop="color" commit={commit} />}
        <ColorField label={t('editor.colorBg')} el={el} prop="backgroundColor" commit={commit} clearLabel={t('editor.remove')} />
        <Degradado el={el} cs={cs} commit={commit} touch={touch} t={t} />
      </Sec>

      {!isBody && <Borde el={el} cs={cs} commit={commit} touch={touch} t={t} />}
      {!isBody && <Sombra el={el} commit={commit} touch={touch} t={t} />}

      <Sec id="space" title={t('editor.space')} abierta={false}>
        <Lados titulo={t('editor.padding')} el={el} cs={cs} prop="padding" min={0} commit={commit} touch={touch} t={t} />
        {!isBody && <Lados titulo={t('editor.margin')} el={el} cs={cs} prop="margin" commit={commit} touch={touch} t={t} />}
      </Sec>

      {!isBody && <Efectos el={el} cs={cs} commit={commit} touch={touch} t={t} />}

      <Sec id="insert" title={t('editor.insert')} abierta={false}>
        <div className="pe-acciones pe-acciones--3">
          <button className="vis-tool" onClick={() => insertar('text')}>{t('editor.addText')}</button>
          <button className="vis-tool" onClick={() => insertar('shape')}>{t('editor.addShape')}</button>
          <button className="vis-tool" onClick={() => insertar('img')}>{t('editor.addImage')}</button>
        </div>
      </Sec>

      {!isBody && (
        <Sec id="actions" title={t('editor.actions')}>
          <div className="pe-acciones">
            <button className="vis-tool" onClick={() => { const p = el.previousElementSibling; if (p) { p.before(el); commit(); } }}>↑ {t('editor.up')}</button>
            <button className="vis-tool" onClick={() => { const n = el.nextElementSibling; if (n) { n.after(el); commit(); } }}>↓ {t('editor.down')}</button>
            <button className="vis-tool" onClick={() => { const c = el.cloneNode(true); el.after(c); pick(c); commit(); }} title="Ctrl+D">{t('editor.duplicate')}</button>
            <button className="vis-tool" onClick={() => pick(el.parentElement)}>{t('editor.container')}</button>
            <button className="vis-tool" onClick={copiarEstilo}>{t('editor.copyStyle')}</button>
            <button className="vis-tool" onClick={pegarEstilo} disabled={!hayEstilo}>{t('editor.pasteStyle')}</button>
            <button className="vis-tool is-danger" onClick={() => { const p = el.parentElement; el.remove(); pick(p); commit(); }} title="Supr">{t('editor.del')}</button>
          </div>
        </Sec>
      )}

      {kids.length > 0 && (
        <Sec id="kids" title={isBody ? t('editor.sections') : t('editor.inside')}>
          <ListaHijos items={kids} pick={pick} t={t} />
        </Sec>
      )}
    </>
  );
}

export function PiezaEditor({ html, meta, baseHref, nombre, onSave, onClose, saving, message }) {
  const t = useT('visual');
  const [w, h] = medidas(meta);
  const isVideo = meta.kind === 'video';

  const frameRef = useRef(null);
  const pvRef = useRef(null);
  const wrapRef = useRef(null);
  const docRef = useRef(null);
  const selRef = useRef(null);
  const scaleRef = useRef(1);
  const undoRef = useRef([]);
  const redoRef = useRef([]);
  const guardadoRef = useRef('');
  const timerRef = useRef(null);
  const curTRef = useRef(0);
  const playingRef = useRef(false);
  const teclasRef = useRef(null);

  const [srcDoc, setSrcDoc] = useState(() => paraWeb(html, baseHref));
  const [boxes, setBoxes] = useState({ sel: null, hov: null });
  const [guias, setGuias] = useState(null);
  const [editando, setEditando] = useState(false);
  const [selKey, setSelKey] = useState(0);
  const [tab, setTab] = useState('d');
  const [code, setCode] = useState('');
  const [codeDirty, setCodeDirty] = useState(false);
  const [curT, setCurT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [scenes, setScenes] = useState([]);
  const [zoom, setZoom] = useState(null);
  const [, setHist] = useState(0);

  const ajuste = useEncaje(pvRef, w, h);
  const scale = zoom ?? ajuste;

  const rectOf = useCallback((el) => {
    if (!el || !docRef.current || el === docRef.current.documentElement) return null;
    const r = el.getBoundingClientRect();
    const s = scaleRef.current;
    return { left: r.left * s, top: r.top * s, width: r.width * s, height: r.height * s };
  }, []);

  const refreshBoxes = useCallback(() => {
    if (docRef.current) setBoxes((b) => ({ ...b, sel: rectOf(selRef.current) }));
  }, [rectOf]);

  useLayoutEffect(() => { scaleRef.current = scale; refreshBoxes(); }, [scale, refreshBoxes]);

  const serialize = useCallback(() => {
    const c = docRef.current.documentElement.cloneNode(true);
    c.querySelectorAll('[contenteditable]').forEach((e) => e.removeAttribute('contenteditable'));
    return paraGuardar(`<!doctype html>\n${c.outerHTML}`);
  }, []);

  const snap = () => {
    const b = docRef.current.body;
    return JSON.stringify({ c: b.className, s: b.getAttribute('style'), h: b.innerHTML });
  };

  const setTime = useCallback((tm) => {
    curTRef.current = tm;
    setCurT(tm);
    const d = docRef.current;
    if (d && isVideo) d.getAnimations().forEach((a) => { a.pause(); a.currentTime = tm * 1000; });
    refreshBoxes();
  }, [isVideo, refreshBoxes]);

  /** Registra el estado en el historial; `refrescar` vuelve a leer el panel. */
  const commit = useCallback((refrescar = false) => {
    refreshBoxes();
    if (refrescar === true) setSelKey((k) => k + 1);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const s = snap();
      if (undoRef.current[undoRef.current.length - 1] !== s) {
        undoRef.current.push(s);
        if (undoRef.current.length > 80) undoRef.current.shift();
        redoRef.current = [];
        setHist((n) => n + 1);
      }
    }, 350);
    if (isVideo && !playingRef.current) setTime(curTRef.current);
  }, [isVideo, refreshBoxes, setTime]);

  const pick = useCallback((el) => {
    const d = docRef.current;
    if (!el || !d) return;
    selRef.current = el === d.documentElement ? d.body : el;
    setSelKey((k) => k + 1);
    refreshBoxes();
  }, [refreshBoxes]);

  const deseleccionar = () => { selRef.current = null; setSelKey((k) => k + 1); setBoxes({ sel: null, hov: null }); };

  const restore = useCallback((s) => {
    const d = docRef.current;
    const o = JSON.parse(s);
    const p = selRef.current ? pathOf(d.body, selRef.current) : [];
    d.body.className = o.c;
    if (o.s == null) d.body.removeAttribute('style'); else d.body.setAttribute('style', o.s);
    d.body.innerHTML = o.h;
    selRef.current = fromPath(d.body, p) || d.body;
    setSelKey((k) => k + 1);
    if (isVideo) setTime(curTRef.current); else refreshBoxes();
  }, [isVideo, refreshBoxes, setTime]);

  const undo = useCallback(() => {
    clearTimeout(timerRef.current);
    const cur = snap();
    if (undoRef.current.length && undoRef.current[undoRef.current.length - 1] !== cur) undoRef.current.push(cur);
    if (undoRef.current.length < 2) return;
    redoRef.current.push(undoRef.current.pop());
    restore(undoRef.current[undoRef.current.length - 1]);
    setHist((n) => n + 1);
  }, [restore]);

  const redo = useCallback(() => {
    if (!redoRef.current.length) return;
    const s = redoRef.current.pop();
    undoRef.current.push(s);
    restore(s);
    setHist((n) => n + 1);
  }, [restore]);

  const editarTexto = useCallback((el) => {
    const d = docRef.current;
    if (!el || el === d.body || !tieneTexto(el)) return;
    pick(el);
    setEditando(true);
    el.contentEditable = 'true';
    el.focus();
    el.onblur = () => {
      el.removeAttribute('contenteditable');
      el.onblur = null;
      setEditando(false);
      commit(true);
    };
  }, [commit, pick]);

  const enPunto = (clientX, clientY) => {
    const d = docRef.current;
    const r = wrapRef.current.getBoundingClientRect();
    const s = scaleRef.current;
    return d.elementsFromPoint((clientX - r.left) / s, (clientY - r.top) / s)
      .find((el) => el !== d.documentElement && seen(el)) || d.body;
  };

  const insertar = (tipo) => {
    const d = docRef.current;
    const nuevo = d.createElement(tipo === 'img' ? 'img' : tipo === 'text' ? 'p' : 'div');
    const base = 'position:absolute;left:0;top:0;z-index:10;margin:0;';
    if (tipo === 'text') {
      nuevo.textContent = t('editor.newText');
      nuevo.style.cssText = `${base}font-size:64px;font-weight:600;line-height:1.1`;
    } else if (tipo === 'shape') {
      nuevo.style.cssText = `${base}width:240px;height:240px;border-radius:24px;background:#B4C64E`;
    } else {
      nuevo.src = '/icon-512.png';
      nuevo.alt = '';
      nuevo.style.cssText = `${base}width:240px;height:240px;object-fit:contain`;
    }
    d.body.append(nuevo);
    const r = nuevo.getBoundingClientRect();
    nuevo.style.left = px((d.documentElement.clientWidth - r.width) / 2);
    nuevo.style.top = px((d.documentElement.clientHeight - r.height) / 2);
    pick(nuevo);
    commit();
  };

  /** Mover (dir = 'move') o redimensionar desde un tirador, con guías de alineación. */
  const arrastrar = (e, dir) => {
    const d = docRef.current;
    const el = selRef.current;
    if (e.button !== 0 || !d || !el || el === d.body) return;
    e.preventDefault();
    e.stopPropagation();
    const nodo = e.currentTarget;
    nodo.setPointerCapture(e.pointerId);
    const s = scaleRef.current;
    const r0 = el.getBoundingClientRect();
    const [tx0, ty0] = leerTraslado(el);
    const w0 = el.offsetWidth ?? r0.width;
    const h0 = el.offsetHeight ?? r0.height;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const W = d.documentElement.clientWidth;
    const H = d.documentElement.clientHeight;
    const otros = hijos(el.parentElement).filter((x) => x !== el).map((x) => x.getBoundingClientRect());
    const gx = [0, W / 2, W, ...otros.flatMap((r) => [r.left, r.left + r.width / 2, r.right])];
    const gy = [0, H / 2, H, ...otros.flatMap((r) => [r.top, r.top + r.height / 2, r.bottom])];
    const umbral = 6 / s;
    let movido = false;

    const mover = (ev) => {
      const dx = (ev.clientX - x0) / s;
      const dy = (ev.clientY - y0) / s;
      if (!movido && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return;
      movido = true;
      if (dir === 'move') {
        let nx = dx;
        let ny = dy;
        if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) ny = 0; else nx = 0; }
        const sx = ev.altKey ? null : ajustar([r0.left + nx, r0.left + nx + r0.width / 2, r0.right + nx], gx, umbral);
        const sy = ev.altKey ? null : ajustar([r0.top + ny, r0.top + ny + r0.height / 2, r0.bottom + ny], gy, umbral);
        fijarTraslado(el, tx0 + nx + (sx?.d || 0), ty0 + ny + (sy?.d || 0));
        setGuias({ x: sx?.pos, y: sy?.pos });
      } else {
        const kw = dir.includes('e') ? 1 : dir.includes('w') ? -1 : 0;
        const kh = dir.includes('s') ? 1 : dir.includes('n') ? -1 : 0;
        let nw = w0 + kw * dx;
        let nh = h0 + kh * dy;
        if ((el.tagName === 'IMG' || ev.shiftKey) && kw && kh) {
          const f = Math.max(nw / w0, nh / h0);
          nw = w0 * f;
          nh = h0 * f;
        }
        el.style.boxSizing = 'border-box';
        el.style.maxWidth = 'none';
        if (cssOf(el.parentElement).display.includes('flex')) el.style.flexShrink = '0';
        if (kw) el.style.width = px(Math.max(8, nw));
        if (kh) el.style.height = px(Math.max(8, nh));
        // El padre puede recolocar el elemento al cambiar de tamaño (centrado, flex):
        // se corrige el desplazamiento para que el lado opuesto al tirador no se mueva.
        fijarTraslado(el, tx0, ty0);
        const r = el.getBoundingClientRect();
        fijarTraslado(el, tx0 + (kw === -1 ? r0.right - r.right : r0.left - r.left),
          ty0 + (kh === -1 ? r0.bottom - r.bottom : r0.top - r.top));
      }
      refreshBoxes();
    };
    const soltar = (ev) => {
      nodo.removeEventListener('pointermove', mover);
      setGuias(null);
      if (movido) commit(true);
      else if (dir === 'move') pick(enPunto(ev.clientX, ev.clientY));
    };
    nodo.addEventListener('pointermove', mover);
    nodo.addEventListener('pointerup', soltar, { once: true });
  };

  teclasRef.current = (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
    const d = docRef.current;
    const el = selRef.current;
    if (e.key === 'Escape' && el) { deseleccionar(); return; }
    if (!d || !el || el === d.body || tab !== 'd') return;
    const flechas = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (flechas[e.key]) {
      e.preventDefault();
      const paso = e.shiftKey ? 10 : 1;
      const [x, y] = leerTraslado(el);
      fijarTraslado(el, x + flechas[e.key][0] * paso, y + flechas[e.key][1] * paso);
      commit(true);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const p = el.parentElement;
      el.remove();
      pick(p);
      commit();
    } else if (mod && k === 'd') {
      e.preventDefault();
      const c = el.cloneNode(true);
      el.after(c);
      pick(c);
      commit();
    } else if (e.key === 'Enter' && tieneTexto(el)) {
      e.preventDefault();
      editarTexto(el);
    }
  };

  const onFrameLoad = useCallback(() => {
    const d = frameRef.current.contentDocument;
    docRef.current = d;
    selRef.current = null;
    setSelKey((k) => k + 1);
    const hit = (e) => d.elementsFromPoint(e.clientX, e.clientY).find((el) => el !== d.documentElement && seen(el)) || d.body;
    d.addEventListener('click', (e) => {
      if (e.target.isContentEditable) return;
      e.preventDefault(); e.stopPropagation();
      pick(hit(e));
    }, true);
    d.addEventListener('dblclick', (e) => editarTexto(hit(e)));
    d.addEventListener('mousemove', (e) => {
      const el = hit(e);
      setBoxes((b) => ({ ...b, hov: el === selRef.current ? null : rectOf(el) }));
    });
    d.addEventListener('mouseleave', () => setBoxes((b) => ({ ...b, hov: null })));
    d.addEventListener('keydown', (e) => teclasRef.current(e));
    undoRef.current = [snap()];
    redoRef.current = [];
    if (!guardadoRef.current) guardadoRef.current = undoRef.current[0];
    if (isVideo) {
      const sc = [...d.querySelectorAll('.escena')].map((s) => {
        const ini = parseFloat(s.style.getPropertyValue('--ini')) || 0;
        const dur = parseFloat(s.style.getPropertyValue('--dur')) || 3;
        return { ini, dur };
      });
      setScenes(sc);
      setTime(sc[0] ? sc[0].ini + sc[0].dur * 0.85 : 0);
    }
    refreshBoxes();
    setHist((n) => n + 1);
  }, [editarTexto, isVideo, pick, refreshBoxes, rectOf, setTime]);

  const sucio = codeDirty || (!!docRef.current && undoRef.current.length > 0
    && undoRef.current[undoRef.current.length - 1] !== guardadoRef.current);

  useEffect(() => {
    const onKey = (e) => teclasRef.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const node = pvRef.current;
    if (!node) return undefined;
    const rueda = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => Math.min(4, Math.max(0.05, (z ?? scaleRef.current) * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
    };
    node.addEventListener('wheel', rueda, { passive: false });
    return () => node.removeEventListener('wheel', rueda);
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const pasoZoom = (dir) => {
    const z = scale;
    const sig = dir > 0 ? ZOOMS.find((x) => x > z + 0.001) : [...ZOOMS].reverse().find((x) => x < z - 0.001);
    if (sig) setZoom(sig);
  };

  const play = () => {
    if (playingRef.current) { playingRef.current = false; setPlaying(false); return; }
    playingRef.current = true;
    setPlaying(true);
    const t0 = performance.now();
    const base = curTRef.current >= meta.seconds - 0.05 ? 0 : curTRef.current;
    const step = (now) => {
      if (!playingRef.current) return;
      const tm = base + (now - t0) / 1000;
      if (tm >= meta.seconds) { playingRef.current = false; setPlaying(false); setTime(meta.seconds); return; }
      setTime(tm);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  const showCode = () => { if (tab === 'c') return; setCode(serialize()); setCodeDirty(false); setTab('c'); };
  const showDesign = () => {
    if (codeDirty) { setSrcDoc(paraWeb(code, baseHref)); setCodeDirty(false); }
    setTab('d');
  };
  const guardar = async () => {
    const ok = await onSave(tab === 'c' && codeDirty ? code : serialize());
    if (ok === false) return;
    clearTimeout(timerRef.current);
    if (docRef.current) guardadoRef.current = snap();
    setCodeDirty(false);
    setHist((n) => n + 1);
  };

  const sel = selRef.current;
  const esCuerpo = !!sel && sel === docRef.current?.body;
  const b = boxes.sel;
  const cadena = [];
  if (sel && docRef.current) for (let e = sel; e; e = e === docRef.current.body ? null : e.parentElement) cadena.unshift(e);

  return (
    <>
      <div className="vis-lienzo">
        <div className="vis-stagebar">
          <div className="vis-pestanas">
            <span className="vis-pestana is-on"><IconPencil size={13} /> {nombre}</span>
            <span className="pe-medida">{w}×{h}{isVideo ? ` · ${meta.seconds}s` : ''}</span>
            <div className="pe-zoom">
              <button className="vis-tool vis-tool--icono" onClick={() => pasoZoom(-1)} title={t('editor.zoomOut')} aria-label={t('editor.zoomOut')}>−</button>
              <button className="pe-zoom__pct" onClick={() => setZoom(null)} title={t('editor.zoomFit')}>{Math.round(scale * 100)}%</button>
              <button className="vis-tool vis-tool--icono" onClick={() => pasoZoom(1)} title={t('editor.zoomIn')} aria-label={t('editor.zoomIn')}>+</button>
            </div>
          </div>
          <div className="vis-stagebar__der">
            {(saving || message) && <span className="pe-msg" role="status">{saving ? t('editor.saving') : message}</span>}
            <button className="vis-tool vis-tool--icono" onClick={undo} disabled={undoRef.current.length < 2} title={`${t('editor.undo')} (Ctrl+Z)`} aria-label={t('editor.undo')}><IconUndo size={15} /></button>
            <button className="vis-tool vis-tool--icono" onClick={redo} disabled={!redoRef.current.length} title={`${t('editor.redo')} (Ctrl+Shift+Z)`} aria-label={t('editor.redo')}><IconRedo size={15} /></button>
            <button className="vis-tool" onClick={() => onClose(sucio)}>{t('editor.close')}</button>
            <button className="vis-tool vis-tool--blanco" onClick={guardar} disabled={saving || !sucio}><IconCheck size={14} /> {t('editor.save')}</button>
          </div>
        </div>
        <div className="vis-stage pe-stage" ref={pvRef}>
          <div className="pe-wrap" ref={wrapRef} style={{ width: w * scale, height: h * scale }}>
            <iframe
              ref={frameRef} title={nombre} sandbox="allow-same-origin" srcDoc={srcDoc} onLoad={onFrameLoad}
              style={{ width: w, height: h, transform: `scale(${scale})` }}
            />
            {boxes.hov && <div className="pe-ov pe-ov--hov" style={{ left: boxes.hov.left, top: boxes.hov.top, width: boxes.hov.width, height: boxes.hov.height }} />}
            {b && (esCuerpo || editando || tab !== 'd' ? (
              <div className="pe-ov pe-ov--sel" style={{ left: b.left, top: b.top, width: b.width, height: b.height }} />
            ) : (
              <div className="pe-ov pe-ov--sel pe-sel" style={{ left: b.left, top: b.top, width: b.width, height: b.height }}
                onPointerDown={(e) => arrastrar(e, 'move')} onDoubleClick={(e) => editarTexto(enPunto(e.clientX, e.clientY))}>
                {TIRADORES.map((dd) => <span key={dd} className={`pe-h pe-h--${dd}`} onPointerDown={(e) => arrastrar(e, dd)} />)}
                <span className="pe-sel__dim">{Math.round(b.width / scale)} × {Math.round(b.height / scale)}</span>
              </div>
            ))}
            {guias?.x != null && <div className="pe-guia pe-guia--x" style={{ left: guias.x * scale }} />}
            {guias?.y != null && <div className="pe-guia pe-guia--y" style={{ top: guias.y * scale }} />}
          </div>
        </div>
        {isVideo && (
          <div className="pe-tl">
            <button className="vis-tool vis-tool--icono" onClick={play} aria-label={playing ? t('editor.pause') : t('editor.play')} title={playing ? t('editor.pause') : t('editor.play')}>
              {playing ? <IconStop size={15} /> : <IconPlay size={15} />}
            </button>
            <input
              type="range" className="pe-range" min="0" max={meta.seconds} step="0.05" value={curT} style={{ '--p': `${(curT / meta.seconds) * 100}%` }}
              onChange={(e) => { playingRef.current = false; setPlaying(false); setTime(+e.target.value); }} aria-label={t('editor.time')}
            />
            <output>{curT.toFixed(1)} s</output>
            {scenes.map((s, i) => (
              <button key={i} className="vis-tool" onClick={() => { playingRef.current = false; setPlaying(false); setTime(s.ini + s.dur * 0.85); }}>
                {t('editor.scene', { n: i + 1 })}
              </button>
            ))}
          </div>
        )}
      </div>
      <aside className="vis-insp pe-panel" aria-label={t('editor.design')}>
        <div className="vis-insp__cab">
          <div className="vis-insp__tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'd'} className={tab === 'd' ? 'is-on' : ''} onClick={showDesign}>{t('editor.design')}</button>
            <button role="tab" aria-selected={tab === 'c'} className={tab === 'c' ? 'is-on' : ''} onClick={showCode}>{t('editor.code')}</button>
          </div>
          {tab === 'd' && sel && (
            <div className="pe-crumb">
              {cadena.map((e, i) => (
                <span key={i}>
                  <button onClick={() => pick(e)} className={e === sel ? 'is-on' : ''}>{e === docRef.current.body ? t('editor.page') : e.tagName.toLowerCase()}</button>
                  {i < cadena.length - 1 && <span className="pe-crumb__sep">›</span>}
                </span>
              ))}
            </div>
          )}
        </div>
        {tab === 'd' ? (
          <div className="vis-insp__cuerpo">
            {docRef.current && sel ? (
              <Inspector key={selKey} doc={docRef.current} el={sel} pick={pick} commit={commit} t={t} touch={refreshBoxes} insertar={insertar} />
            ) : (
              <>
                <p className="vis-insp__nota">{t('editor.hint')}</p>
                {docRef.current && (
                  <Sec id="kids" title={t('editor.sections')}>
                    <ListaHijos items={hijos(docRef.current.body)} pick={pick} t={t} />
                  </Sec>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="vis-insp__cuerpo pe-codigo">
            <textarea className="vis-insp__texto vis-insp__texto--mono" spellCheck={false} value={code}
              onChange={(e) => { setCode(e.target.value); setCodeDirty(true); }} />
          </div>
        )}
      </aside>
    </>
  );
}
