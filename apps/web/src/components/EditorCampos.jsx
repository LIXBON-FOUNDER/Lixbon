import { useEffect, useRef, useState } from 'react';
import { FUENTES_GOOGLE, cargarMuestras } from '../lib/googleFonts';
import { IconChevron, IconSearch } from './Icons';

const CERRADAS_KEY = 'lixbon.pieza.secciones';
const leerCerradas = () => {
  try { return JSON.parse(localStorage.getItem(CERRADAS_KEY) || '{}'); } catch { return {}; }
};

export function Sec({ id, title, abierta: inicial = true, extra, children }) {
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
        {extra && <span className="pe-sec__extra">{extra}</span>}
        <IconChevron size={12} open={abierta} />
      </button>
      {abierta && children}
    </section>
  );
}

export function Fila({ label, children }) {
  return (
    <div className="pe-f">
      <span className="pe-f__k">{label}</span>
      <div className="pe-f__v">{children}</div>
    </div>
  );
}

export function Range({ label, min, max, step, unit = '', get, set, commit }) {
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

export function Num({ label, title, value, step = 1, min, unit, onChange, onCommit }) {
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

const sinPx = (v) => {
  const s = String(v ?? '');
  const m = /^(-?[\d.]+)px$/.exec(s);
  return m ? String(+(+m[1]).toFixed(2)) : s;
};
const conUnidad = (v) => (/^-?\d+(\.\d+)?$/.test(v) ? `${v}px` : v);

export function Medida({ label, title, valor, onCambio, min, paso = 1, sinUnidad = false }) {
  const [txt, setTxt] = useState(sinPx(valor));
  const activo = useRef(false);
  useEffect(() => { if (!activo.current) setTxt(sinPx(valor)); }, [valor]);
  const fmt = (n, u) => `${+n.toFixed(3)}${u}`;
  const partes = (s) => {
    const m = /^(-?[\d.]+)([a-z%]*)$/i.exec(String(s).trim());
    return m ? [+m[1], m[2]] : [0, sinUnidad ? '' : 'px'];
  };
  const emitir = (s) => onCambio(sinUnidad ? s : conUnidad(s));
  const sumar = (d) => {
    const [n, u] = partes(txt);
    const x = min != null ? Math.max(min, n + d) : n + d;
    const s = fmt(x, u === 'px' ? '' : u);
    setTxt(s);
    emitir(s);
  };
  const arrastrar = (e) => {
    e.preventDefault();
    const nodo = e.currentTarget;
    const x0 = e.clientX;
    const [n0, u] = partes(txt);
    activo.current = true;
    nodo.setPointerCapture(e.pointerId);
    const mover = (ev) => {
      const x = n0 + Math.round(ev.clientX - x0) * paso * (ev.shiftKey ? 10 : 1);
      const s = fmt(min != null ? Math.max(min, x) : x, u === 'px' ? '' : u);
      setTxt(s);
      emitir(s);
    };
    nodo.addEventListener('pointermove', mover);
    nodo.addEventListener('pointerup', () => { nodo.removeEventListener('pointermove', mover); activo.current = false; }, { once: true });
  };
  const confirmar = () => {
    activo.current = false;
    const v = txt.trim();
    if (v && v !== sinPx(valor)) emitir(v);
  };
  return (
    <label className="pe-num" title={title || label}>
      <span className="pe-num__k" onPointerDown={arrastrar}>{label}</span>
      <input value={txt} aria-label={title || label} spellCheck={false}
        onFocus={() => { activo.current = true; }}
        onChange={(e) => setTxt(e.target.value)}
        onBlur={confirmar}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); sumar((e.key === 'ArrowUp' ? 1 : -1) * paso * (e.shiftKey ? 10 : 1)); }
        }} />
    </label>
  );
}

export function Seg({ opciones, valor, cambiar, multi = false }) {
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

export function Opciones({ valor, opciones, cambiar, label }) {
  const lista = opciones.some(([k]) => k === valor) ? opciones : [[valor, valor], ...opciones];
  return (
    <select className="vis-insp__valor pe-select" value={valor} aria-label={label} onChange={(e) => cambiar(e.target.value)}>
      {lista.map(([k, r]) => <option key={k} value={k}>{r}</option>)}
    </select>
  );
}

/** Buscador de tipografías: las del documento, `fijas` y una selección de
 *  Google Fonts; cualquier otro nombre se busca en Google al confirmarlo.
 *  `elegir(nombre)` resuelve a true si la fuente se pudo cargar. */
export function SelectorFuente({ actual, enUso = [], fijas = [], elegir, t }) {
  const [abierto, setAbierto] = useState(false);
  const [q, setQ] = useState('');
  const [cargando, setCargando] = useState(null);
  const [error, setError] = useState('');

  const grupos = [['piece', enUso], ['brand', fijas], ...Object.entries(FUENTES_GOOGLE)].filter(([, fs]) => fs.length);
  const filtro = q.trim().toLowerCase();
  const visibles = grupos
    .map(([k, fs]) => [k, fs.filter((f) => f.toLowerCase().includes(filtro))])
    .filter(([, fs]) => fs.length);
  const exacta = grupos.some(([, fs]) => fs.some((f) => f.toLowerCase() === filtro));

  const probar = async (nombre) => {
    setError('');
    setCargando(nombre);
    const titulo = nombre.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
    let ok = await elegir(nombre);
    if (!ok && titulo !== nombre) ok = await elegir(titulo);
    setCargando(null);
    if (!ok) { setError(t('editor.fontNotFound', { name: nombre })); return; }
    setAbierto(false);
    setQ('');
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
              onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) probar(visibles[0]?.[1][0] && !exacta && filtro ? q.trim() : (visibles[0]?.[1][0] || q.trim())); if (e.key === 'Escape') setAbierto(false); }} />
          </label>
          <div className="pe-fuente__lista">
            {filtro && !exacta && (
              <button className="pe-fuente__google" onClick={() => probar(q.trim())}>{t('editor.fontUseGoogle', { name: q.trim() })}</button>
            )}
            {visibles.map(([k, fs]) => (
              <div key={k} className="pe-fuente__grupo">
                <span className="pe-fuente__cat">{t(`editor.fontGroups.${k}`)}</span>
                {fs.map((f) => (
                  <button key={f} className={f === actual ? 'is-on' : ''} onClick={() => probar(f)} style={{ fontFamily: `"${f}", sans-serif` }}>
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
