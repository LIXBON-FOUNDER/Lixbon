// PiezaEditor.jsx — editor visual de una pieza HTML (imagen o vídeo de marketing),
// dentro del estudio: la pieza ocupa el lienzo y las propiedades van en la columna
// de la derecha. Las ediciones se aplican sobre el DOM del iframe y al guardar se
// serializa de vuelta a HTML.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../i18n/useT';
import { paraGuardar, paraWeb } from '../lib/visualsApi';
import { IconCheck, IconPencil, IconPlay, IconRedo, IconStop, IconUndo } from './Icons';

const PALETA = ['#B4C64E', '#8CA038', '#4B5327', '#171717', '#F6F7ED', '#DCD6BC', '#FFFFFF', '#C4553D'];
const TEMAS = ['lima', 'tinta', 'crema'];

const winOf = (el) => el.ownerDocument.defaultView;
const cssOf = (el) => winOf(el).getComputedStyle(el);

function seen(el) {
  for (let a = el; a && a.nodeType === 1; a = a.parentElement) {
    const s = cssOf(a);
    if (s.opacity === '0' || s.visibility === 'hidden' || s.display === 'none') return false;
  }
  return true;
}

function toHex(c) {
  const m = c.match(/[\d.]+/g);
  if (!m || (m.length > 3 && +m[3] === 0)) return null;
  return `#${m.slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join('')}`;
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
const hijos = (el) => [...el.children].filter((c) => !['SCRIPT', 'STYLE'].includes(c.tagName));

/** Escala para que una pieza de w×h quepa en `nodo`. Las muy altas (páginas
 *  enteras) se ajustan al ancho y se recorren con scroll. */
function useEncaje(nodoRef, w, h, onCambio) {
  const [escala, setEscala] = useState(0.4);
  useLayoutEffect(() => {
    const node = nodoRef.current;
    if (!node || !w || !h) return undefined;
    const fit = () => {
      const cs = getComputedStyle(node);
      const ancho = node.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const alto = node.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const porAncho = ancho / w;
      const s = Math.max(0.05, Math.min(1, h / w > 1.6 ? porAncho : Math.min(porAncho, alto / h)));
      setEscala(s);
      onCambio?.(s);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(node);
    return () => ro.disconnect();
  }, [nodoRef, w, h, onCambio]);
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

function Sec({ title, children }) {
  return (
    <section className="vis-insp__sec">
      <h3 className="vis-insp__eyebrow">{title}</h3>
      {children}
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
          <input type="number" step={step} value={+Number(v).toFixed(2)} aria-label={label}
            onChange={(e) => cambiar(+e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          {unit && <span>{unit}</span>}
        </label>
      </div>
    </Fila>
  );
}

function ColorField({ label, el, prop, commit, clearLabel }) {
  const [hex, setHex] = useState(() => toHex(cssOf(el)[prop]) || '');
  const apply = (c, guardar = true) => { el.style[prop] = c; setHex(c === 'transparent' ? '' : c); if (guardar) commit(); };
  return (
    <Fila label={label}>
      <div className="pe-color">
        <div className="vis-insp__color">
          <span className={`vis-insp__muestra ${hex ? '' : 'is-vacia'}`} style={hex ? { background: hex } : undefined}>
            <input type="color" value={hex || '#ffffff'} onChange={(e) => apply(e.target.value, false)} onBlur={commit} aria-label={label} />
          </span>
          <input className="vis-insp__hex" value={hex} placeholder="—" spellCheck={false}
            onChange={(e) => { setHex(e.target.value); if (/^#[0-9a-f]{3,8}$/i.test(e.target.value)) el.style[prop] = e.target.value; }}
            onBlur={commit} />
          {clearLabel && hex && <button className="vis-insp__quitar" onClick={() => apply('transparent')} title={clearLabel} aria-label={clearLabel}>×</button>}
        </div>
        <div className="pe-sw">
          {PALETA.map((c) => <button key={c} style={{ background: c }} title={c} aria-label={c} onClick={() => apply(c)} />)}
        </div>
      </div>
    </Fila>
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

function Inspector({ doc, el, pick, commit, t, touch }) {
  const isBody = el === doc.body;
  const cs = cssOf(el);
  const [html, setHtml] = useState(() => el.innerHTML.trim());
  const kids = hijos(el);
  const style = (prop, fn = (v) => v) => (v) => { el.style[prop] = fn(v); touch(); };
  const temaActual = TEMAS.find((x) => doc.body.classList.contains(`t-${x}`));
  const alineado = cs.textAlign === 'start' ? 'left' : cs.textAlign;

  return (
    <>
      {isBody && [...doc.body.classList].some((c) => c.startsWith('t-')) && (
        <Sec title={t('editor.theme')}>
          <div className="vis-insp__seg pe-seg">
            {TEMAS.map((x) => (
              <button key={x} className={temaActual === x ? 'is-on' : ''} onClick={() => {
                [...doc.body.classList].filter((c) => c.startsWith('t-')).forEach((c) => doc.body.classList.remove(c));
                doc.body.classList.add(`t-${x}`);
                commit();
                pick(doc.body);
              }}>{t(`editor.themes.${x}`)}</button>
            ))}
          </div>
        </Sec>
      )}

      {!isBody && (
        <Sec title={t('editor.text')}>
          <textarea className="vis-insp__texto" rows={3} value={html}
            onChange={(e) => { setHtml(e.target.value); el.innerHTML = e.target.value; touch(); }} onBlur={commit} />
          <p className="vis-insp__nota">{t('editor.markHint')}</p>
        </Sec>
      )}

      <Sec title={t('editor.typography')}>
        <Range label={t('editor.size')} min={8} max={260} step={1} unit="px" commit={commit}
          get={() => parseFloat(cs.fontSize)} set={style('fontSize', (v) => `${v}px`)} />
        <Fila label={t('editor.weight')}>
          <select className="vis-insp__valor pe-select" defaultValue={String(Math.round(+cs.fontWeight / 100) * 100)}
            onChange={(e) => { el.style.fontWeight = e.target.value; commit(); }}>
            {[300, 400, 500, 600, 700, 800].map((w) => <option key={w} value={w}>{t(`editor.weights.${w}`)}</option>)}
          </select>
        </Fila>
        <Fila label={t('editor.align')}>
          <AlinearSeg inicial={alineado} el={el} commit={commit} t={t} />
        </Fila>
        <Range label={t('editor.lineHeight')} min={0.8} max={2.4} step={0.02} commit={commit}
          get={() => { const l = parseFloat(cs.lineHeight); return Number.isNaN(l) ? 1.2 : +(l / parseFloat(cs.fontSize)).toFixed(2); }}
          set={style('lineHeight')} />
      </Sec>

      <Sec title={t('editor.colors')}>
        <ColorField label={t('editor.colorText')} el={el} prop="color" commit={commit} />
        <ColorField label={t('editor.colorBg')} el={el} prop="backgroundColor" commit={commit} clearLabel={t('editor.remove')} />
      </Sec>

      <Sec title={t('editor.space')}>
        <Range label={t('editor.padding')} min={0} max={200} step={2} unit="px" commit={commit}
          get={() => parseFloat(cs.paddingTop)} set={style('padding', (v) => `${v}px`)} />
        {!isBody && (
          <>
            <Range label={t('editor.marginTop')} min={-120} max={320} step={2} unit="px" commit={commit}
              get={() => parseFloat(cs.marginTop)} set={style('marginTop', (v) => `${v}px`)} />
            <Range label={t('editor.marginBottom')} min={-120} max={320} step={2} unit="px" commit={commit}
              get={() => parseFloat(cs.marginBottom)} set={style('marginBottom', (v) => `${v}px`)} />
            <Range label={t('editor.radius')} min={0} max={200} step={2} unit="px" commit={commit}
              get={() => parseFloat(cs.borderTopLeftRadius) || 0} set={style('borderRadius', (v) => `${v}px`)} />
            <Range label={t('editor.rotate')} min={-20} max={20} step={0.5} unit="°" commit={commit}
              get={() => { const m = (el.style.transform || '').match(/rotate\((-?[\d.]+)deg\)/); return m ? +m[1] : 0; }}
              set={style('transform', (v) => (v ? `rotate(${v}deg)` : ''))} />
            <Range label={t('editor.opacity')} min={0} max={1} step={0.05} commit={commit}
              get={() => +cs.opacity} set={style('opacity')} />
          </>
        )}
      </Sec>

      {!isBody && (
        <Sec title={t('editor.actions')}>
          <div className="pe-acciones">
            <button className="vis-tool" onClick={() => { const p = el.previousElementSibling; if (p) { p.before(el); commit(); } }}>↑ {t('editor.up')}</button>
            <button className="vis-tool" onClick={() => { const n = el.nextElementSibling; if (n) { n.after(el); commit(); } }}>↓ {t('editor.down')}</button>
            <button className="vis-tool" onClick={() => { const c = el.cloneNode(true); el.after(c); pick(c); commit(); }}>{t('editor.duplicate')}</button>
            <button className="vis-tool" onClick={() => pick(el.parentElement)}>{t('editor.container')}</button>
            <button className="vis-tool is-danger" onClick={() => { const p = el.parentElement; el.remove(); pick(p); commit(); }}>{t('editor.del')}</button>
          </div>
        </Sec>
      )}

      {kids.length > 0 && (
        <Sec title={isBody ? t('editor.sections') : t('editor.inside')}>
          <ListaHijos items={kids} pick={pick} t={t} />
        </Sec>
      )}
    </>
  );
}

function AlinearSeg({ inicial, el, commit, t }) {
  const [v, setV] = useState(inicial);
  return (
    <div className="vis-insp__seg pe-seg">
      {['left', 'center', 'right'].map((x) => (
        <button key={x} className={v === x ? 'is-on' : ''} onClick={() => { el.style.textAlign = x; setV(x); commit(); }}>{t(`editor.${x}`)}</button>
      ))}
    </div>
  );
}

export function PiezaEditor({ html, meta, baseHref, nombre, onSave, onClose, saving, message }) {
  const t = useT('visual');
  const [w, h] = medidas(meta);
  const isVideo = meta.kind === 'video';

  const frameRef = useRef(null);
  const pvRef = useRef(null);
  const docRef = useRef(null);
  const selRef = useRef(null);
  const scaleRef = useRef(1);
  const undoRef = useRef([]);
  const redoRef = useRef([]);
  const guardadoRef = useRef('');
  const timerRef = useRef(null);
  const curTRef = useRef(0);
  const playingRef = useRef(false);

  const [srcDoc, setSrcDoc] = useState(() => paraWeb(html, baseHref));
  const [boxes, setBoxes] = useState({ sel: null, hov: null });
  const [selKey, setSelKey] = useState(0);
  const [tab, setTab] = useState('d');
  const [code, setCode] = useState('');
  const [codeDirty, setCodeDirty] = useState(false);
  const [curT, setCurT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [scenes, setScenes] = useState([]);
  const [, setHist] = useState(0);

  const rectOf = useCallback((el) => {
    if (!el || !docRef.current || el === docRef.current.documentElement) return null;
    const r = el.getBoundingClientRect();
    const s = scaleRef.current;
    return { left: r.left * s, top: r.top * s, width: r.width * s, height: r.height * s };
  }, []);

  const refreshBoxes = useCallback(() => {
    if (docRef.current) setBoxes((b) => ({ ...b, sel: rectOf(selRef.current) }));
  }, [rectOf]);

  const onEscala = useCallback((s) => { scaleRef.current = s; refreshBoxes(); }, [refreshBoxes]);
  const scale = useEncaje(pvRef, w, h, onEscala);

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

  const commit = useCallback(() => {
    refreshBoxes();
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
    d.addEventListener('dblclick', (e) => {
      const el = hit(e);
      if (el === d.body) return;
      el.contentEditable = 'true';
      el.focus();
      el.onblur = () => { el.removeAttribute('contenteditable'); el.onblur = null; commit(); setSelKey((k) => k + 1); };
    });
    d.addEventListener('mousemove', (e) => {
      const el = hit(e);
      setBoxes((b) => ({ ...b, hov: el === selRef.current ? null : rectOf(el) }));
    });
    d.addEventListener('mouseleave', () => setBoxes((b) => ({ ...b, hov: null })));
    d.addEventListener('keydown', (e) => {
      if (e.target.isContentEditable) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); redo(); }
    });
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
  }, [commit, isVideo, pick, redo, refreshBoxes, rectOf, setTime, undo]);

  const sucio = codeDirty || (!!docRef.current && undoRef.current.length > 0
    && undoRef.current[undoRef.current.length - 1] !== guardadoRef.current);

  useEffect(() => {
    const onKey = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); redo(); }
      else if (e.key === 'Escape' && selRef.current) { selRef.current = null; setSelKey((k) => k + 1); setBoxes({ sel: null, hov: null }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

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
  const selBox = (b, cls) => b && (
    <div className={`pe-ov ${cls}`} style={{ left: b.left, top: b.top, width: b.width, height: b.height }} />
  );
  const cadena = [];
  if (sel && docRef.current) for (let e = sel; e; e = e === docRef.current.body ? null : e.parentElement) cadena.unshift(e);

  return (
    <>
      <div className="vis-lienzo">
        <div className="vis-stagebar">
          <div className="vis-pestanas">
            <span className="vis-pestana is-on"><IconPencil size={13} /> {nombre}</span>
            <span className="pe-medida">{w}×{h}{isVideo ? ` · ${meta.seconds}s` : ''} · {Math.round(scale * 100)}%</span>
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
          <div className="pe-wrap" style={{ width: w * scale, height: h * scale }}>
            <iframe
              ref={frameRef} title={nombre} sandbox="allow-same-origin" srcDoc={srcDoc} onLoad={onFrameLoad}
              style={{ width: w, height: h, transform: `scale(${scale})` }}
            />
            {selBox(boxes.hov, 'pe-ov--hov')}
            {selBox(boxes.sel, 'pe-ov--sel')}
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
              <Inspector key={selKey} doc={docRef.current} el={sel} pick={pick} commit={commit} t={t} touch={refreshBoxes} />
            ) : (
              <>
                <p className="vis-insp__nota">{t('editor.hint')}</p>
                {docRef.current && (
                  <Sec title={t('editor.sections')}>
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
