import { useEffect, useRef } from 'react';

// Fondo del chat vacío: un colibrí en ASCII que liba de una heliconia colgante
// sobre una cordillera andina. Se dibuja en vectores a un búfer de baja
// resolución (una celda por carácter) y cada celda se pinta como un bloque de
// color con un glifo encima. Un toque fuera del cuadro deja néctar y el colibrí
// va a beberlo. Los colores salen de las variables de .colibri (chat.css), así
// que siguen al tema claro u oscuro.

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sstep = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

function hex(h) {
  h = (h || '#888').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, c: [], s: `#${h.slice(0, 6)}` };
}
function rgba(o, a) {
  const i = a <= 0 ? 0 : a >= 1 ? 40 : Math.round(a * 40);
  return o.c[i] || (o.c[i] = `rgba(${o.r},${o.g},${o.b},${i / 40})`);
}
const mixS = (a, b, t) => `rgb(${Math.round(a.r + (b.r - a.r) * t)},${Math.round(a.g + (b.g - a.g) * t)},${Math.round(a.b + (b.b - a.b) * t)})`;
const lum = (o) => (0.299 * o.r + 0.587 * o.g + 0.114 * o.b) / 255;

// El --bg del sitio puede llegar como rgb() o con alfa; lo pasamos a hex.
function colorDe(valor) {
  const v = (valor || '').trim();
  const m = v.match(/^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/);
  if (m) return hex(((1 << 24) + (+m[1] << 16) + (+m[2] << 8) + +m[3]).toString(16).slice(1));
  return hex(v);
}

function montar(main, centro, bgc, live) {
  const root = document.documentElement;
  const G = bgc.getContext('2d');
  const L = live.getContext('2d');
  const buf = document.createElement('canvas');
  const B = buf.getContext('2d', { willReadFrequently: true });
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const MONO = getComputedStyle(root).getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace';

  let W = 0, H = 0, DPR = 1, CELL = 8, COLS = 0, ROWS = 0, FS = 8, T = 0, narrow = false;
  let mask, hash, trail;
  let CR = { left: 0, top: 0, right: 0, bottom: 0 }, ZONE = { x0: 0, y0: 0, x1: 0, y1: 0 }, ridgeBase = 0;
  let C = null, bird = null, heli = null, drops = [], sparks = [], stars = [];
  let raf = 0, vivo = true;
  const pointer = { on: false, x: 0, y: 0, t: 0 };

  function readColors() {
    const cs = getComputedStyle(main);
    const v = (n) => hex(cs.getPropertyValue(n));
    C = {
      bg: colorDe(cs.getPropertyValue('--bg')), muted: v('--cb-muted'), amber: v('--cb-amber'),
      r1: v('--cb-ridge1'), r2: v('--cb-ridge2'), r3: v('--cb-ridge3'),
      hi: v('--cb-hi'), mid: v('--cb-mid'), lo: v('--cb-lo'), belly: v('--cb-belly'), gorget: v('--cb-gorget'), wing: v('--cb-wing'), beak: v('--cb-beak'),
      red: v('--cb-heli-red'), yel: v('--cb-heli-yel'), hg: v('--cb-heli-grn'), leaf: v('--cb-leaf'), leafHi: v('--cb-leaf-hi'), fg: v('--cb-fg'),
    };
    C.dark = lum(C.bg) < 0.4;
    C.inkL = C.dark ? hex('#f1ead8') : { ...C.bg, c: [] };
    C.inkD = C.dark ? hex('#0d0c0a') : C.fg;
    drawBg();
    if (reduce && bird) render(0);
  }

  /* ---------- layout ---------- */
  function resize() {
    const r = main.getBoundingClientRect();
    W = r.width; H = r.height; DPR = Math.min(window.devicePixelRatio || 1, 2);
    if (!W || !H) return;
    narrow = W < 861;
    CELL = W < 520 ? 6 : W < 861 ? 7 : 8; FS = CELL + 0.5;
    COLS = Math.ceil(W / CELL) + 1; ROWS = Math.ceil(H / CELL) + 1;
    for (const c of [bgc, live]) { c.width = Math.round(W * DPR); c.height = Math.round(H * DPR); c.style.width = `${W}px`; c.style.height = `${H}px`; }
    buf.width = COLS; buf.height = ROWS;
    const n = COLS * ROWS; trail = new Float32Array(n); hash = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; hash[i] = x - Math.floor(x); }
    computeMask();
    stars = [];
    for (let i = 0; i < 70; i++) stars.push({ x: rand(0, W), y: rand(0, ridgeBase * 0.85), ph: rand(0, TAU), big: Math.random() < 0.1 });
    if (heli) heli.layout();
    if (bird) bird.fit();
    drawBg();
    if (reduce && bird && C) render(0);
  }
  function computeMask() {
    if (!COLS) return;
    mask = new Float32Array(COLS * ROWS).fill(1);
    const mr = main.getBoundingClientRect(), r = centro.getBoundingClientRect();
    CR = { left: r.left - mr.left, top: r.top - mr.top, right: r.right - mr.left, bottom: r.bottom - mr.top };
    for (let cy = 0; cy < ROWS; cy++) for (let cx = 0; cx < COLS; cx++) {
      const px = cx * CELL + CELL / 2, py = cy * CELL + CELL / 2;
      const dx = Math.max(CR.left - 10 - px, 0, px - (CR.right + 10)), dy = Math.max(CR.top - 10 - py, 0, py - (CR.bottom + 10));
      mask[cy * COLS + cx] = 0.25 + 0.75 * sstep(Math.hypot(dx, dy) / 48);
    }
    const top = narrow ? 24 : 30;
    if (narrow) { ZONE = { x0: 24, y0: top, x1: W - 24, y1: Math.max(top + 120, CR.top - 24) }; ridgeBase = Math.max(top + 140, CR.top - 6); }
    else { ZONE = { x0: 30, y0: 40, x1: W - 30, y1: H * 0.86 }; ridgeBase = H; }
  }

  /* ---------- fondo: cordillera, sol o luna, estrellas ---------- */
  function drawBg() {
    if (!C || !W || !mask) return;
    G.setTransform(DPR, 0, 0, DPR, 0, 0); G.clearRect(0, 0, W, H);
    G.font = `500 ${FS}px ${MONO}`; G.textAlign = 'center'; G.textBaseline = 'middle';
    const rh = narrow ? Math.min(130, ridgeBase * 0.42) : H * 0.26;
    const sx = W * (narrow ? 0.28 : 0.3), sy = ridgeBase - rh * 0.62, sr = narrow ? 26 : 46;
    for (let cy = Math.floor((sy - sr - CELL) / CELL); cy <= Math.ceil((sy + sr) / CELL); cy++) for (let cx = Math.floor((sx - sr) / CELL); cx <= Math.ceil((sx + sr) / CELL); cx++) {
      if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) continue;
      const px = cx * CELL + CELL / 2, py = cy * CELL + CELL / 2, d = Math.hypot(px - sx, py - sy) / sr;
      if (d > 1) continue;
      const i = cy * COLS + cx, m = mask[i];
      if (C.dark) {
        const cut = Math.hypot(px - sx - sr * 0.42, py - sy + sr * 0.18) / sr;
        if (cut < 0.82) continue;
        G.fillStyle = rgba(C.inkL, (d > 0.85 ? 0.55 : 0.3) * m); G.fillText(d > 0.85 ? 'o' : '.', px, py);
      } else { G.fillStyle = rgba(C.amber, (d > 0.88 ? 0.5 : 0.16) * m); G.fillText(d > 0.88 ? 'o' : hash[i] < 0.5 ? ':' : '.', px, py); }
    }
    const layers = [
      { col: C.r1, h: rh, f: [0.0042, 0.011, 0.031], o: [0.4, 2.1, 1.3], a: 0.85, fill: 0.22, chars: '.' },
      { col: C.r2, h: rh * 0.7, f: [0.0061, 0.017, 0.043], o: [2.6, 0.4, 3.1], a: 0.9, fill: 0.35, chars: '.:' },
      { col: C.r3, h: rh * 0.42, f: [0.008, 0.023, 0.06], o: [1.1, 3.7, 0.6], a: 1, fill: 0.55, chars: ':%.' },
    ];
    const tops = layers.map((l) => (x) => ridgeBase - l.h * (0.55 + 0.3 * Math.sin(x * l.f[0] + l.o[0]) + 0.12 * Math.sin(x * l.f[1] + l.o[1]) + 0.04 * Math.sin(x * l.f[2] + l.o[2])));
    const rowB = Math.floor(ridgeBase / CELL);
    for (let cx = 0; cx < COLS; cx++) {
      const x = cx * CELL + CELL / 2;
      const rws = tops.map((f) => Math.floor(f(x) / CELL));
      for (let li = 0; li < 3; li++) {
        const l = layers[li], r0 = rws[li], r1 = li < 2 ? rws[li + 1] : rowB;
        const sl = Math.floor(tops[li](x + CELL) / CELL) - Math.floor(tops[li](x - CELL) / CELL);
        for (let cy = r0; cy < Math.min(r1, rowB); cy++) {
          if (cy < 0 || cy >= ROWS) continue;
          const i = cy * COLS + cx, m = mask[i], h = hash[i];
          if (cy === r0) { G.fillStyle = rgba(l.col, l.a * m); G.fillText(sl < 0 ? '/' : sl > 0 ? '\\' : '_', x, cy * CELL + CELL / 2); }
          else if (h < l.fill) { G.fillStyle = rgba(l.col, (0.55 + h) * l.a * m); G.fillText(l.chars[((h * 97) | 0) % l.chars.length], x, cy * CELL + CELL / 2); }
        }
      }
    }
  }

  /* ---------- heliconia colgante (Heliconia rostrata) ---------- */
  class Heliconia {
    constructor() { this.sway = 0; this.kick = 0; this.layout(); }
    layout() {
      this.ax = narrow ? W - Math.max(46, W * 0.14) : W - 150;
      this.ay = narrow ? 10 : -6;
      this.len = narrow ? Math.min(ZONE.y1 - 40, H * 0.4) : Math.min(H * 0.62, 560);
      this.s = narrow ? clamp(W / 430, 0.75, 1.05) : 1.15;
      this.n = narrow ? 5 : 6;
      this.pts = [];
    }
    update(dt) { this.kick *= Math.exp(-dt * 2); this.sway = Math.sin(T * 0.7) * 0.035 + Math.sin(T * 1.9) * 0.012 + this.kick * Math.sin(T * 9) * 0.05; }
    draw() {
      const s = this.s;
      B.save(); B.translate(this.ax, this.ay); B.rotate(this.sway);
      B.fillStyle = C.leaf.s; B.beginPath(); B.moveTo(0, 0); B.quadraticCurveTo(-150 * s, 40 * s, -210 * s, 150 * s); B.quadraticCurveTo(-120 * s, 90 * s, 0, 26 * s); B.fill();
      B.strokeStyle = C.leafHi.s; B.lineWidth = 2.4 * s; B.beginPath(); B.moveTo(-4 * s, 10 * s); B.quadraticCurveTo(-120 * s, 62 * s, -200 * s, 142 * s); B.stroke();
      const step = this.len / (this.n + 0.6); const nodes = [];
      for (let k = 0; k <= this.n; k++) { const side = k % 2 ? 1 : -1; nodes.push({ x: side * 9 * s, y: 30 * s + k * step }); }
      B.strokeStyle = C.hg.s; B.lineWidth = 5 * s; B.lineCap = 'round'; B.beginPath(); B.moveTo(0, 0);
      nodes.forEach((p) => B.lineTo(p.x, p.y)); B.stroke();
      this.pts = [];
      for (let k = 0; k < this.n; k++) {
        const p = nodes[k], side = k % 2 ? 1 : -1, z = (1 - k * 0.09) * s;
        B.save(); B.translate(p.x, p.y); B.scale(side * z, z);
        B.fillStyle = C.red.s; B.beginPath(); B.moveTo(0, 0); B.quadraticCurveTo(30, 30, 62, 6); B.quadraticCurveTo(44, -2, 30, -10); B.quadraticCurveTo(14, -8, 0, 0); B.fill();
        B.fillStyle = C.yel.s; B.beginPath(); B.moveTo(30, -10); B.quadraticCurveTo(46, -3, 62, 6); B.quadraticCurveTo(48, 0, 34, -4); B.closePath(); B.fill();
        B.strokeStyle = C.hg.s; B.lineWidth = 2; B.beginPath(); B.moveTo(2, 1); B.quadraticCurveTo(30, 30, 61, 7); B.stroke();
        B.fillStyle = C.yel.s; B.beginPath(); B.arc(44, -1, 3.5, 0, TAU); B.fill();
        B.restore();
        const lx = p.x + side * 44 * z, ly = p.y - 4 * z, cs = Math.cos(this.sway), sn = Math.sin(this.sway);
        this.pts.push({ x: this.ax + lx * cs - ly * sn, y: this.ay + lx * sn + ly * cs, side });
      }
      B.restore();
    }
  }

  /* ---------- el colibrí ---------- */
  class Colibri {
    constructor() {
      this.fit();
      this.x = (ZONE.x0 + ZONE.x1) * 0.4; this.y = (ZONE.y0 + ZONE.y1) * 0.45; this.vx = 0; this.vy = 0;
      this.face = 1; this.pitch = -0.5; this.phase = 0; this.t = 0; this.state = 'hover'; this.timer = 1.5; this.target = { x: this.x, y: this.y };
      this.flash = 0; this.fan = 0.4; this.feedIdx = 0; this.drop = null;
    }
    fit() { this.s = narrow ? clamp(Math.min(W * 0.0042, (ZONE.y1 - ZONE.y0) * 0.0085), 0.95, 1.9) : clamp(W * 0.0021, 1.8, 2.7); }
    offsetFor(lx, ly, p, face) { const c = Math.cos(p), s = Math.sin(p); return { x: face * this.s * (c * lx - s * ly), y: this.s * (s * lx + c * ly) }; }
    pickWander() {
      for (let k = 0; k < 16; k++) {
        const x = rand(ZONE.x0 + 95 * this.s, ZONE.x1 - 95 * this.s), y = rand(ZONE.y0 + 75 * this.s, ZONE.y1 - 35 * this.s);
        if (!narrow && x > CR.left - 90 * this.s && x < CR.right + 90 * this.s && y > CR.top - 70 * this.s && y < CR.bottom + 60 * this.s) continue;
        if (Math.abs(x - heli.ax) < 70 * this.s && y < heli.len) continue;
        return { x, y };
      }
      return { x: ZONE.x0 + 80, y: ZONE.y0 + 60 };
    }
    next() {
      const ok = heli.pts.map((n, i) => ({ n, i })).filter(({ n }) => {
        const side = n.side < 0 ? 1 : -1, off = this.offsetFor(88, -9, -0.28, side), bx = n.x - off.x;
        return bx > ZONE.x0 + 70 * this.s && bx < ZONE.x1 - 70 * this.s && n.y - off.y > ZONE.y0 + 40 * this.s;
      });
      if (Math.random() < 0.42 && ok.length) { this.state = 'feed'; this.feedIdx = ok[(Math.random() * ok.length) | 0].i; this.timer = rand(2.6, 4.2); }
      else { this.state = 'hover'; this.target = this.pickWander(); this.timer = rand(1.6, 3.2); }
    }
    update(dt) {
      this.t += dt; this.flash = Math.max(0, this.flash - dt * 0.9);
      let tx = this.target.x, ty = this.target.y, wantPitch = -0.36, lookX = null;
      const k1 = 16, k2 = 7.5;
      const drop = drops.find((d) => !d.dead);
      if (drop) { this.drop = drop; this.state = 'drink'; }
      else if (this.drop?.dead) this.drop = null;
      if (this.state === 'drink' && this.drop) {
        const d = this.drop, side = this.x < d.x ? 1 : -1, p = -0.32, off = this.offsetFor(88, -9, p, side);
        tx = d.x - off.x - side * 6 * this.s * Math.max(0, Math.sin(this.t * 7)); ty = d.y - off.y; wantPitch = p; lookX = d.x;
        if (Math.hypot(tx - this.x, ty - this.y) < 10) {
          d.t += dt;
          if (d.t > 1.3) {
            d.dead = true; this.drop = null; this.flash = 1;
            for (let i = 0; i < 7; i++) sparks.push({ x: d.x, y: d.y, vx: rand(-50, 50), vy: rand(-70, 10), t: 0, life: rand(0.5, 1) });
            this.state = 'hover'; this.target = this.pickWander(); this.timer = rand(1, 2);
          }
        }
      } else if (this.state === 'feed') {
        const n = heli.pts[this.feedIdx];
        if (!n) { this.next(); } else {
          const side = n.side < 0 ? 1 : -1, p = -0.28, off = this.offsetFor(88, -9, p, side);
          const dipv = Math.max(0, Math.sin(this.t * 5.5)) * 7 * this.s;
          tx = n.x - off.x - side * (4 * this.s - dipv * 0.6); ty = n.y - off.y; wantPitch = p; lookX = n.x;
          if (Math.hypot(tx - this.x, ty - this.y) < 12) heli.kick = Math.max(heli.kick, 0.25);
          this.timer -= dt; if (this.timer < 0) this.next();
        }
      } else {
        if (this.state === 'drink') this.state = 'hover';
        this.timer -= dt;
        if (pointer.on && performance.now() - pointer.t < 2500) {
          const px = clamp(pointer.x, ZONE.x0 + 60, ZONE.x1 - 60), py = clamp(pointer.y, ZONE.y0 + 40, ZONE.y1 - 30);
          const inZone = pointer.y > ZONE.y0 - 20 && pointer.y < ZONE.y1 + 30;
          if (inZone) { const side = this.x < px ? -1 : 1; tx = px + side * 120 * this.s * 0.7; ty = py - 10; lookX = pointer.x; this.timer = Math.max(this.timer, 0.6); }
        }
        if (this.timer < 0) this.next();
      }
      // vuelo con muelle: arranque rápido, frenada en seco
      const ax = (tx - this.x) * k1 - this.vx * k2, ay = (ty - this.y) * k1 - this.vy * k2;
      this.vx += ax * dt; this.vy += ay * dt;
      const sp = Math.hypot(this.vx, this.vy); if (sp > 950) { this.vx *= 950 / sp; this.vy *= 950 / sp; }
      this.x += this.vx * dt; this.y += this.vy * dt + Math.sin(this.t * 3.1) * 0.18;
      const prevFace = this.face;
      if (Math.abs(this.vx) > 80) this.face = this.vx > 0 ? 1 : -1;
      else if (lookX != null) this.face = lookX > this.x ? 1 : -1;
      if (this.face !== prevFace) this.flash = Math.max(this.flash, 0.85);
      const fwd = clamp(Math.abs(this.vx) / 500, 0, 1);
      this.pitch += (wantPitch + fwd * 0.42 - this.pitch) * Math.min(1, dt * 7);
      this.phase += dt * TAU * (5.5 + fwd * 2);
      this.fan = 0.95 + fwd * 0.25;
    }
    wingShape(a, len, col, alpha) {
      B.save(); B.translate(8, -10); B.rotate(a); B.globalAlpha = alpha; B.fillStyle = col;
      B.beginPath(); B.moveTo(0, -3); B.quadraticCurveTo(len * 0.55, -8, len, -1.5); B.quadraticCurveTo(len * 0.6, 8, len * 0.18, 6.5); B.lineTo(0, 4); B.closePath(); B.fill();
      B.globalAlpha = alpha * 0.9; B.fillStyle = C.lo.s; B.beginPath(); B.moveTo(len * 0.55, -5); B.quadraticCurveTo(len * 0.8, -5, len, -1.5); B.quadraticCurveTo(len * 0.78, 3, len * 0.55, 3); B.closePath(); B.fill();
      B.restore(); B.globalAlpha = 1;
    }
    fanShape(a0, a1, len, col, alpha) {
      B.save(); B.translate(8, -10); B.globalAlpha = alpha; B.fillStyle = col; B.beginPath(); B.moveTo(0, 0);
      for (let k = 0; k <= 14; k++) { const a = a0 + (a1 - a0) * k / 14; B.lineTo(Math.cos(a) * len, Math.sin(a) * len); }
      B.closePath(); B.fill(); B.restore(); B.globalAlpha = 1;
    }
    draw() {
      const s = this.s;
      B.save(); B.translate(this.x, this.y); B.scale(this.face * s, s); B.rotate(this.pitch);
      const c0 = -2.05, amp = 0.95 * this.fan, wa = c0 + amp * Math.sin(this.phase), wf = c0 + amp * Math.sin(this.phase - 0.5);
      // ala lejana
      this.fanShape(c0 - amp, c0 + amp, 58, mixS(C.wing, C.bg, 0.3), 0.1);
      this.wingShape(wf, 56, mixS(C.wing, C.bg, 0.35), 0.6);
      // cola en abanico
      const spread = 0.28 + 0.18 * Math.sin(this.t * 1.7) + Math.min(0.3, Math.abs(this.vy) / 1500);
      for (let k = -2; k <= 2; k++) {
        const a = Math.PI * 0.9 + k * spread * 0.32;
        B.save(); B.translate(-22, 6); B.rotate(a);
        B.fillStyle = C.lo.s; B.beginPath(); B.moveTo(0, -4); B.lineTo(24, -4.8); B.lineTo(28, 0); B.lineTo(24, 4.8); B.lineTo(0, 4); B.closePath(); B.fill();
        B.fillStyle = C.mid.s; B.fillRect(0, -3, 13, 6);
        if (Math.abs(k) === 2) { B.fillStyle = C.belly.s; B.beginPath(); B.arc(24, 0, 3, 0, TAU); B.fill(); }
        B.restore();
      }
      // cuerpo con el lomo tornasolado
      const g = B.createLinearGradient(0, -16, 0, 16); g.addColorStop(0, C.hi.s); g.addColorStop(0.5, C.mid.s); g.addColorStop(1, C.lo.s);
      B.fillStyle = g; B.beginPath(); B.ellipse(2, 0, 29, 14.5, 0.14, 0, TAU); B.fill();
      B.beginPath(); B.ellipse(20, -7, 15, 11.5, -0.2, 0, TAU); B.fill();
      B.save(); B.beginPath(); B.ellipse(2, 0, 28, 13.5, 0.14, 0, TAU); B.clip();
      B.fillStyle = mixS(C.lo, C.mid, 0.35);
      for (let yy = -12; yy < 6; yy += 4.2) for (let xx = -26; xx < 26; xx += 5.2) { B.beginPath(); B.arc(xx + (((yy * 10) | 0) % 2 ? 2.6 : 0), yy, 1.25, 0, TAU); B.fill(); }
      const sh = B.createRadialGradient(6 + Math.sin(T * 0.9) * 10, -9, 1, 6, -9, 20); sh.addColorStop(0, 'rgba(255,255,255,0.55)'); sh.addColorStop(1, 'rgba(255,255,255,0)');
      B.fillStyle = sh; B.fillRect(-30, -20, 60, 30);
      B.restore();
      // vientre
      B.fillStyle = C.belly.s; B.beginPath(); B.ellipse(6, 8.5, 20, 6.2, 0.12, 0, TAU); B.fill();
      B.fillStyle = C.mid.s; for (const [bx, by] of [[-6, 7], [0, 10], [8, 6], [13, 9], [-10, 10]]) { B.beginPath(); B.arc(bx, by, 1.4, 0, TAU); B.fill(); }
      // cabeza
      const hg = B.createLinearGradient(20, -28, 36, 0); hg.addColorStop(0, C.hi.s); hg.addColorStop(1, C.mid.s);
      B.fillStyle = hg; B.beginPath(); B.arc(30, -14, 13.5, 0, TAU); B.fill();
      // gorguera: destello entre verde y magenta
      const ir = clamp(0.5 + 0.2 * Math.sin(T * 1.4) + this.flash * 0.5, 0, 1);
      const gg = B.createRadialGradient(31, -5, 1, 30, -3, 11); gg.addColorStop(0, mixS(C.mid, C.gorget, Math.min(1, ir + 0.2))); gg.addColorStop(1, mixS(C.lo, C.gorget, ir * 0.8));
      B.fillStyle = gg; B.beginPath(); B.ellipse(30, -3, 11, 8.5, 0.35, 0, TAU); B.fill();
      // mancha tras el ojo, ojo
      B.fillStyle = C.belly.s; B.beginPath(); B.arc(26, -15.5, 2.4, 0, TAU); B.fill();
      B.fillStyle = '#0b0a08'; B.beginPath(); B.arc(34.5, -17, 3.8, 0, TAU); B.fill();
      B.fillStyle = '#ffffff'; B.beginPath(); B.arc(35.8, -18.4, 1.3, 0, TAU); B.fill();
      // pico
      B.strokeStyle = C.beak.s; B.lineCap = 'round'; B.lineWidth = 3.4; B.beginPath(); B.moveTo(41, -14); B.quadraticCurveTo(64, -14.5, 88, -9); B.stroke();
      // ala cercana con estela de movimiento
      this.fanShape(c0 - amp, c0 + amp, 64, mixS(C.wing, C.bg, 0.2), 0.11);
      this.wingShape(wa - 0.2, 62, mixS(C.wing, C.bg, 0.25), 0.3);
      this.wingShape(wa, 62, mixS(C.wing, C.bg, 0.12), 0.85);
      B.restore();
    }
  }

  /* ---------- bucle ---------- */
  function step(dt) {
    T += dt; heli.update(dt); bird.update(dt);
    for (const d of drops) { d.age += dt; if (d.age > 14) d.dead = true; }
    drops = drops.filter((d) => !d.dead);
    for (const p of sparks) { p.t += dt; p.vy += 120 * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
    sparks = sparks.filter((p) => p.t < p.life);
  }
  const RD = '#%#X%#', RM = 'xX+x%x', RL = '+:x:+:', RV = ':..:·.';
  function put(x, y, ch, col, a) {
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
    if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) return;
    L.fillStyle = rgba(col, a * mask[gy * COLS + gx]); L.fillText(ch, gx * CELL + CELL / 2, gy * CELL + CELL / 2 + 0.5);
  }
  function render(dt) {
    if (!C || !COLS || !mask) return;
    B.setTransform(1, 0, 0, 1, 0, 0); B.clearRect(0, 0, COLS, ROWS);
    B.setTransform(1 / CELL, 0, 0, 1 / CELL, 0, 0); B.lineJoin = 'round';
    heli.draw();
    const bl = Math.floor(Math.max(0, bird.x - 110 * bird.s) / CELL), br = Math.ceil((bird.x + 110 * bird.s) / CELL);
    bird.draw();
    const d = B.getImageData(0, 0, COLS, ROWS).data;
    L.setTransform(DPR, 0, 0, DPR, 0, 0); L.clearRect(0, 0, W, H);
    L.font = `500 ${FS}px ${MONO}`; L.textAlign = 'center'; L.textBaseline = 'middle';
    if (C.dark) { for (const s of stars) { const tw = 0.5 + 0.5 * Math.sin(T * 1.6 + s.ph); put(s.x, s.y, s.big ? '+' : '·', C.inkL, (s.big ? 0.55 : 0.35) * tw); } }
    const decay = Math.exp(-dt * 2.6), half = CELL / 2, TS = CELL - 1.5, tcol = C.muted;
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        const i = cy * COLS + cx, o = i * 4, A = d[o + 3] / 255, m = mask[i], x = cx * CELL, y = cy * CELL;
        trail[i] *= decay;
        if (A < 0.1) {
          if (trail[i] > 0.06) {
            L.fillStyle = rgba(tcol, trail[i] * 0.42 * m); L.fillRect(x + 0.75, y + 0.75, TS, TS);
            L.fillStyle = rgba(tcol, trail[i] * 0.7 * m); L.fillText(hash[i] < 0.5 ? '.' : ':', x + half, y + half + 0.5);
          }
          continue;
        }
        if (cx >= bl && cx <= br && A > 0.5) trail[i] = Math.max(trail[i], 0.55);
        const r = d[o], g = d[o + 1], b = d[o + 2], lu = (0.299 * r + 0.587 * g + 0.114 * b) / 255, h = hash[i];
        if (A > 0.45) {
          L.fillStyle = `rgba(${r},${g},${b},${(0.97 * m * Math.min(1, A * 1.25)).toFixed(3)})`; L.fillRect(x + 0.75, y + 0.75, TS, TS);
          const ch = (lu < 0.28 ? RD : lu < 0.5 ? RM : RL)[(h * 6) | 0];
          L.fillStyle = rgba(lu < 0.55 ? C.inkL : C.inkD, (lu < 0.55 ? 0.4 : 0.32) * m); L.fillText(ch, x + half, y + half + 0.5);
        } else {
          L.fillStyle = `rgba(${r},${g},${b},${(Math.min(1, 0.35 + A * 1.4) * m).toFixed(3)})`; L.fillText(RV[(h * 6) | 0], x + half, y + half + 0.5);
        }
      }
    }
    for (const dr of drops) {
      const pulse = 0.7 + 0.3 * Math.sin(T * 6 + dr.x);
      put(dr.x, dr.y, '*', C.amber, pulse); put(dr.x, dr.y - CELL, '·', C.amber, 0.5 * pulse);
      put(dr.x + CELL, dr.y, '.', C.amber, 0.4 * pulse); put(dr.x - CELL, dr.y, '.', C.amber, 0.4 * pulse);
    }
    for (const p of sparks) { const l = 1 - p.t / p.life; put(p.x, p.y, l > 0.5 ? '*' : '·', C.amber, l); }
  }
  let last = performance.now();
  function frame(now) {
    if (!vivo) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    step(dt); render(dt);
    raf = requestAnimationFrame(frame);
  }

  /* ---------- entrada ---------- */
  const local = (e) => { const r = main.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const alMover = (e) => { if (e.pointerType !== 'mouse') return; const p = local(e); pointer.on = true; pointer.x = p.x; pointer.y = p.y; pointer.t = performance.now(); };
  const alSalir = () => { pointer.on = false; };
  const alTocar = (e) => {
    if (reduce || !bird) return;
    if (e.target.closest('.colibri__centro, button, a, input, textarea, [role="listbox"]')) return;
    const p = local(e);
    if (drops.length < 3) drops.push({ x: clamp(p.x, ZONE.x0 + 20, ZONE.x1 - 20), y: clamp(p.y, ZONE.y0 + 20, ZONE.y1), t: 0, age: 0, dead: false });
  };
  main.addEventListener('pointermove', alMover);
  main.addEventListener('pointerleave', alSalir);
  main.addEventListener('pointerdown', alTocar);

  const temaObs = new MutationObserver(() => requestAnimationFrame(readColors));
  temaObs.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  const obsMain = new ResizeObserver(resize);
  obsMain.observe(main);
  const obsCentro = new ResizeObserver(() => { computeMask(); drawBg(); if (heli) heli.layout(); if (bird) bird.fit(); });
  obsCentro.observe(centro);

  /* ---------- arranque ---------- */
  resize(); readColors();
  heli = new Heliconia(); bird = new Colibri();
  if (document.fonts?.ready) document.fonts.ready.then(() => { if (vivo) { computeMask(); drawBg(); } });
  if (reduce) { for (let i = 0; i < 90; i++) step(1 / 30); render(0); }
  else raf = requestAnimationFrame((t) => { last = t; raf = requestAnimationFrame(frame); });

  return () => {
    vivo = false;
    cancelAnimationFrame(raf);
    temaObs.disconnect(); obsMain.disconnect(); obsCentro.disconnect();
    main.removeEventListener('pointermove', alMover);
    main.removeEventListener('pointerleave', alSalir);
    main.removeEventListener('pointerdown', alTocar);
  };
}

// `children` va en el centro (saludo, titular, cuadro de mensaje): el dibujo se
// atenúa alrededor de ese bloque y el colibrí no vuela por encima de él.
export function ColibriHero({ children }) {
  const mainRef = useRef(null);
  const centroRef = useRef(null);
  const fondoRef = useRef(null);
  const vivoRef = useRef(null);

  useEffect(() => montar(mainRef.current, centroRef.current, fondoRef.current, vivoRef.current), []);

  return (
    <div className="chat-hero colibri" ref={mainRef}>
      <canvas className="colibri__lienzo" ref={fondoRef} aria-hidden="true" />
      <canvas className="colibri__lienzo" ref={vivoRef} aria-hidden="true" />
      <div className="colibri__centro" ref={centroRef}>{children}</div>
    </div>
  );
}
