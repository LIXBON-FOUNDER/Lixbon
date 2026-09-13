// VisualsPanels.jsx — piezas de Visuals: selector de design system (con uno
// propio) e inspector del elemento seleccionado en el lienzo.
import { useEffect, useRef, useState } from 'react';
import { DESIGN_SYSTEMS, designSystemPersonalizado } from '../lib/visuals';
import { IconChevron, IconX } from './Icons';
import { useDismiss } from '../hooks/useDismiss';

const FORM_VACIO = { nombre: '', primario: '#B4C64E', fondo: '#0E0E0E', texto: '#F2F2F0', fuenteTitulos: 'Inter', fuenteCuerpo: 'Inter', tono: '' };

export function DesignSystemPicker({ value, onChange, compacto = false }) {
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
        <span className="vis-ds__label">{compacto ? '' : 'Design system: '}{value?.label || 'Libre'}</span>
        <IconChevron size={13} open={abierto} />
      </button>
      {abierto && (
        <div className="vis-ds__menu">
          {!editando ? (
            <>
              {DESIGN_SYSTEMS.map((ds) => (
                <button key={ds.id} className={`vis-ds__item ${value?.id === ds.id ? 'is-active' : ''}`} onClick={() => elegir(ds)}>
                  <span className="vis-ds__swatch" style={{ background: swatchDe(ds) }} />
                  <span className="vis-ds__item-text"><strong>{ds.label}</strong><small>{ds.desc}</small></span>
                </button>
              ))}
              {value?.custom && (
                <button className="vis-ds__item is-active" onClick={() => setEditando(true)}>
                  <span className="vis-ds__swatch" style={{ background: value.form.primario }} />
                  <span className="vis-ds__item-text"><strong>{value.label}</strong><small>propio · editar</small></span>
                </button>
              )}
              <button className="vis-ds__item vis-ds__item--nuevo" onClick={() => setEditando(true)}>+ Definir el mío</button>
            </>
          ) : (
            <div className="vis-ds__form">
              <div className="vis-ds__form-head"><strong>Design system propio</strong><button className="icon-btn" onClick={() => setEditando(false)} aria-label="Cerrar"><IconX size={14} /></button></div>
              <label>Nombre<input value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} placeholder="Mi marca" /></label>
              <div className="vis-ds__colores">
                <label>Acento<input type="color" value={form.primario} onChange={(e) => setForm({ ...form, primario: e.target.value })} /></label>
                <label>Fondo<input type="color" value={form.fondo} onChange={(e) => setForm({ ...form, fondo: e.target.value })} /></label>
                <label>Texto<input type="color" value={form.texto} onChange={(e) => setForm({ ...form, texto: e.target.value })} /></label>
              </div>
              <label>Fuente títulos<input value={form.fuenteTitulos} onChange={(e) => setForm({ ...form, fuenteTitulos: e.target.value })} placeholder="Inter, Fraunces, Space Grotesk…" /></label>
              <label>Fuente cuerpo<input value={form.fuenteCuerpo} onChange={(e) => setForm({ ...form, fuenteCuerpo: e.target.value })} placeholder="Inter" /></label>
              <label>Tono<input value={form.tono} onChange={(e) => setForm({ ...form, tono: e.target.value })} placeholder="sobrio, juguetón, lujo, técnico…" /></label>
              <button className="vis-tool vis-tool--primary" onClick={guardarPropio}>Usar este</button>
            </div>
          )}
        </div>
      )}
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
        <button className="icon-btn" onClick={onCerrar} aria-label="Cerrar"><IconX size={14} /></button>
      </div>
      {editable && (
        <label className="vis-inspector__campo">Texto
          <textarea rows={3} value={texto} onChange={(e) => setTexto(e.target.value)} onBlur={aplicarTexto} />
        </label>
      )}
      <div className="vis-inspector__grid">
        <label>Color<input type="color" value={estilo.color || aRgbHex(seleccion.styles?.color)} onChange={(e) => cambiar('color', e.target.value)} /></label>
        <label>Fondo<input type="color" value={estilo.backgroundColor || aRgbHex(seleccion.styles?.background)} onChange={(e) => cambiar('backgroundColor', e.target.value)} /></label>
        <label>Tamaño<input type="text" defaultValue={seleccion.styles?.fontSize} onBlur={(e) => cambiar('fontSize', e.target.value)} /></label>
        <label>Peso<select defaultValue={seleccion.styles?.fontWeight} onChange={(e) => cambiar('fontWeight', e.target.value)}>
          {['300', '400', '500', '600', '700', '800'].map((w) => <option key={w} value={w}>{w}</option>)}
        </select></label>
        <label>Padding<input type="text" defaultValue={seleccion.styles?.padding} onBlur={(e) => cambiar('padding', e.target.value)} /></label>
        <label>Radio<input type="text" defaultValue={seleccion.styles?.borderRadius} onBlur={(e) => cambiar('borderRadius', e.target.value)} /></label>
      </div>
      <button className="vis-tool" onClick={() => onPedir(seleccion)}>Pedir un cambio al modelo sobre este elemento</button>
      <p className="vis-inspector__nota">Los cambios manuales se guardan con la versión y se aplican al descargar.</p>
    </aside>
  );
}
