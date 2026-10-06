// PiezaEditor.jsx — editor visual de una pieza HTML (imagen o vídeo de marketing).
// Se hace clic en un elemento y un panel permite cambiar texto, tipografía, colores
// y espacios; deshacer/rehacer; en vídeo, línea de tiempo con escenas. Las ediciones
// se aplican sobre el DOM del iframe y al guardar se serializa de vuelta a HTML.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../i18n/useT';
import { paraGuardar, paraWeb } from '../lib/visualsApi';

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
  if (el === el.ownerDocument.body) return t('editor.page');
  const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 26);
  const cls = el.classList && el.classList[0];
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${txt ? ` · ${txt}` : ''}`;
}

const pathOf = (body, el) => {
  const p = [];
  for (let e = el; e && e !== body; e = e.parentNode) p.unshift([...e.parentNode.children].indexOf(e));
  return p;
};
const fromPath = (body, p) => p.reduce((el, i) => el && el.children[i], body);

function Group({ title, children, list }) {
  return (
    <div className={`ae__g${list ? ' ae__g--list' : ''}`}>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, children, out }) {
  return (
    <div className="ae__f">
      <label>{label}</label>
      {children}
      {out != null && <output>{out}</output>}
    </div>
  );
}

function Range({ label, min, max, step, unit = '', get, set, commit }) {
  const [v, setV] = useState(() => get());
  return (
    <Field label={label} out={`${+Number(v).toFixed(2)}${unit}`}>
      <input
        type="range" min={min} max={max} step={step} value={v}
        onChange={(e) => { setV(+e.target.value); set(+e.target.value); }}
        onPointerUp={commit} onKeyUp={commit}
      />
    </Field>
  );
}

function ColorField({ label, el, prop, commit, clearLabel }) {
  const [hex, setHex] = useState(() => toHex(cssOf(el)[prop]) || '#ffffff');
  const apply = (c) => { el.style[prop] = c; setHex(c); commit(); };
  return (
    <>
      <Field label={label}>
        <input type="color" value={hex} onChange={(e) => { el.style[prop] = e.target.value; setHex(e.target.value); }} onBlur={commit} />
      </Field>
      <div className="ae__sw">
        {PALETA.map((c) => <i key={c} style={{ background: c }} title={c} onClick={() => apply(c)} />)}
        {clearLabel && <button className="ae__chip" onClick={() => { el.style[prop] = 'transparent'; commit(); }}>{clearLabel}</button>}
      </div>
    </>
  );
}

function Inspector({ doc, el, pick, commit, t, touch }) {
  const isBody = el === doc.body;
  const cs = cssOf(el);
  const [html, setHtml] = useState(() => el.innerHTML.trim());
  const chain = [];
  for (let e = el; e; e = e === doc.body ? null : e.parentElement) chain.unshift(e);
  const kids = [...el.children].filter((c) => !['SCRIPT', 'STYLE'].includes(c.tagName));
  const style = (prop, fn = (v) => v) => (v) => { el.style[prop] = fn(v); touch(); };
  const temaActual = TEMAS.find((x) => doc.body.classList.contains(`t-${x}`));

  return (
    <>
      <div className="ae__crumb">
        {chain.map((e, i) => (
          <span key={i}>
            <a onClick={() => pick(e)}>{e === doc.body ? t('editor.page') : e.tagName.toLowerCase()}</a>
            {i < chain.length - 1 && ' › '}
          </span>
        ))}
      </div>

      {isBody && [...doc.body.classList].some((c) => c.startsWith('t-')) && (
        <Group title={t('editor.theme')}>
          <div className="ae__row">
            {TEMAS.map((x) => (
              <button
                key={x} className={`ae__btn${temaActual === x ? ' is-on' : ''}`}
                onClick={() => {
                  [...doc.body.classList].filter((c) => c.startsWith('t-')).forEach((c) => doc.body.classList.remove(c));
                  doc.body.classList.add(`t-${x}`);
                  commit();
                  pick(doc.body);
                }}
              >{t(`editor.themes.${x}`)}</button>
            ))}
          </div>
        </Group>
      )}

      {!isBody && (
        <Group title={t('editor.text')}>
          <Field label={t('editor.content')}>
            <textarea
              value={html}
              onChange={(e) => { setHtml(e.target.value); el.innerHTML = e.target.value; touch(); }}
              onBlur={commit}
            />
          </Field>
          <p className="ae__hint">{t('editor.markHint')}</p>
        </Group>
      )}

      <Group title={t('editor.typography')}>
        <Range label={t('editor.size')} min={10} max={260} step={1} unit="px" commit={commit}
          get={() => parseFloat(cs.fontSize)} set={style('fontSize', (v) => `${v}px`)} />
        <Field label={t('editor.weight')}>
          <select defaultValue={String(Math.round(+cs.fontWeight / 100) * 100)}
            onChange={(e) => { el.style.fontWeight = e.target.value; commit(); }}>
            {[400, 500, 600, 700, 800].map((w) => <option key={w} value={w}>{t(`editor.weights.${w}`)}</option>)}
          </select>
        </Field>
        <Field label={t('editor.align')}>
          <div className="ae__row">
            {[['left', 'left'], ['center', 'center'], ['right', 'right']].map(([v, k]) => (
              <button key={v} className="ae__btn" onClick={() => { el.style.textAlign = v; commit(); }}>{t(`editor.${k}`)}</button>
            ))}
          </div>
        </Field>
        <Range label={t('editor.lineHeight')} min={0.8} max={2.4} step={0.02} commit={commit}
          get={() => { const l = parseFloat(cs.lineHeight); return Number.isNaN(l) ? 1.2 : +(l / parseFloat(cs.fontSize)).toFixed(2); }}
          set={style('lineHeight')} />
      </Group>

      <Group title={t('editor.colors')}>
        <ColorField label={t('editor.colorText')} el={el} prop="color" commit={commit} />
        <ColorField label={t('editor.colorBg')} el={el} prop="backgroundColor" commit={commit} clearLabel={t('editor.remove')} />
      </Group>

      <Group title={t('editor.space')}>
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
      </Group>

      {!isBody && (
        <Group title={t('editor.actions')}>
          <div className="ae__row">
            <button className="ae__btn" onClick={() => { const p = el.previousElementSibling; if (p) { p.before(el); commit(); } }}>↑ {t('editor.up')}</button>
            <button className="ae__btn" onClick={() => { const n = el.nextElementSibling; if (n) { n.after(el); commit(); } }}>↓ {t('editor.down')}</button>
            <button className="ae__btn" onClick={() => { const c = el.cloneNode(true); el.after(c); pick(c); commit(); }}>⧉ {t('editor.duplicate')}</button>
            <button className="ae__btn" onClick={() => pick(el.parentElement)}>⬆ {t('editor.container')}</button>
            <button className="ae__btn ae__btn--danger" onClick={() => { const p = el.parentElement; el.remove(); pick(p); commit(); }}>{t('editor.del')}</button>
          </div>
        </Group>
      )}

      {kids.length > 0 && (
        <Group title={isBody ? t('editor.sections') : t('editor.inside')} list>
          {kids.map((k, i) => <button key={i} onClick={() => pick(k)}>{rotuloDe(k, t)}</button>)}
        </Group>
      )}
    </>
  );
}

export function PiezaEditor({ html, meta, baseHref, onSave, onClose, saving, message }) {
  const t = useT('visual');
  const [w, h] = meta.size.split('x').map(Number);
  const isVideo = meta.kind === 'video';

  const frameRef = useRef(null);
  const pvRef = useRef(null);
  const docRef = useRef(null);
  const selRef = useRef(null);
  const scaleRef = useRef(1);
  const undoRef = useRef([]);
  const redoRef = useRef([]);
  const timerRef = useRef(null);
  const curTRef = useRef(0);
  const playingRef = useRef(false);

  const [srcDoc, setSrcDoc] = useState(() => paraWeb(html, baseHref));
  const [scale, setScale] = useState(0.4);
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
    if (!el || el === docRef.current.documentElement) return null;
    const r = el.getBoundingClientRect();
    const s = scaleRef.current;
    return { left: r.left * s, top: r.top * s, width: r.width * s, height: r.height * s };
  }, []);

  const refreshBoxes = useCallback(() => {
    if (docRef.current) setBoxes((b) => ({ ...b, sel: rectOf(selRef.current) }));
  }, [rectOf]);

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
  }, [commit, isVideo, pick, redo, refreshBoxes, rectOf, setTime, undo]);

  useLayoutEffect(() => {
    const node = pvRef.current;
    const fit = () => {
      const s = Math.max(0.05, Math.min((node.clientWidth - 36) / w, (node.clientHeight - 36) / h));
      scaleRef.current = s;
      setScale(s);
      if (docRef.current) setBoxes((b) => ({ ...b, sel: rectOf(selRef.current) }));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(node);
    return () => ro.disconnect();
  }, [w, h, rectOf]);

  useEffect(() => {
    const onKey = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); redo(); }
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, onClose]);

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

  const showCode = () => { setCode(serialize()); setCodeDirty(false); setTab('c'); };
  const showDesign = () => {
    if (codeDirty) { setSrcDoc(paraWeb(code, baseHref)); setCodeDirty(false); }
    setTab('d');
  };
  const guardar = () => onSave(tab === 'c' && codeDirty ? code : serialize());

  const sel = selRef.current;
  const selBox = (b, cls) => b && (
    <div className={`ae__ov ${cls}`} style={{ left: b.left, top: b.top, width: b.width, height: b.height }} />
  );

  return (
    <div className="ae">
      <div className="ae__bar">
        <button className="ae__btn" onClick={onClose}>← {t('editor.close')}</button>
        <span className="ae__msg">{saving ? t('editor.saving') : message}</span>
        <button className="ae__btn" onClick={undo} disabled={undoRef.current.length < 2}>↶ {t('editor.undo')}</button>
        <button className="ae__btn" onClick={redo} disabled={!redoRef.current.length}>↷ {t('editor.redo')}</button>
        <button className="ae__btn ae__btn--primary" onClick={guardar} disabled={saving}>{t('editor.save')}</button>
      </div>
      <div className="ae__work">
        <div className="ae__canvas">
          <div className="ae__pv" ref={pvRef}>
            <div className="ae__wrap" style={{ width: w * scale, height: h * scale }}>
              <iframe
                ref={frameRef} title="pieza" sandbox="allow-same-origin" srcDoc={srcDoc} onLoad={onFrameLoad}
                style={{ width: w, height: h, transform: `scale(${scale})` }}
              />
              {selBox(boxes.hov, 'ae__ov--hov')}
              {selBox(boxes.sel, 'ae__ov--sel')}
            </div>
          </div>
          {isVideo && (
            <div className="ae__tl">
              <button className="ae__btn" onClick={play}>{playing ? `⏸ ${t('editor.pause')}` : `▶ ${t('editor.play')}`}</button>
              <input
                type="range" min="0" max={meta.seconds} step="0.05" value={curT}
                onChange={(e) => { playingRef.current = false; setPlaying(false); setTime(+e.target.value); }}
              />
              <output>{curT.toFixed(1)} s</output>
              {scenes.map((s, i) => (
                <button key={i} className="ae__btn" onClick={() => { playingRef.current = false; setPlaying(false); setTime(s.ini + s.dur * 0.85); }}>
                  {t('editor.scene', { n: i + 1 })}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="ae__panel">
          <div className="ae__tabs">
            <button className={tab === 'd' ? 'is-on' : ''} onClick={showDesign}>{t('editor.design')}</button>
            <button className={tab === 'c' ? 'is-on' : ''} onClick={showCode}>{t('editor.code')}</button>
          </div>
          {tab === 'd' ? (
            <div className="ae__insp">
              {docRef.current && sel ? (
                <Inspector
                  key={selKey} doc={docRef.current} el={sel} pick={pick} commit={commit} t={t}
                  touch={refreshBoxes}
                />
              ) : (
                <>
                  <p className="ae__hint">{t('editor.hint')}</p>
                  {docRef.current && (
                    <Group title={t('editor.sections')} list>
                      {[...docRef.current.body.children].filter((c) => !['SCRIPT', 'STYLE'].includes(c.tagName)).map((k, i) => (
                        <button key={i} onClick={() => pick(k)}>{rotuloDe(k, t)}</button>
                      ))}
                    </Group>
                  )}
                </>
              )}
            </div>
          ) : (
            <textarea
              className="ae__code" spellCheck={false} value={code}
              onChange={(e) => { setCode(e.target.value); setCodeDirty(true); }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
