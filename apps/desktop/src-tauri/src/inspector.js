// Inyectado por el proxy del modo Diseño (preview_proxy.rs) en las páginas de
// la vista previa. Habla con el IDE solo por postMessage: resalta el elemento
// bajo el cursor, lo describe al hacer clic y envía el árbol de capas.
(() => {
  if (window.__lixbonInspector || window.parent === window) return;
  window.__lixbonInspector = true;
  const send = (msg) => window.parent.postMessage({ lx: 1, ...msg }, '*');
  let on = false;
  let hovered = null;
  let selected = null;

  const box = document.createElement('div');
  const label = document.createElement('div');
  const pick = document.createElement('div');
  const base = 'position:fixed;pointer-events:none;z-index:2147483647;border-radius:3px;display:none;';
  box.style.cssText = base + 'background:rgba(198,214,110,.18);outline:1px solid rgba(198,214,110,.9);transition:all .08s ease-out;';
  pick.style.cssText = base + 'outline:2px solid #C6D66E;';
  label.style.cssText = base + 'background:#1C1C1C;color:#F2F2EE;font:600 11px/1 system-ui,sans-serif;padding:5px 7px;border-radius:5px;white-space:nowrap;';

  function mount() {
    if (!document.body || box.isConnected) return;
    document.documentElement.append(box, pick, label);
  }

  function fiberOf(el) {
    const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$') || x.startsWith('__reactInternalInstance$'));
    return k ? el[k] : null;
  }

  function componentOf(el) {
    let f = fiberOf(el);
    while (f) {
      const t = f.type;
      if (typeof t === 'function' || (t && typeof t === 'object' && (t.render || t.type))) {
        const name = t.displayName || t.name || t.render?.displayName || t.render?.name || t.type?.name;
        if (name && !/^(Fragment|Suspense|Provider|Consumer)$/.test(name)) {
          const src = f._debugSource || null;
          return { name, source: src ? { file: src.fileName, line: src.lineNumber } : null };
        }
      }
      f = f.return;
    }
    const vue = el.__vueParentComponent;
    if (vue?.type) return { name: vue.type.name || vue.type.__name || 'Componente', source: vue.type.__file ? { file: vue.type.__file, line: 1 } : null };
    return null;
  }

  const nameOf = (el) => componentOf(el)?.name || el.tagName.toLowerCase() + (el.id ? `#${el.id}` : el.classList[0] ? `.${el.classList[0]}` : '');

  function place(node, el) {
    const r = el.getBoundingClientRect();
    Object.assign(node.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    return r;
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const comp = componentOf(el);
    return {
      path: pathOf(el),
      name: nameOf(el),
      tag: el.tagName.toLowerCase(),
      classes: [...el.classList].slice(0, 12),
      text: (el.innerText || '').trim().slice(0, 80),
      component: comp?.name || null,
      source: comp?.source || null,
      rect: { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) },
      style: {
        display: cs.display, padding: cs.padding, margin: cs.margin, gap: cs.gap,
        background: cs.backgroundImage !== 'none' ? cs.backgroundImage : cs.backgroundColor,
        color: cs.color, fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontFamily: cs.fontFamily.split(',')[0],
        radius: cs.borderRadius, flexDirection: cs.flexDirection,
      },
    };
  }

  function pathOf(el) {
    const path = [];
    while (el && el !== document.body && el.parentElement) {
      path.unshift([...el.parentElement.children].indexOf(el));
      el = el.parentElement;
    }
    return path;
  }

  function byPath(path) {
    let el = document.body;
    for (const i of path) { el = el?.children[i]; if (!el) return null; }
    return el;
  }

  let budget = 0;
  function tree(el, depth) {
    if (budget-- <= 0) return null;
    const kids = [];
    if (depth < 12) {
      for (const c of el.children) {
        if (c === box || c === pick || c === label || /^(SCRIPT|STYLE|LINK|META|NOSCRIPT|TEMPLATE)$/.test(c.tagName)) continue;
        const r = c.getBoundingClientRect();
        if (!r.width && !r.height && !c.children.length) continue;
        const t = tree(c, depth + 1);
        if (t) kids.push(t);
      }
    }
    return { name: el === document.body ? 'body' : nameOf(el), component: !!componentOf(el), path: el === document.body ? [] : pathOf(el), children: kids };
  }

  function sendTree() {
    budget = 600;
    if (document.body) send({ type: 'tree', tree: tree(document.body, 0), url: location.href });
  }

  function setOn(v) {
    on = v;
    mount();
    document.documentElement.style.cursor = v ? 'crosshair' : '';
    if (!v) { box.style.display = 'none'; label.style.display = 'none'; }
  }

  document.addEventListener('mouseover', (e) => {
    if (!on || e.target === hovered) return;
    hovered = e.target;
    const r = place(box, hovered);
    label.textContent = `${nameOf(hovered)} · ${Math.round(r.width)} × ${Math.round(r.height)}`;
    Object.assign(label.style, { display: 'block', left: `${Math.max(2, r.left)}px`, top: `${r.top > 26 ? r.top - 24 : r.bottom + 4}px` });
  }, true);

  document.addEventListener('click', (e) => {
    if (!on) return;
    e.preventDefault();
    e.stopPropagation();
    selected = e.target;
    place(pick, selected);
    send({ type: 'selected', info: describe(selected) });
  }, true);

  const follow = () => { if (selected?.isConnected) place(pick, selected); else pick.style.display = 'none'; };
  window.addEventListener('scroll', follow, true);
  window.addEventListener('resize', follow);

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data?.lx) return;
    const m = e.data;
    if (m.type === 'inspect') setOn(!!m.on);
    if (m.type === 'tree') sendTree();
    if (m.type === 'select') {
      const el = byPath(m.path || []);
      if (!el) return;
      selected = el;
      mount();
      el.scrollIntoView({ block: 'nearest' });
      place(pick, el);
      send({ type: 'selected', info: describe(el) });
    }
    if (m.type === 'clear') { selected = null; pick.style.display = 'none'; }
  });

  let t = null;
  new MutationObserver(() => { clearTimeout(t); t = setTimeout(() => { sendTree(); follow(); }, 400); })
    .observe(document.documentElement, { childList: true, subtree: true });
  const ready = () => { send({ type: 'ready', url: location.href }); sendTree(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();
