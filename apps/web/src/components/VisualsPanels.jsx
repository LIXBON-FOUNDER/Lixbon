// VisualsPanels.jsx — piezas de Visuals: selector de design system (con uno
// propio) e inspector del elemento seleccionado en el lienzo.
import { useEffect, useRef, useState } from 'react';
import { DESIGN_SYSTEMS, designSystemPersonalizado } from '../lib/visuals';
import { IconChevron, IconX } from './Icons';
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

/** Panel del elemento seleccionado: texto y estilos básicos, o pedírselo al modelo. */
export function Inspector({ seleccion, onAplicar, onPedir, onCerrar }) {
  const t = useT('visuals');
  const [texto, setTexto] = useState(seleccion?.text || '');
  const [estilo, setEstilo] = useState({});
  useEffect(() => { setTexto(seleccion?.text || ''); setEstilo({}); }, [seleccion]);
  if (!seleccion) return null;

  const cambiar = (k, v) => {
    const next = { ...estilo, [k]: v };
    setEstilo(next);
    onAplicar({ selector: seleccion.selector, style: { [k]: v } });
  };
  const aplicarTexto = () => { if (texto !== seleccion.text) onAplicar({ selector: seleccion.selector, text: texto }); };
  const aRgbHex = (rgb) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb || '');
    return m ? `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : '#000000';
  };
  const editable = seleccion.text !== '' && seleccion.text != null;

  return (
    <aside className="vis-inspector">
      <div className="vis-inspector__head">
        <span className="mono">&lt;{seleccion.tag}&gt;</span>
        <button className="icon-btn" onClick={onCerrar} aria-label={t('close')}><IconX size={14} /></button>
      </div>
      {editable && (
        <label className="vis-inspector__campo">{t('text')}
          <textarea rows={3} value={texto} onChange={(e) => setTexto(e.target.value)} onBlur={aplicarTexto} />
        </label>
      )}
      <div className="vis-inspector__grid">
        <label>{t('color')}<input type="color" value={estilo.color || aRgbHex(seleccion.styles?.color)} onChange={(e) => cambiar('color', e.target.value)} /></label>
        <label>{t('background')}<input type="color" value={estilo.backgroundColor || aRgbHex(seleccion.styles?.background)} onChange={(e) => cambiar('backgroundColor', e.target.value)} /></label>
        <label>{t('size')}<input type="text" defaultValue={seleccion.styles?.fontSize} onBlur={(e) => cambiar('fontSize', e.target.value)} /></label>
        <label>{t('weight')}<select defaultValue={seleccion.styles?.fontWeight} onChange={(e) => cambiar('fontWeight', e.target.value)}>
          {['300', '400', '500', '600', '700', '800'].map((w) => <option key={w} value={w}>{w}</option>)}
        </select></label>
        <label>{t('padding')}<input type="text" defaultValue={seleccion.styles?.padding} onBlur={(e) => cambiar('padding', e.target.value)} /></label>
        <label>{t('radius')}<input type="text" defaultValue={seleccion.styles?.borderRadius} onBlur={(e) => cambiar('borderRadius', e.target.value)} /></label>
      </div>
      <button className="vis-tool" onClick={() => onPedir(seleccion)}>{t('requestModelChange')}</button>
      <p className="vis-inspector__nota">{t('manualChangesNote')}</p>
    </aside>
  );
}

/** Lienzo libre: las páginas como artboards, con zoom y desplazamiento. */
export function Board({ paginas, documento, onAbrir }) {
  const t = useT('visuals');
  const ref = useRef(null);
  const [vista, setVista] = useState({ x: 40, y: 40, z: 0.3 });
  const arrastre = useRef(null);
  const ANCHO = 1280;
  const ALTO = 800;
  const HUECO = 120;

  const ajustar = () => {
    const el = ref.current;
    if (!el) return;
    const total = paginas.length * ANCHO + (paginas.length - 1) * HUECO;
    const z = Math.min(1, (el.clientWidth - 80) / total, (el.clientHeight - 120) / ALTO);
    setVista({ x: (el.clientWidth - total * z) / 2, y: 60, z });
  };
  useEffect(ajustar, [paginas.length]);  // eslint-disable-line react-hooks/exhaustive-deps

  const onWheel = (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.0015);
      const rect = ref.current.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setVista((v) => {
        const z = Math.min(2, Math.max(0.08, v.z * factor));
        return { z, x: px - (px - v.x) * (z / v.z), y: py - (py - v.y) * (z / v.z) };
      });
    } else {
      setVista((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    }
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    arrastre.current = { sx: e.clientX, sy: e.clientY, x: vista.x, y: vista.y, movido: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    const a = arrastre.current;
    if (!a) return;
    const dx = e.clientX - a.sx;
    const dy = e.clientY - a.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) a.movido = true;
    setVista((v) => ({ ...v, x: a.x + dx, y: a.y + dy }));
  };
  const onPointerUp = () => { arrastre.current = null; };
  const zoom = (f) => setVista((v) => ({ ...v, z: Math.min(2, Math.max(0.08, v.z * f)) }));

  return (
    <div className="vis-board" ref={ref} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <div className="vis-board__capa" style={{ transform: `translate(${vista.x}px, ${vista.y}px) scale(${vista.z})` }}>
        {paginas.map((f, i) => (
          <div key={f.name} className="vis-board__artboard" style={{ left: i * (ANCHO + HUECO), width: ANCHO, height: ALTO }}
            onDoubleClick={() => onAbrir(f.name)}>
            <span className="vis-board__name" style={{ fontSize: Math.min(48, 14 / vista.z) }}>{f.name}</span>
            <iframe title={f.name} sandbox="allow-scripts" srcDoc={documento(f)} tabIndex={-1} />
          </div>
        ))}
      </div>
      <div className="vis-board__zoom">
        <button className="vis-tool" onClick={() => zoom(1 / 1.25)} title={t('zoomOut')}>−</button>
        <span>{Math.round(vista.z * 100)}%</span>
        <button className="vis-tool" onClick={() => zoom(1.25)} title={t('zoomIn')}>+</button>
        <button className="vis-tool" onClick={ajustar}>{t('fit')}</button>
        <span className="vis-board__hint">{t('boardHint')}</span>
      </div>
    </div>
  );
}
