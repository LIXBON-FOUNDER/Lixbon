(() => {
  const refOf = new WeakMap();
  const byRef = new Map();
  let next = 1;
  const MAX_NODES = 2000;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'OBJECT', 'EMBED']);
  const CHROME = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM']);
  const BLOCK = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'SECTION', 'ARTICLE', 'MAIN', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'TR', 'TABLE', 'BLOCKQUOTE', 'PRE', 'DT', 'DD', 'FIGCAPTION', 'TD', 'TH']);
  const ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem']);
  // Un elemento cuyo interior es solo texto con formato se lee de una vez; si
  // tiene cualquier otra cosa (un span o div puede ser un botón por CSS) se
  // recorre.
  const NOT_LEAF = ':not(b,i,em,strong,code,small,br,sub,sup,mark,abbr,time,s,u,q,cite,kbd,var,wbr,font)';
  const TEXTY = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local',
    'month', 'week', 'time', '']);

  const clean = (s, n) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return n && s.length > n ? s.slice(0, n - 1) + '…' : s;
  };

  const refFor = (el) => {
    let r = refOf.get(el);
    if (!r) {
      r = 'e' + next++;
      refOf.set(el, r);
      byRef.set(r, new WeakRef(el));
    }
    return r;
  };

  const get = (ref) => {
    const w = byRef.get(ref);
    const el = w && w.deref();
    return el && el.isConnected ? el : null;
  };

  const visible = (el) => {
    if (el.checkVisibility) return el.checkVisibility({ checkVisibilityCSS: true });
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden';
  };

  const role = (el) => {
    const explicit = (el.getAttribute('role') || '').split(' ')[0];
    if (ROLES.has(explicit)) return explicit;
    const tag = el.tagName;
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'INPUT') {
      const t = (el.type || '').toLowerCase();
      if (t === 'hidden') return null;
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'range') return 'slider';
      if (t === 'file') return 'file';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox';
    if (el.hasAttribute('onclick')) return 'button';
    const st = getComputedStyle(el);
    if (st.cursor === 'pointer') {
      const parent = el.parentElement;
      if (!parent || getComputedStyle(parent).cursor !== 'pointer') return 'clickable';
    }
    return null;
  };

  const textOf = (el) => clean(el.innerText || el.textContent, 80);

  const nameOf = (el) => {
    const doc = el.ownerDocument;
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => doc.getElementById(id)).filter(Boolean).map(textOf).join(' ');
      if (t) return clean(t, 80);
    }
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return clean(aria, 80);
    if (el.labels && el.labels.length) {
      const t = Array.from(el.labels).map(textOf).join(' ');
      if (t) return clean(t, 80);
    }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      const t = (el.type || '').toLowerCase();
      if ((t === 'submit' || t === 'button' || t === 'reset') && el.value) return clean(el.value, 80);
      if (el.placeholder) return clean(el.placeholder, 80);
      if (el.title) return clean(el.title, 80);
      if (t === 'image' && el.alt) return clean(el.alt, 80);
      return el.name ? clean(el.name, 40) : '';
    }
    const text = textOf(el);
    if (text) return text;
    const img = el.querySelector && el.querySelector('img[alt]');
    if (img && img.alt.trim()) return clean(img.alt, 80);
    if (el.title) return clean(el.title, 80);
    if (tag === 'A') {
      const href = el.getAttribute('href') || '';
      return clean(href, 60);
    }
    return '';
  };

  const sensitiveField = (el) => {
    if (el.tagName !== 'INPUT') return false;
    const t = (el.type || '').toLowerCase();
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    return t === 'password' || /cc-|one-time-code|current-password|new-password/.test(ac);
  };

  const valueOf = (el, r) => {
    const tag = el.tagName;
    if (tag === 'SELECT') {
      const opts = Array.from(el.selectedOptions || []).map((o) => clean(o.label || o.text, 40));
      return opts.join(', ');
    }
    if (tag === 'INPUT') {
      const t = (el.type || '').toLowerCase();
      if (!TEXTY.has(t) && t !== 'range') return null;
      if (t === 'password') return el.value ? '••••' : '';
      return clean(el.value, 80);
    }
    if (tag === 'TEXTAREA') return clean(el.value, 80);
    if (r === 'textbox' && el.isContentEditable) return clean(el.innerText, 80);
    return null;
  };

  const statesOf = (el, doc) => {
    const st = [];
    const aria = (a) => el.getAttribute(a);
    if (el.checked === true || aria('aria-checked') === 'true') st.push('marcado');
    if (el.disabled === true || aria('aria-disabled') === 'true') st.push('desactivado');
    if (aria('aria-expanded') === 'true') st.push('desplegado');
    if (aria('aria-expanded') === 'false') st.push('plegado');
    if (aria('aria-selected') === 'true' || aria('aria-current') === 'page') st.push('seleccionado');
    if (el.required === true) st.push('obligatorio');
    if (el.readOnly === true) st.push('solo lectura');
    let active = doc.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    if (active === el) st.push('con foco');
    return st;
  };

  const where = (rect, frame, vw, vh) => {
    const top = rect.top + frame.y;
    const bottom = rect.bottom + frame.y;
    const left = rect.left + frame.x;
    const right = rect.right + frame.x;
    if (bottom <= 0) return -1;
    if (top >= vh) return 1;
    if (right <= 0 || left >= vw) return 1;
    return 0;
  };

  const isDialog = (el) => {
    const r = el.getAttribute('role');
    return (el.tagName === 'DIALOG' && el.open) || r === 'dialog' || r === 'alertdialog' || el.getAttribute('aria-modal') === 'true';
  };

  const modalName = (el) => {
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return nameOf(el);
    const h = el.querySelector('h1,h2,h3,h4,[role=heading]');
    return clean((h && h.innerText) || el.innerText, 60);
  };

  // Botones con los que se suele cerrar un aviso: van primero al ofrecerlos.
  const CLOSE = /^(x|×|✕|cerrar|close|aceptar|accept|ok|vale|entendido|got it|continuar|continue|no,? gracias|no thanks|ahora no|not now|más tarde|later|omitir|skip|dismiss|descartar|rechazar|reject|listo|done)\b/i;

  // controlsIn son los controles de una capa que tapa la página, los de
  // cerrar primero.
  function controlsIn(layer, n) {
    const found = [];
    const visit = (root) => {
      for (const c of root.children) {
        if (found.length >= 40) return;
        if (!visible(c) || c.getAttribute('aria-hidden') === 'true') continue;
        const r = role(c);
        const rect = c.getBoundingClientRect();
        if (r && r !== 'clickable' && rect.width > 0 && rect.height > 0) {
          found.push({ ref: refFor(c), role: r, name: nameOf(c) });
          continue;
        }
        if (c.shadowRoot) visit(c.shadowRoot);
        visit(c);
      }
    };
    visit(layer);
    const score = (c) => (CLOSE.test(c.name) || /close|cerrar|dismiss/i.test(c.name) ? 0 : 1);
    return found.map((c, i) => [score(c), i, c]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, n).map((x) => x[2]);
  }

  const dims = (st) => {
    const m = /rgba?\(([^)]+)\)/.exec(st.backgroundColor);
    const alpha = m ? +(m[1].split(',')[3] ?? 1) : 0;
    return (alpha > 0.05 && alpha < 0.95) || (st.backdropFilter && st.backdropFilter !== 'none');
  };

  // findModal: la ventana que bloquea la página, sea un diálogo modal
  // declarado o una capa fija que oscurece todo (muchas webs no ponen
  // role=dialog a sus avisos).
  function findModal() {
    for (const d of document.querySelectorAll('dialog[open], [aria-modal="true"]')) {
      if (visible(d) && (d.getAttribute('aria-modal') === 'true' || d.matches(':modal'))) return d;
    }
    const vw = innerWidth, vh = innerHeight;
    for (const el of document.elementsFromPoint(vw / 2, vh / 2)) {
      if (el === document.body || el === document.documentElement) break;
      const st = getComputedStyle(el);
      if (st.position !== 'fixed' && st.position !== 'absolute') continue;
      const r = el.getBoundingClientRect();
      if (r.width < vw * 0.9 || r.height < vh * 0.9 || !dims(st)) continue;
      // El fondo oscuro puede envolver la ventana o ir a su lado.
      if (controlsIn(el, 1).length) return el;
      const parent = el.parentElement;
      return parent && parent !== document.body && parent !== document.documentElement ? parent : null;
    }
    return null;
  }

  function snapshot(opts) {
    aura();
    const out = [];
    const vw = innerWidth;
    const vh = innerHeight;
    let truncated = false;
    const modal = findModal();

    const push = (n) => {
      if (out.length >= MAX_NODES) {
        truncated = true;
        return false;
      }
      out.push(n);
      return true;
    };

    // El texto suelto se acumula en orden y se corta en los bloques y en
    // cada elemento interactivo, para que «Lee [enlace] y sigue» salga en orden.
    const walk = (root, frame) => {
      let buf = '';
      let bufNode = null;
      const flush = () => {
        const text = clean(buf, 200);
        if (text.length >= 2) {
          let v = 0;
          try {
            const range = bufNode.ownerDocument.createRange();
            range.selectNodeContents(bufNode);
            v = where(range.getBoundingClientRect(), frame, vw, vh);
          } catch (e) { v = 0; }
          push({ t: 'x', name: text, v });
        }
        buf = '';
        bufNode = null;
      };
      const addText = (text, node) => {
        if (!text.trim()) {
          if (buf) buf += ' ';
          return;
        }
        if (!bufNode) bufNode = node;
        buf += text;
      };
      for (const node of root.childNodes) {
        if (truncated) return;
        if (node.nodeType === 3) {
          const parent = node.parentElement;
          if (!(parent && parent.tagName === 'LABEL' && parent.control)) addText(node.nodeValue, node);
          continue;
        }
        if (node.nodeType !== 1) continue;
        const el = node;
        if (SKIP.has(el.tagName)) continue;
        if (el.getAttribute('aria-hidden') === 'true') continue;
        if (!visible(el)) continue;
        const r = el.tagName === 'IFRAME' ? null : role(el);
        const heading = /^H[1-6]$/.test(el.tagName) || el.getAttribute('role') === 'heading';
        const block = !getComputedStyle(el).display.startsWith('inline');
        const dialog = isDialog(el) || el === modal;
        if (!r && !heading && el.tagName !== 'IFRAME' && !dialog && !el.shadowRoot && !el.querySelector(NOT_LEAF)) {
          if (block) flush();
          if (el.tagName !== 'SVG' && el.tagName !== 'svg') addText(el.innerText || '', el);
          if (block) flush();
          continue;
        }
        flush();
        const rect = el.getBoundingClientRect();
        if (el.tagName === 'IFRAME') {
          let doc = null;
          try { doc = el.contentDocument; } catch (e) { doc = null; }
          if (doc && doc.body) {
            const inner = { x: frame.x + rect.left + el.clientLeft, y: frame.y + rect.top + el.clientTop };
            walk(doc.body, inner);
          } else if (rect.width > 40 && rect.height > 40) {
            push({ t: 'f', name: clean(el.title || el.name || el.getAttribute('src') || '', 60), v: where(rect, frame, vw, vh) });
          }
          continue;
        }
        if (dialog) {
          push({ t: 'g', name: modalName(el) });
          if (el.shadowRoot) walk(el.shadowRoot, frame);
          walk(el, frame);
          push({ t: 'G' });
          continue;
        }
        if (r && rect.width > 0 && rect.height > 0) {
          const node = { t: 'e', ref: refFor(el), role: r, name: nameOf(el), v: where(rect, frame, vw, vh) };
          const val = valueOf(el, r);
          if (val !== null && val !== undefined) node.val = val;
          const st = statesOf(el, el.ownerDocument);
          if (st.length) node.st = st;
          if (sensitiveField(el)) node.sens = true;
          if (!push(node)) return;
          // Un div con cursor de mano puede envolver enlaces o botones reales.
          if (r !== 'clickable') continue;
        }
        if (heading) {
          const hm = /^H([1-6])$/.exec(el.tagName);
          const name = textOf(el);
          if (name) push({ t: 'h', lvl: hm ? +hm[1] : +(el.getAttribute('aria-level') || 2), name, v: where(rect, frame, vw, vh) });
          continue;
        }
        if (el.tagName === 'svg' || el.tagName === 'SVG' || el.tagName === 'IMG') continue;
        if (el.shadowRoot) walk(el.shadowRoot, frame);
        walk(el, frame);
      }
      flush();
    };

    if (document.body) walk(document.body, { x: 0, y: 0 });
    const se = document.scrollingElement || document.documentElement;
    const meta = { title: document.title, url: location.href, scrollY: Math.round(scrollY), scrollH: Math.round(se ? se.scrollHeight : 0), vw, vh };
    if (modal) meta.modal = { name: modalName(modal), close: controlsIn(modal, 3) };
    return {
      meta,
      nodes: out,
      truncated,
      next,
    };
  }

  const frameOffset = (el) => {
    let x = 0, y = 0;
    let w = el.ownerDocument.defaultView;
    while (w && w.frameElement) {
      const fr = w.frameElement.getBoundingClientRect();
      x += fr.left + w.frameElement.clientLeft;
      y += fr.top + w.frameElement.clientTop;
      w = w.parent;
    }
    return { x, y };
  };

  const deepHit = (doc, x, y) => {
    let h = doc.elementFromPoint(x, y);
    while (h && h.shadowRoot) {
      const inner = h.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === h) break;
      h = inner;
    }
    return h;
  };

  const describe = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const text = clean(el.innerText, 40);
    return el.tagName.toLowerCase() + id + cls + (text ? ' «' + text + '»' : '');
  };

  function point(ref) {
    const el = get(ref);
    if (!el) return { err: 'stale' };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { err: 'hidden' };
    const x = r.left + Math.min(r.width / 2, Math.max(1, r.width - 1));
    const y = r.top + Math.min(r.height / 2, Math.max(1, r.height - 1));
    const off = frameOffset(el);
    const hit = deepHit(el.ownerDocument, x, y);
    let ok = !hit || hit === el || el.contains(hit) || hit.contains(el);
    if (!ok) {
      const label = hit.closest && hit.closest('label');
      if (label && label.control === el) ok = true;
      const root = el.getRootNode();
      if (root && root.host && (root.host === hit || root.host.contains(hit))) ok = true;
    }
    const res = { x: x + off.x, y: y + off.y };
    const exp = el.getAttribute('aria-expanded');
    if (exp !== null) res.exp = exp;
    if (!ok) {
      // La capa que tapa es la rama más alta de lo que hay encima que no
      // contiene al objetivo: el modal o el banner entero, no un span suyo.
      let layer = hit;
      while (layer.parentElement && !layer.parentElement.contains(el)) layer = layer.parentElement;
      const whole = layer === layer.ownerDocument.documentElement || layer === layer.ownerDocument.body;
      res.cover = whole ? describe(hit) : modalName(layer) || describe(hit);
      if (!whole) res.close = controlsIn(layer, 3);
    }
    return res;
  }

  function focus(ref, clear) {
    const el = get(ref);
    if (!el) return { err: 'stale' };
    if (el.tagName === 'SELECT') return { kind: 'select' };
    el.focus();
    if (!clear) return { kind: 'text' };
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      try { el.select(); } catch (e) { /* inputs como number no admiten select() */ }
      return { kind: 'text', filled: !!el.value };
    }
    if (el.isContentEditable) {
      const sel = el.ownerDocument.getSelection();
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      return { kind: 'text', filled: !!el.innerText.trim() };
    }
    return { kind: 'other' };
  }

  function choose(ref, text) {
    const el = get(ref);
    if (!el) return { err: 'stale' };
    if (el.tagName !== 'SELECT') return { err: 'notselect' };
    const want = clean(text).toLowerCase();
    const opts = Array.from(el.options);
    const opt = opts.find((o) => clean(o.label || o.text).toLowerCase() === want || o.value.toLowerCase() === want) ||
      opts.find((o) => clean(o.label || o.text).toLowerCase().includes(want));
    if (!opt) return { err: 'nooption', options: opts.slice(0, 20).map((o) => clean(o.label || o.text, 40)) };
    // El setter nativo hace que React y similares vean el cambio.
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, opt.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { chosen: clean(opt.label || opt.text, 60) };
  }

  function scrollTo(ref) {
    const el = get(ref);
    if (!el) return { err: 'stale' };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    return {};
  }

  function readable(offset, limit) {
    const pick = (root, skipChrome) => {
      const parts = [];
      const rec = (n) => {
        for (const c of n.childNodes) {
          if (c.nodeType === 3) { parts.push(c.nodeValue); continue; }
          if (c.nodeType !== 1) continue;
          if (SKIP.has(c.tagName) || c.tagName === 'svg' || c.tagName === 'IFRAME') continue;
          if (skipChrome && CHROME.has(c.tagName)) continue;
          if (c.getAttribute('aria-hidden') === 'true' || !visible(c)) continue;
          if (c.tagName === 'BR') { parts.push('\n'); continue; }
          const block = BLOCK.has(c.tagName);
          if (block) parts.push('\n');
          if (c.shadowRoot) rec(c.shadowRoot);
          rec(c);
          if (block) parts.push('\n');
        }
      };
      rec(root);
      return parts.join('').split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    };
    const main = document.querySelector('main, [role=main], article');
    let text = main ? pick(main, false) : '';
    if (text.length < 200 && document.body) text = pick(document.body, true);
    return { total: text.length, text: text.slice(offset, offset + limit), title: document.title, url: location.href };
  }

  function settle(quietMs, capMs) {
    return new Promise((resolve) => {
      let timer = setTimeout(done, quietMs);
      const cap = setTimeout(done, capMs);
      const obs = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(done, quietMs);
      });
      obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      function done() {
        obs.disconnect();
        clearTimeout(timer);
        clearTimeout(cap);
        resolve(true);
      }
    });
  }

  const has = (text) => !!document.body && document.body.innerText.toLowerCase().includes(clean(text).toLowerCase());

  const seed = (n) => { if (n > next) next = n; return next; };

  const metrics = () => ({ dpr: devicePixelRatio, w: innerWidth, h: innerHeight });

  // El aura cuelga de <html> y no de <body>: snapshot y readable no la ven, y
  // con pointer-events:none no tapa nada ni cambia elementFromPoint.
  const AURA = 'lixbon-aura';
  const AURA_CSS = ':host{all:initial}' +
    '.wrap{transition:opacity .3s}.wrap.off{opacity:0}' +
    '.glow{position:fixed;inset:0;pointer-events:none;box-shadow:inset 0 0 0 4px #A3BE3C,inset 0 0 0 5px rgba(25,25,23,.18),inset 0 0 70px 16px rgba(163,190,60,.5);animation:p 2s ease-in-out infinite}' +
    '@keyframes p{50%{box-shadow:inset 0 0 0 4px rgba(163,190,60,.8),inset 0 0 0 5px rgba(25,25,23,.1),inset 0 0 40px 8px rgba(163,190,60,.28)}}' +
    '.bar{position:fixed;top:0;left:0;right:0;height:5px;background:linear-gradient(90deg,transparent,#8FA82C,#C6D66E,#8FA82C,transparent) no-repeat;' +
    'background-size:40% 100%;animation:s 1.6s linear infinite}' +
    '@keyframes s{from{background-position:-60% 0}to{background-position:160% 0}}' +
    '.tag{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);display:flex;gap:10px;align-items:center;' +
    'font:600 14px/1 system-ui,-apple-system,"Segoe UI",sans-serif;color:#F2F2EE;background:rgba(22,22,20,.96);' +
    'padding:11px 18px 11px 14px;border-radius:999px;border:1.5px solid #C6D66E;' +
    'box-shadow:0 0 0 4px rgba(198,214,110,.18),0 8px 28px rgba(0,0,0,.45);white-space:nowrap;animation:in .35s cubic-bezier(.3,.7,.3,1)}' +
    '@keyframes in{from{opacity:0;transform:translate(-50%,14px)}}' +
    '.tag b{color:#C6D66E;font-size:15px}.tag small{font-weight:500;font-size:12px;color:#A9A99F}' +
    '.live{width:9px;height:9px;border-radius:50%;background:#C6D66E;box-shadow:0 0 0 0 rgba(198,214,110,.7);animation:l 1.4s ease-out infinite}' +
    '@keyframes l{to{box-shadow:0 0 0 9px rgba(198,214,110,0)}}' +
    '.dot{position:fixed;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;pointer-events:none;' +
    'border:2px solid #C6D66E;background:rgba(198,214,110,.25);animation:r .7s ease-out forwards}' +
    '@keyframes r{from{transform:scale(.3);opacity:1}to{transform:scale(1.9);opacity:0}}' +
    '.cur{position:fixed;left:0;top:0;width:22px;height:22px;pointer-events:none;display:none;' +
    'filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));transition:transform .38s cubic-bezier(.3,.7,.3,1)}' +
    '.cur.on{display:block}';
  const CURSOR_SVG = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2l15 8.2-6.6 1.6L8.3 18z" ' +
    'fill="#C6D66E" stroke="#191917" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  function aura() {
    const root = document.documentElement;
    if (!root) return false;
    let host = root.querySelector(':scope > ' + AURA + ':not([data-off])');
    if (!host) {
      host = document.createElement(AURA);
      host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      const sh = host.attachShadow({ mode: 'open' });
      sh.innerHTML = '<style>' + AURA_CSS + '</style><div class="wrap"><div class="glow"></div><div class="bar"></div>' +
        '<div class="tag"><span class="live"></span><b>◆</b>Lixbon está usando este navegador<small>· el agente controla esta pestaña</small></div></div>' +
        '<div class="cur">' + CURSOR_SVG + '</div>';
      root.appendChild(host);
    }
    return host.shadowRoot;
  }

  function unaura() {
    const host = document.documentElement && document.documentElement.querySelector(':scope > ' + AURA + ':not([data-off])');
    if (!host) return true;
    // Se funde antes de quitarlo; marcado, aura() ya no lo reutiliza.
    host.setAttribute('data-off', '');
    host.shadowRoot.querySelector('.wrap').classList.add('off');
    host.shadowRoot.querySelector('.cur').classList.remove('on');
    setTimeout(() => host.remove(), 320);
    return true;
  }

  // cursor desliza el puntero del agente hasta (x, y). En un documento nuevo
  // aparece donde se quedó en el anterior (fx, fy) y se mueve desde ahí.
  function cursor(x, y, fx, fy) {
    const sh = aura();
    if (!sh) return false;
    const cur = sh.querySelector('.cur');
    if (!cur.classList.contains('on')) {
      cur.style.transition = 'none';
      cur.style.transform = 'translate(' + (fx ?? x) + 'px,' + (fy ?? y) + 'px)';
      cur.classList.add('on');
      void cur.offsetWidth;
      cur.style.transition = '';
    }
    cur.style.transform = 'translate(' + (x - 3) + 'px,' + (y - 2) + 'px)';
    return true;
  }

  function expanded(ref) {
    const el = get(ref);
    return el ? el.getAttribute('aria-expanded') : null;
  }

  function ripple(x, y) {
    const sh = aura();
    if (!sh) return false;
    const dot = document.createElement('div');
    dot.className = 'dot';
    dot.style.left = x + 'px';
    dot.style.top = y + 'px';
    sh.appendChild(dot);
    setTimeout(() => dot.remove(), 800);
    return true;
  }

  return { snapshot, point, focus, choose, scrollTo, readable, settle, has, seed, metrics, aura, unaura, ripple, cursor, expanded };
})()
