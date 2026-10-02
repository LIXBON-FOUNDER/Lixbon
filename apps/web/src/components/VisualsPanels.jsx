// VisualsPanels.jsx — piezas de Visuals: selector de design system (con uno
// propio) e inspector del elemento seleccionado en el lienzo.
import { useEffect, useRef, useState } from 'react';
import { DESIGN_SYSTEMS, designSystemPersonalizado } from '../lib/visuals';
import { IconChevron, IconSearch, IconX } from './Icons';
import { useDismiss } from '../hooks/useDismiss';
import { Desplegable } from './Desplegable';
import { useT } from '../i18n/useT';
import { useLocale } from '../i18n/LocaleContext';

const FORM_VACIO = { nombre: '', primario: '#B4C64E', fondo: '#0E0E0E', texto: '#F2F2F0', fuenteTitulos: 'Inter', fuenteCuerpo: 'Inter', tono: '' };

export function DesignSystemPicker({ value, onChange, compacto = false }) {
  const t = useT('visuals');
  const locale = useLocale();
  const [abierto, setAbierto] = useState(false);
  const [editando, setEditando] = useState(false);
  const [form, setForm] = useState(value?.custom ? value.form : FORM_VACIO);
  const ref = useRef(null);
  useDismiss(abierto, ref, () => { setAbierto(false); setEditando(false); });

  useEffect(() => { if (value?.custom) setForm(value.form); }, [value]);

  const elegir = (ds) => { onChange(ds); setAbierto(false); setEditando(false); };
  const guardarPropio = () => { elegir(designSystemPersonalizado(form)); };

  return (
    <div className={`vis-ds ${compacto ? 'vis-ds--compacto' : ''}`} ref={ref}>
      <button className="vis-ds__btn" onClick={() => setAbierto((v) => !v)} aria-expanded={abierto}>
        <span className="vis-ds__swatch" style={{ background: swatchDe(value) }} />
        <span className="vis-ds__label">{compacto ? '' : t('designSystemLabel')}{value?.label ? value.label[locale] : t('freeform')}</span>
        <IconChevron size={13} open={abierto} />
      </button>
      <Desplegable abierto={abierto} className="vis-ds__menu">
          {!editando ? (
            <>
              {DESIGN_SYSTEMS.map((ds) => (
                <button key={ds.id} className={`vis-ds__item ${value?.id === ds.id ? 'is-active' : ''}`} onClick={() => elegir(ds)}>
                  <span className="vis-ds__swatch" style={{ background: swatchDe(ds) }} />
                  <span className="vis-ds__item-text"><strong>{ds.label[locale]}</strong><small>{ds.desc[locale]}</small></span>
                </button>
              ))}
              {value?.custom && (
                <button className="vis-ds__item is-active" onClick={() => setEditando(true)}>
                  <span className="vis-ds__swatch" style={{ background: value.form.primario }} />
                  <span className="vis-ds__item-text"><strong>{value.label[locale]}</strong><small>{t('ownEdit')}</small></span>
                </button>
              )}
              <button className="vis-ds__item vis-ds__item--nuevo" onClick={() => setEditando(true)}>{t('defineMine')}</button>
            </>
          ) : (
            <div className="vis-ds__form">
              <div className="vis-ds__form-head"><strong>{t('ownDesignSystem')}</strong><button className="icon-btn" onClick={() => setEditando(false)} aria-label={t('close')}><IconX size={14} /></button></div>
              <label>{t('name')}<input value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} placeholder={t('myBrandPlaceholder')} /></label>
              <div className="vis-ds__colores">
                <label>{t('accent')}<input type="color" value={form.primario} onChange={(e) => setForm({ ...form, primario: e.target.value })} /></label>
                <label>{t('background')}<input type="color" value={form.fondo} onChange={(e) => setForm({ ...form, fondo: e.target.value })} /></label>
                <label>{t('text')}<input type="color" value={form.texto} onChange={(e) => setForm({ ...form, texto: e.target.value })} /></label>
              </div>
              <label>{t('headingFont')}<input value={form.fuenteTitulos} onChange={(e) => setForm({ ...form, fuenteTitulos: e.target.value })} placeholder={t('headingFontPlaceholder')} /></label>
              <label>{t('bodyFont')}<input value={form.fuenteCuerpo} onChange={(e) => setForm({ ...form, fuenteCuerpo: e.target.value })} placeholder={t('bodyFontPlaceholder')} /></label>
              <label>{t('tone')}<input value={form.tono} onChange={(e) => setForm({ ...form, tono: e.target.value })} placeholder={t('tonePlaceholder')} /></label>
              <button className="vis-tool vis-tool--primary" onClick={guardarPropio}>{t('useThis')}</button>
            </div>
          )}
      </Desplegable>
    </div>
  );
}

function swatchDe(ds) {
  if (!ds || ds.id === 'libre') return 'conic-gradient(#B4C64E, #1D4ED8, #FF5A36, #B4C64E)';
  if (ds.custom) return ds.form.primario;
  return { lixbon: '#B4C64E', editorial: '#B23A2E', minimal: '#111111', corporativo: '#1D4ED8', vibrante: '#FF5A36', tech: '#22D3EE' }[ds.id] || '#888';
}

const aHex = (color) => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color || '');
  return m ? `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : '#000000';
};
const alfaDe = (color) => {
  const m = /rgba\([^)]*,\s*([\d.]+)\)/.exec(color || '');
  return m ? Number(m[1]) : 1;
};
const transparente = (color) => !color || color === 'transparent' || alfaDe(color) === 0;
const legibleColor = (color) => {
  if (transparente(color)) return '';
  const a = alfaDe(color);
  return `${aHex(color).toUpperCase()}${a < 1 ? ` ${Math.round(a * 100)}%` : ''}`;
};
const primeraFuente = (f) => (f || '').split(',')[0].replace(/["']/g, '').trim();
const aKebab = (k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Campo de texto que confirma al salir o con Enter; se reinicia al cambiar
 *  el valor calculado (otra selección, o el iframe devolviendo el nuevo). */
function Valor({ valor, onCommit, etiqueta, prefijo, mono = true, className = '' }) {
  const confirmar = (e) => {
    const v = e.target.value.trim();
    if (v !== (valor ?? '')) onCommit(v);
  };
  return (
    <label className={`vis-insp__valor ${mono ? 'is-mono' : ''} ${className}`}>
      {prefijo && <span className="vis-insp__pref" aria-hidden="true">{prefijo}</span>}
      <input
        key={valor}
        defaultValue={valor ?? ''}
        aria-label={etiqueta}
        spellCheck={false}
        onBlur={confirmar}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = valor ?? ''; e.currentTarget.blur(); } }}
      />
    </label>
  );
}

function ColorCampo({ valor, onCommit, etiqueta, vacio }) {
  const sin = transparente(valor);
  return (
    <div className="vis-insp__color">
      <label className={`vis-insp__muestra ${sin ? 'is-vacia' : ''}`} style={sin ? undefined : { background: valor }}>
        <input type="color" aria-label={etiqueta} value={aHex(valor)} onChange={(e) => onCommit(e.target.value)} />
      </label>
      <input
        key={valor}
        className="vis-insp__hex"
        aria-label={etiqueta}
        defaultValue={legibleColor(valor)}
        placeholder={vacio}
        spellCheck={false}
        onBlur={(e) => { const v = e.target.value.trim(); if (v !== legibleColor(valor)) onCommit(v.replace(/\s+\d+%$/, '') || 'transparent'); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
    </div>
  );
}

function Seccion({ titulo, children }) {
  return (
    <section className="vis-insp__sec">
      <h3 className="vis-insp__eyebrow">{titulo}</h3>
      {children}
    </section>
  );
}

const ALINEACIONES = [
  { v: 'left', d: 'M4 6h16M4 12h10M4 18h13' },
  { v: 'center', d: 'M4 6h16M7 12h10M5 18h14' },
  { v: 'right', d: 'M4 6h16M10 12h10M7 18h13' },
];

/** Panel del elemento seleccionado: pestaña Diseño (texto, clases, tipografía,
 *  color, caja) y pestaña CSS con todo lo calculado que no es por defecto. */
export function Inspector({ seleccion, onAplicar, onPedir, onCerrar }) {
  const t = useT('visuals');
  const [pestana, setPestana] = useState('diseno');
  const [filtro, setFiltro] = useState('');
  const [nuevaClase, setNuevaClase] = useState('');
  const [nuevaProp, setNuevaProp] = useState({ k: '', v: '' });
  if (!seleccion) return null;

  const st = seleccion.styles || {};
  const css = seleccion.css || {};
  const clases = (seleccion.clases || '').split(/\s+/).filter(Boolean);
  const inline = (seleccion.inline || '').split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const i = d.indexOf(':');
    return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
  }).filter(([k]) => k);
  const estilo = (k, v) => onAplicar({ selector: seleccion.selector, style: { [k]: v } });
  const ponerClases = (lista) => onAplicar({ selector: seleccion.selector, className: lista.join(' ') });
  const editable = seleccion.text !== '' && seleccion.text != null;
  const q = filtro.trim().toLowerCase();
  const calculado = Object.entries(css).filter(([k, v]) => !q || k.includes(q) || String(v).toLowerCase().includes(q));
  const anadirClase = () => {
    const nuevas = nuevaClase.split(/\s+/).filter((c) => c && !clases.includes(c));
    if (nuevas.length) ponerClases([...clases, ...nuevas]);
    setNuevaClase('');
  };
  const anadirProp = () => {
    const k = nuevaProp.k.trim();
    if (k && nuevaProp.v.trim()) estilo(k, nuevaProp.v.trim());
    setNuevaProp({ k: '', v: '' });
  };
  const lado = (tipo, l) => st[`${tipo}${l}`];
  const caja = (tipo, l) => (
    <Valor valor={lado(tipo, l)} etiqueta={`${tipo} ${l}`} className="vis-insp__lado"
      onCommit={(v) => estilo(`${tipo}${l}`, /^-?\d+(\.\d+)?$/.test(v) ? `${v}px` : v)} />
  );

  return (
    <aside className="vis-insp" aria-label={t('inspTabDesign')}>
      <div className="vis-insp__cab">
        <div className="vis-insp__fila">
          <span className="vis-insp__tag">{seleccion.tag}</span>
          <span className="vis-insp__ruta" title={seleccion.selector}>{seleccion.ruta || seleccion.selector}</span>
          <button className="icon-btn" onClick={onCerrar} aria-label={t('inspClose')}><IconX size={14} /></button>
        </div>
        <div className="vis-insp__tabs" role="tablist">
          <button role="tab" aria-selected={pestana === 'diseno'} className={pestana === 'diseno' ? 'is-on' : ''} onClick={() => setPestana('diseno')}>{t('inspTabDesign')}</button>
          <button role="tab" aria-selected={pestana === 'css'} className={pestana === 'css' ? 'is-on' : ''} onClick={() => setPestana('css')}>{t('inspTabCss')} · {Object.keys(css).length}</button>
        </div>
        {pestana === 'css' && (
          <label className="vis-insp__buscar">
            <IconSearch size={14} />
            <input value={filtro} onChange={(e) => setFiltro(e.target.value)} placeholder={t('inspFilter')} aria-label={t('inspFilter')} />
          </label>
        )}
      </div>

      <div className="vis-insp__cuerpo">
        {pestana === 'diseno' ? (
          <>
            {editable && (
              <Seccion titulo={t('text')}>
                <textarea
                  key={seleccion.selector + seleccion.text}
                  className="vis-insp__texto"
                  rows={Math.min(5, Math.max(1, Math.ceil((seleccion.text || '').length / 34)))}
                  defaultValue={seleccion.text}
                  aria-label={t('text')}
                  onBlur={(e) => { if (e.target.value !== seleccion.text) onAplicar({ selector: seleccion.selector, text: e.target.value }); }}
                />
              </Seccion>
            )}

            <Seccion titulo={`${t('inspClasses')} · ${clases.length}`}>
              <div className="vis-insp__clases">
                {clases.map((c) => (
                  <span key={c} className="vis-insp__clase">
                    {c}
                    <button aria-label={`${t('inspUndo')} ${c}`} onClick={() => ponerClases(clases.filter((x) => x !== c))}><IconX size={10} /></button>
                  </span>
                ))}
                <input
                  className="vis-insp__clase-nueva"
                  value={nuevaClase}
                  placeholder={t('inspAddClass')}
                  aria-label={t('inspAddClass')}
                  spellCheck={false}
                  onChange={(e) => setNuevaClase(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') anadirClase(); }}
                  onBlur={anadirClase}
                />
              </div>
            </Seccion>

            <Seccion titulo={t('inspTypography')}>
              <Valor valor={primeraFuente(st.fontFamily)} etiqueta={t('inspFont')} mono={false} onCommit={(v) => estilo('fontFamily', v)} />
              <div className="vis-insp__tres">
                <Valor valor={st.fontSize} prefijo="T" etiqueta={t('size')} onCommit={(v) => estilo('fontSize', v)} />
                <Valor valor={st.fontWeight} prefijo="P" etiqueta={t('weight')} onCommit={(v) => estilo('fontWeight', v)} />
                <Valor valor={st.lineHeight} prefijo="L" etiqueta={t('inspLine')} onCommit={(v) => estilo('lineHeight', v)} />
              </div>
              <div className="vis-insp__dos-auto">
                <Valor valor={st.letterSpacing} prefijo={t('inspTracking')} etiqueta={t('inspTracking')} onCommit={(v) => estilo('letterSpacing', v)} />
                <div className="vis-insp__seg" role="group" aria-label={t('inspAlign')}>
                  {ALINEACIONES.map((a) => (
                    <button key={a.v} className={(st.textAlign === a.v || (a.v === 'left' && st.textAlign === 'start')) ? 'is-on' : ''} aria-label={a.v} onClick={() => estilo('textAlign', a.v)}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d={a.d} /></svg>
                    </button>
                  ))}
                </div>
              </div>
            </Seccion>

            <Seccion titulo={t('inspColors')}>
              <div className="vis-insp__dos">
                <ColorCampo valor={st.color} etiqueta={t('color')} onCommit={(v) => estilo('color', v)} />
                <ColorCampo valor={st.backgroundColor} etiqueta={t('background')} vacio={t('inspNoBg')} onCommit={(v) => estilo('backgroundColor', v)} />
              </div>
            </Seccion>

            <Seccion titulo={t('inspSpacing')}>
              <div className="vis-insp__caja">
                <span className="vis-insp__caja-nombre">{t('inspMargin')}</span>
                <div className="vis-insp__caja-v">{caja('margin', 'Top')}</div>
                <div className="vis-insp__caja-h">
                  {caja('margin', 'Left')}
                  <div className="vis-insp__caja vis-insp__caja--dentro">
                    <span className="vis-insp__caja-nombre">{t('inspPaddingBox')}</span>
                    <div className="vis-insp__caja-v">{caja('padding', 'Top')}</div>
                    <div className="vis-insp__caja-h">
                      {caja('padding', 'Left')}
                      <span className="vis-insp__medida">{seleccion.medidas ? `${seleccion.medidas.w} × ${seleccion.medidas.h}` : '—'}</span>
                      {caja('padding', 'Right')}
                    </div>
                    <div className="vis-insp__caja-v">{caja('padding', 'Bottom')}</div>
                  </div>
                  {caja('margin', 'Right')}
                </div>
                <div className="vis-insp__caja-v">{caja('margin', 'Bottom')}</div>
              </div>
            </Seccion>

            <Seccion titulo={t('inspBorder')}>
              <div className="vis-insp__tres">
                <Valor valor={st.borderRadius} prefijo="R" etiqueta={t('radius')} onCommit={(v) => estilo('borderRadius', v)} />
                <Valor valor={st.borderTopWidth} prefijo="B" etiqueta={t('inspBorderWidth')} onCommit={(v) => estilo('borderWidth', v)} />
                <Valor valor={st.opacity} prefijo="O" etiqueta={t('inspOpacity')} onCommit={(v) => estilo('opacity', v)} />
              </div>
            </Seccion>
          </>
        ) : (
          <>
            <Seccion titulo={t('inspClasses')}>
              <textarea
                key={seleccion.selector + seleccion.clases}
                className="vis-insp__texto vis-insp__texto--mono"
                rows={Math.min(6, Math.max(2, Math.ceil((seleccion.clases || '').length / 34)))}
                defaultValue={seleccion.clases}
                placeholder={t('inspNoClasses')}
                aria-label={t('inspClasses')}
                spellCheck={false}
                onBlur={(e) => { const v = e.target.value.trim().replace(/\s+/g, ' '); if (v !== (seleccion.clases || '').trim()) onAplicar({ selector: seleccion.selector, className: v }); }}
              />
            </Seccion>

            {inline.length > 0 && (
              <Seccion titulo={`${t('inspEdited')} · ${inline.length}`}>
                <div className="vis-insp__props">
                  {inline.map(([k, v]) => (
                    <div key={k} className="vis-insp__prop is-editada">
                      <span className="vis-insp__prop-k">{k}</span>
                      <Valor valor={v} etiqueta={k} onCommit={(nv) => estilo(k, nv)} />
                      <button className="vis-insp__quitar" aria-label={`${t('inspUndo')} ${k}`} onClick={() => estilo(k, '')}><IconX size={11} /></button>
                    </div>
                  ))}
                </div>
              </Seccion>
            )}

            <Seccion titulo={t('inspComputed')}>
              <div className="vis-insp__props">
                {calculado.length === 0 && <p className="vis-insp__vacio">{t('inspNoCss')}</p>}
                {calculado.map(([k, v]) => (
                  <div key={k} className="vis-insp__prop">
                    <span className="vis-insp__prop-k" title={k}>{k}</span>
                    <Valor valor={v} etiqueta={k} onCommit={(nv) => estilo(k, nv)} />
                  </div>
                ))}
                <div className="vis-insp__prop vis-insp__prop--nueva">
                  <input value={nuevaProp.k} placeholder={t('inspPropName')} aria-label={t('inspPropName')} spellCheck={false}
                    onChange={(e) => setNuevaProp({ ...nuevaProp, k: aKebab(e.target.value) })} />
                  <input value={nuevaProp.v} placeholder={t('inspPropValue')} aria-label={t('inspPropValue')} spellCheck={false}
                    onChange={(e) => setNuevaProp({ ...nuevaProp, v: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') anadirProp(); }} />
                </div>
                <button className="vis-insp__anadir" onClick={anadirProp} disabled={!nuevaProp.k.trim() || !nuevaProp.v.trim()}>{t('inspAddProp')}</button>
              </div>
            </Seccion>
          </>
        )}
      </div>

      <div className="vis-insp__pie">
        <button className="vis-insp__pedir" onClick={() => onPedir(seleccion)}>{t('requestModelChange')}</button>
        <p className="vis-insp__nota">{t('manualChangesNote')}</p>
      </div>
    </aside>
  );
}

// Tamaños de tablero en el lienzo (px de la página, antes del zoom).
const TABLEROS = {
  escritorio: { w: 1280, h: 800 },
  tablet: { w: 820, h: 1180 },
  movil: { w: 390, h: 844 },
};
const HUECO = 120;
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 2;

const tituloDe = (f) => {
  const m = /<title>([^<]{1,80})<\/title>/i.exec(f.code || '');
  return (m && m[1].trim()) || f.name.replace(/\.(html?|svg)$/, '');
};

/** Coloca en fila (y salta de fila al pasar de ~4400 px) las páginas sin
 *  posición, a la derecha y debajo de lo ya colocado. */
function colocar(paginas, layout) {
  const out = { ...layout };
  const puestas = paginas.filter((f) => out[f.name]?.x != null);
  let x = 0;
  let y = 0;
  let altoFila = 0;
  if (puestas.length) {
    y = Math.min(...puestas.map((f) => out[f.name].y));
    x = Math.max(...puestas.map((f) => out[f.name].x + TABLEROS[out[f.name].d || 'escritorio'].w)) + HUECO;
  }
  for (const f of paginas) {
    if (out[f.name]?.x != null) continue;
    const d = out[f.name]?.d || 'escritorio';
    const { w, h } = TABLEROS[d];
    if (x > 0 && x + w > 4400) { x = 0; y += altoFila + HUECO * 1.5; altoFila = 0; }
    out[f.name] = { ...out[f.name], x, y, d };
    x += w + HUECO;
    altoFila = Math.max(altoFila, h);
  }
  return out;
}

/** Lienzo libre al estilo de un tablero de diseño: cada página es un
 *  tablero con su título que se mueve por separado (arrastrando el tablero
 *  o su cabecera), cambia de tamaño (escritorio/tablet/móvil) y se renombra
 *  con doble clic en el título. El fondo se arrastra para desplazarse y
 *  Ctrl+rueda hace zoom. Posiciones, tamaños y títulos se guardan por diseño. */
export function Board({ paginas, documento, onAbrir, clave, activa }) {
  const t = useT('visuals');
  const ref = useRef(null);
  const almacen = `lixbon.visuals.board.${clave || 'tmp'}`;
  const [layout, setLayout] = useState(() => {
    try { return colocar(paginas, JSON.parse(localStorage.getItem(almacen) || '{}')); } catch { return colocar(paginas, {}); }
  });
  const [vista, setVista] = useState({ x: 40, y: 60, z: 0.25 });
  const [elegido, setElegido] = useState(activa || null);
  const [encima, setEncima] = useState([]);       // orden de apilado: el último, arriba
  const [renombrando, setRenombrando] = useState(null);
  const arrastre = useRef(null);
  const vistaRef = useRef(vista);
  vistaRef.current = vista;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const guardar = (next) => {
    setLayout(next);
    try { localStorage.setItem(almacen, JSON.stringify(next)); } catch { /* sin almacenamiento */ }
  };
  // Páginas nuevas (otra versión) entran colocadas sin mover las demás.
  useEffect(() => {
    setLayout((prev) => (paginas.every((f) => prev[f.name]?.x != null) ? prev : colocar(paginas, prev)));
  }, [paginas]);

  const caja = (f) => {
    const l = layout[f.name] || {};
    const { w, h } = TABLEROS[l.d || 'escritorio'];
    return { x: l.x || 0, y: l.y || 0, w, h };
  };

  const ajustar = () => {
    const el = ref.current;
    if (!el || !paginas.length) return;
    const cajas = paginas.map(caja);
    const x0 = Math.min(...cajas.map((c) => c.x));
    const y0 = Math.min(...cajas.map((c) => c.y));
    const x1 = Math.max(...cajas.map((c) => c.x + c.w));
    const y1 = Math.max(...cajas.map((c) => c.y + c.h));
    const z = Math.min(1, (el.clientWidth - 80) / (x1 - x0), (el.clientHeight - 140) / (y1 - y0));
    setVista({ z, x: (el.clientWidth - (x1 - x0) * z) / 2 - x0 * z, y: 70 + (el.clientHeight - 140 - (y1 - y0) * z) / 2 - y0 * z });
  };
  useEffect(ajustar, [paginas.length]);  // eslint-disable-line react-hooks/exhaustive-deps

  const ordenar = () => {
    const limpio = Object.fromEntries(Object.entries(layout).map(([k, v]) => [k, { d: v.d, titulo: v.titulo }]));
    guardar(colocar(paginas, limpio));
    reencuadrar.current = true;
  };
  // Tras «Ordenar», encuadrar con las posiciones ya aplicadas.
  const reencuadrar = useRef(false);
  useEffect(() => { if (reencuadrar.current) { reencuadrar.current = false; ajustar(); } });  // eslint-disable-line react-hooks/exhaustive-deps

  const zoomEn = (factor, px, py) => setVista((v) => {
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.z * factor));
    return { z, x: px - (px - v.x) * (z / v.z), y: py - (py - v.y) * (z / v.z) };
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        zoomEn(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
      } else {
        setVista((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const zoomCentro = (f) => { const el = ref.current; zoomEn(f, el.clientWidth / 2, el.clientHeight / 2); };

  // Un solo gestor de arrastre: fondo = desplazar; tablero o cabecera = moverlo.
  const empezar = (e, nombre) => {
    if (e.button !== 0 || e.target.closest('button, input')) return;
    e.stopPropagation();
    const l = nombre ? layout[nombre] : null;
    arrastre.current = { nombre, sx: e.clientX, sy: e.clientY, ox: nombre ? l.x : vista.x, oy: nombre ? l.y : vista.y, movido: false };
    if (nombre) { setElegido(nombre); setEncima((prev) => [...prev.filter((n) => n !== nombre), nombre]); }
    else setElegido(null);
  };
  const mover = (e) => {
    const a = arrastre.current;
    if (!a) return;
    const dx = e.clientX - a.sx;
    const dy = e.clientY - a.sy;
    if (!a.movido && Math.abs(dx) + Math.abs(dy) > 3) {
      // La captura empieza con el arrastre: así un clic o doble clic sigue
      // llegando al tablero o a su título.
      a.movido = true;
      ref.current.setPointerCapture(e.pointerId);
    }
    if (!a.movido) return;
    if (a.nombre) {
      const z = vistaRef.current.z;
      setLayout((prev) => ({ ...prev, [a.nombre]: { ...prev[a.nombre], x: Math.round(a.ox + dx / z), y: Math.round(a.oy + dy / z) } }));
    } else {
      setVista((v) => ({ ...v, x: a.ox + dx, y: a.oy + dy }));
    }
  };
  const soltar = () => {
    const a = arrastre.current;
    arrastre.current = null;
    if (a?.nombre && a.movido) guardar(layoutRef.current);
  };

  const cambiarTamano = (nombre, d) => guardar({ ...layout, [nombre]: { ...layout[nombre], d } });
  const renombrar = (nombre, titulo) => {
    setRenombrando(null);
    const limpio = (titulo || '').trim();
    guardar({ ...layout, [nombre]: { ...layout[nombre], titulo: limpio || undefined } });
  };

  const apilado = (n) => { const i = encima.indexOf(n); return i < 0 ? 1 : 2 + i; };

  return (
    <div className="vis-board" ref={ref} onPointerDown={(e) => empezar(e, null)} onPointerMove={mover} onPointerUp={soltar} onPointerCancel={soltar}>
      <div className="vis-board__capa" style={{ transform: `translate(${vista.x}px, ${vista.y}px) scale(${vista.z})` }}>
        {paginas.map((f) => {
          const c = caja(f);
          return (
            <div key={f.name} className={`vis-board__artboard ${elegido === f.name ? 'is-elegido' : ''}`}
              style={{ left: c.x, top: c.y, width: c.w, height: c.h, zIndex: apilado(f.name) }}
              onPointerDown={(e) => empezar(e, f.name)} onDoubleClick={() => onAbrir(f.name)}>
              <iframe title={f.name} sandbox="allow-scripts" srcDoc={documento(f)} tabIndex={-1} />
            </div>
          );
        })}
      </div>
      {/* Cabeceras fuera de la capa escalada: texto nítido y a tamaño fijo. */}
      {paginas.map((f) => {
        const c = caja(f);
        const l = layout[f.name] || {};
        const titulo = l.titulo || tituloDe(f);
        const d = l.d || 'escritorio';
        return (
          <div key={f.name} className={`vis-board__cab ${elegido === f.name ? 'is-elegido' : ''} ${c.w * vista.z < 200 ? 'is-estrecho' : ''}`}
            style={{ left: vista.x + c.x * vista.z, top: vista.y + c.y * vista.z, width: Math.max(60, c.w * vista.z), zIndex: 10 + apilado(f.name) }}
            onPointerDown={(e) => empezar(e, f.name)} onDoubleClick={(e) => { e.stopPropagation(); setRenombrando(f.name); }}>
            {renombrando === f.name ? (
              <input className="vis-board__titulo-input" autoFocus defaultValue={titulo} aria-label={t('boardRename')}
                onBlur={(e) => renombrar(f.name, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenombrando(null); }} />
            ) : (
              <span className="vis-board__titulo" title={`${titulo} · ${f.name} — ${t('boardRenameHint')}`}>
                <strong>{titulo}</strong><small>{f.name}</small>
              </span>
            )}
            <span className="vis-board__acciones">
              {Object.keys(TABLEROS).map((k) => (
                <button key={k} className={d === k ? 'is-on' : ''} onClick={() => cambiarTamano(f.name, k)} title={`${t(`width_${k}`)} · ${TABLEROS[k].w}px`} aria-label={t(`width_${k}`)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                    {k === 'escritorio' && <rect x="2.5" y="5" width="19" height="13" rx="2.5" />}
                    {k === 'tablet' && <rect x="5" y="3" width="14" height="18" rx="2.5" />}
                    {k === 'movil' && <rect x="7.5" y="3" width="9" height="18" rx="2.5" />}
                  </svg>
                </button>
              ))}
              <button onClick={() => onAbrir(f.name)} title={t('boardOpen')} aria-label={t('boardOpen')}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h6v6M20 4l-8 8M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></svg>
              </button>
            </span>
          </div>
        );
      })}
      <div className="vis-board__zoom" onPointerDown={(e) => e.stopPropagation()}>
        <button className="vis-tool" onClick={() => zoomCentro(1 / 1.25)} title={t('zoomOut')}>−</button>
        <span>{Math.round(vista.z * 100)}%</span>
        <button className="vis-tool" onClick={() => zoomCentro(1.25)} title={t('zoomIn')}>+</button>
        <button className="vis-tool" onClick={ajustar}>{t('fit')}</button>
        <button className="vis-tool" onClick={ordenar} title={t('boardArrangeHint')}>{t('boardArrange')}</button>
        <span className="vis-board__hint">{t('boardHint')}</span>
      </div>
    </div>
  );
}
