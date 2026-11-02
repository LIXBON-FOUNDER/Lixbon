"""Biblioteca de esqueletos: cada carácter se dibuja una vez y cada familia
le aplica su trazo (terminales, contraste, serifas, proporciones)."""
import math
from geo import Sk, St, arc, line, cubic, lerp, circle


class Glyph:
    def __init__(self, strokes=(), serifs=(), dots=(), sb=('s', 's'), tab=False, polys=()):
        self.strokes = list(strokes)
        self.serifs = list(serifs)
        self.dots = list(dots)      # (cx, cy, r)
        self.sb = sb
        self.tab = tab
        self.polys = list(polys)

    def add(self, other):
        self.strokes += other.strokes
        self.serifs += other.serifs
        self.dots += other.dots
        self.polys += other.polys
        return self

    def mapped(self, fn, flipx=False):
        g = Glyph([s.mapped(fn) for s in self.strokes], [], [], self.sb, self.tab,
                  [[fn(p) for p in poly] for poly in self.polys])
        for (x, y, k) in self.serifs:
            nx, ny = fn((x, y))
            if flipx:
                k = k.replace('L', '#').replace('R', 'L').replace('#', 'R')
            g.serifs.append((nx, ny, k))
        for (x, y, r) in self.dots:
            nx, ny = fn((x, y))
            g.dots.append((nx, ny, r))
        return g


def shift(g, dx, dy=0):
    return g.mapped(lambda p: (p[0] + dx, p[1] + dy))


ROUND = set('obdpqgceOCGQD') | {'a1'}


class Lib:
    def __init__(self, F):
        self.F = F
        self.X, self.Cp, self.A, self.D = F.xh, F.cap, F.asc, F.desc
        self.v, self.h, self.o = F.wv / 2, F.wh / 2, F.ov

    # ---- medidas ----
    def w(self, f, key):
        F = self.F
        wd = F.wov.get(key, f) * self.X * F.W
        if key in ROUND:
            wd *= getattr(F, 'rw', 1.0)
        if F.mono:
            wd = min(max(wd, F.mono_min), F.mono_max)
        return wd

    def cw(self, f, key):
        F = self.F
        wd = F.wov.get(key, f) * self.Cp * F.W
        if key in ROUND:
            wd *= getattr(F, 'rwC', 1.0)
        if F.mono:
            wd = min(max(wd, F.mono_min), F.mono_max)
        return wd

    def tc(self, H):   # centro del trazo superior de una curva de altura H
        return H + self.o - self.h

    @property
    def bc(self):
        return -self.o + self.h

    # ---- piezas compartidas ----
    def arch(self, x0, x1, H, yend=None):
        F = self.F
        yj = H * F.aj
        yt = self.tc(H)
        ys = H * 0.58 if yend is None else yend
        dx = x1 - x0
        xm = x0 + F.am * dx
        return (Sk((x0, yj)).C((x0 + 0.06 * dx, yj + (yt - yj) * 0.82), (xm - 0.33 * dx, yt), (xm, yt))
                .C((xm + 0.56 * (x1 - xm), yt), (x1, ys + (yt - ys) * 0.60), (x1, ys)))

    def bowl(self, x0, wd, H=None, ylo=0.0):
        """Panza unida a un asta en x0 que se abre hacia la derecha."""
        F = self.F
        H = H or self.X
        yt, yb = self.tc(ylo + H) , ylo + self.bc
        cy = (yt + yb) / 2
        ry = (yt - yb) / 2
        if F.geo:
            return [St(arc(x0 + wd / 2, cy, wd / 2, ry, 0, 360, F.sup), closed=True)]
        cx = x0 + wd * 0.47
        rx = x0 + wd - cx
        hh = H
        s = (Sk((x0, ylo + hh * F.bj_hi)).C((x0 + 0.05 * wd, ylo + hh * F.bj_hi + (yt - ylo - hh * F.bj_hi) * 0.75),
                                           (cx - 0.30 * wd, yt), (cx, yt))
             .A(cx, cy, rx, ry, 90, -90, F.sup)
             .C((cx - 0.30 * wd, yb), (x0 + 0.05 * wd, ylo + hh * F.bj_lo * 0.35), (x0, ylo + hh * F.bj_lo)))
        return [St(s, 'J', 'J')]

    def ellipse(self, cx, H, rx, ylo=0.0):
        yt, yb = self.tc(ylo + H), ylo + self.bc
        return St(arc(cx, (yt + yb) / 2, rx, (yt - yb) / 2, 0, 360, self.F.sup), closed=True)

    def cshape(self, wd, H, a0, a1, c0='K', c1='E'):
        yt, yb = self.tc(H), self.bc
        return St(arc(wd / 2, (yt + yb) / 2, wd / 2, (yt - yb) / 2, a0, a1, self.F.sup), c0, c1)

    def stem(self, x, y0, y1, c0='T', c1='T'):
        return St(line((x, y0), (x, y1)), c0, c1)

    def bar(self, x0, x1, y, c0='T', c1='T'):
        return St(line((x0, y), (x1, y)), c0, c1)

    def dot(self, x, y, k=1.0):
        return (x, y, self.F.dot * k)

    @property
    def dt(self):
        return getattr(self.F, 'diag_thin', 1.0)

    @property
    def dk(self):
        return getattr(self.F, 'diag_thick', 1.0)

    def apex_lo(self):
        return -self.o * 0.3

    # ======================= minúsculas =======================
    def g_n(self, H=None, asc=False):
        X = self.X
        wd = self.w(0.80, 'n')
        top = self.A if asc else X
        g = Glyph([self.stem(0, 0, top), St(self.arch(0, wd, X).L((wd, 0)), 'J', 'T')],
                  [(0, top, 'tL'), (0, 0, 'b2'), (wd, 0, 'b2')], sb=('s', 's'))
        return g

    def g_h(self):
        return self.g_n(asc=True)

    def g_m(self):
        X = self.X
        wd = self.w(1.30, 'm')
        m = wd / 2
        return Glyph([self.stem(0, 0, X), St(self.arch(0, m, X).L((m, 0)), 'J', 'T'),
                      St(self.arch(m, wd, X).L((wd, 0)), 'J', 'T')],
                     [(0, X, 'tL'), (0, 0, 'b2'), (m, 0, 'b2'), (wd, 0, 'b2')])

    def g_u(self):
        X = self.X
        wd = self.w(0.80, 'n')
        n = self.g_n()
        g = n.mapped(lambda p: (wd - p[0], X - p[1]))
        g.serifs = [(0, X, 'tL'), (wd, X, 'tL'), (wd, 0, 'bR')]
        return g

    def g_r(self):
        X, F = self.X, self.F
        wd = self.w(0.50, 'r')
        yj = X * F.aj
        yt = self.tc(X)
        arm = (Sk((0, yj)).C((0.05 * wd, yj + (yt - yj) * 0.82), (0.30 * wd, yt), (0.62 * wd, yt))
               .C((0.80 * wd, yt), (0.93 * wd, yt - 0.03 * X), (wd, yt - 0.09 * X)))
        return Glyph([self.stem(0, 0, X), St(arm, 'J', 'K')], [(0, X, 'tL'), (0, 0, 'b2')], sb=('s', 'd'))

    def g_b(self, desc=False):
        X, A, D = self.X, self.A, self.D
        wd = self.w(0.86, 'b')
        st = self.stem(0, D, X) if desc else self.stem(0, 0, A)
        g = Glyph([st] + self.bowl(0, wd), sb=('s', 'r'))
        g.serifs = [(0, X, 'tL'), (0, D, 'b2')] if desc else [(0, A, 'tL')]
        return g

    def g_p(self):
        return self.g_b(desc=True)

    def g_d(self, desc=False):
        X, A, D = self.X, self.A, self.D
        wd = self.w(0.86, 'd')
        b = Glyph(self.bowl(0, wd))
        b = b.mapped(lambda p: (wd - p[0], p[1]))
        st = self.stem(wd, D, X) if desc else self.stem(wd, 0, A)
        g = Glyph([st] + b.strokes, sb=('r', 's'))
        g.serifs = [(wd, D, 'b2')] if desc else [(wd, A, 'tL'), (wd, 0, 'bR')]
        return g

    def g_q(self):
        return self.g_d(desc=True)

    def g_o(self):
        wd = self.w(0.92, 'o')
        return Glyph([self.ellipse(wd / 2, self.X, wd / 2)], sb=('r', 'r'))

    def g_c(self):
        wd = self.w(0.78, 'c')
        F = self.F
        return Glyph([self.cshape(wd, self.X, F.aper, 360 - F.aper, 'K', 'E')], sb=('r', 'o'))

    def g_e(self):
        X, F = self.X, self.F
        wd = self.w(0.84, 'e')
        yt, yb = self.tc(X), self.bc
        cy, ry = (yt + yb) / 2, (yt - yb) / 2
        ye = cy + 0.03 * X
        a0 = math.degrees(math.asin(min(0.99, (ye - cy) / ry)))
        bowl = St(arc(wd / 2, cy, wd / 2, ry, a0, 360 - F.eaper, F.sup), 'J', 'E')
        x_r = wd / 2 + wd / 2 * math.cos(math.radians(a0)) ** (2 / F.sup)
        return Glyph([self.bar(0, x_r, ye, 'J', 'J'), bowl], sb=('r', 'o'))

    def g_a(self):
        X, F = self.X, self.F
        if not F.a2:
            wd = self.w(0.86, 'a1')
            return Glyph([self.ellipse(wd / 2, X, wd / 2), self.stem(wd, 0, X)],
                         [(wd, 0, 'bR')], sb=('r', 's'))
        wd = self.w(0.74, 'a')
        yt, yb = self.tc(X), self.bc
        top = (Sk((wd, 0)).L((wd, 0.60 * X)).C((wd, yt - 0.01 * X), (0.80 * wd, yt), (0.48 * wd, yt))
               .C((0.26 * wd, yt), (0.09 * wd, yt - 0.06 * X), (0.04 * wd, 0.80 * X)))
        yb_top = F.a_bar * X
        bwl = (Sk((wd, yb_top)).C((0.62 * wd, yb_top + 0.02 * X), (0, yb_top - 0.02 * X), (0, 0.26 * X))
               .C((0, 0.07 * X), (0.22 * wd, yb), (0.45 * wd, yb))
               .C((0.70 * wd, yb), (0.92 * wd, 0.10 * X), (wd, 0.24 * X)))
        return Glyph([St(top, 'T', 'K'), St(bwl, 'J', 'J')], [(wd, 0, 'bR')], sb=('o', 's'))

    def g_g(self):
        X, D, F = self.X, self.D, self.F
        if F.g2:
            return self.g_g2()
        wd = self.w(0.86, 'g')
        b = Glyph(self.bowl(0, wd)).mapped(lambda p: (wd - p[0], p[1]))
        Db = D - self.o + self.h
        tail = (Sk((wd, X)).L((wd, 0.12 * D)).C((wd, 0.80 * D), (0.80 * wd, Db), (0.50 * wd, Db))
                .C((0.30 * wd, Db), (0.14 * wd, 0.93 * D), (0.07 * wd, 0.80 * D)))
        return Glyph([St(tail, 'T', 'E')] + b.strokes, sb=('r', 's'))

    def g_g2(self):
        X, D = self.X, self.D
        wd = self.w(0.80, 'g')
        # ojo superior
        top = St(arc(0.44 * wd, 0.66 * X, 0.36 * wd, 0.30 * X + self.o - self.h * 1.6, 0, 360, self.F.sup), closed=True)
        ear = St(Sk((0.70 * wd, 0.90 * X)).C((0.80 * wd, 0.98 * X), (0.90 * wd, self.tc(X)), (wd, self.tc(X))), 'J', 'E')
        Db = D - self.o + self.h
        link = (Sk((0.30 * wd, 0.40 * X)).C((0.08 * wd, 0.30 * X), (0.08 * wd, 0.10 * X), (0.40 * wd, 0.10 * X))
                .L((0.62 * wd, 0.10 * X))
                .C((0.98 * wd, 0.10 * X), (1.02 * wd, -0.10 * X), (1.02 * wd, 0.45 * D))
                .C((1.02 * wd, 0.85 * D), (0.78 * wd, Db), (0.48 * wd, Db))
                .C((0.16 * wd, Db), (-0.04 * wd, 0.85 * D), (-0.04 * wd, 0.55 * D))
                .C((-0.04 * wd, 0.30 * D), (0.10 * wd, 0.10 * X), (0.46 * wd, 0.10 * X)))
        return Glyph([top, ear, St(link, 'J', 'J')], sb=('r', 'o'))

    def g_i(self, dotless=False):
        X, A, F = self.X, self.A, self.F
        g = Glyph([self.stem(0, 0, X)], [(0, X, 'tL'), (0, 0, 'b2')])
        if F.mono:
            g = Glyph([self.stem(0, 0, X, 'T', 'J'), self.bar(-0.30 * F.cell, 0, X - self.h, 'T', 'J'),
                       self.bar(-0.30 * F.cell, 0.30 * F.cell, self.h, 'T', 'T')])
        if not dotless:
            g.dots.append(self.dot(0, self.idot()))
        return g

    def idot(self):
        return self.X + (self.A - self.X) * 0.60

    def g_dotlessi(self):
        return self.g_i(dotless=True)

    def g_j(self):
        X, D, F = self.X, self.D, self.F
        hw = 0.32 * X * F.W
        Db = D - self.o + self.h
        s = Sk((0, X)).L((0, 0.30 * D)).C((0, 0.85 * D), (-0.25 * hw, Db), (-0.55 * hw, Db)).C((-0.75 * hw, Db), (-0.92 * hw, 0.95 * D), (-hw, 0.86 * D))
        g = Glyph([St(s, 'T', 'K')], [(0, X, 'tL')], sb=('o', 's'))
        if F.mono:
            g.strokes.append(self.bar(-0.28 * F.cell, 0, X - self.h, 'T', 'J'))
        g.dots.append(self.dot(0, self.idot()))
        return g

    def g_k(self):
        X, A = self.X, self.A
        wd = self.w(0.74, 'k')
        j = (0, 0.30 * X)
        top = (wd * 0.96, X)
        arm = St(line(top, j), 'Th', 'J', wmul=self.dt)
        p = lerp(top, j, 0.56)
        leg = St(line(p, (wd, 0)), 'J', 'Th')
        return Glyph([self.stem(0, 0, A), arm, leg],
                     [(0, A, 'tL'), (0, 0, 'b2'), (top[0], X, 't2s'), (wd, 0, 'b2s')], sb=('s', 'd'))

    def g_l(self):
        A, F = self.A, self.F
        if F.mono:
            k = 0.30 * F.cell
            s = Sk((0, A - self.h)).L((0, 0.22 * self.X)).C((0, 0.05 * self.X), (0.08 * F.cell, self.bc), (0.22 * F.cell, self.bc)).L((k, self.bc))
            return Glyph([St(s, 'J', 'E'), self.bar(-k, 0, A - self.h, 'T', 'J')])
        if F.l_tail:
            s = Sk((0, A)).L((0, 0.20 * self.X)).C((0, 0.05 * self.X), (0.06 * self.X, self.bc), (0.20 * self.X, self.bc)).L((0.24 * self.X, self.bc))
            return Glyph([St(s, 'T', 'E')], [(0, A, 'tL')], sb=('s', 'o'))
        return Glyph([self.stem(0, 0, A)], [(0, A, 'tL'), (0, 0, 'b2')])

    def g_f(self):
        X, A, F = self.X, self.A, self.F
        wd = self.w(0.54, 'f')
        sx = 0.34 * wd
        At = self.tc(A)
        s = (Sk((sx, 0)).L((sx, A - 0.34 * X)).C((sx, At - 0.02 * X), (sx + 0.20 * wd, At), (sx + 0.42 * wd, At))
             .C((sx + 0.56 * wd, At), (sx + 0.64 * wd, At - 0.02 * X), (wd, At - 0.07 * X)))
        g = Glyph([St(s, 'T', 'K'), self.bar(0, 0.92 * wd, X - self.h)], [(sx, 0, 'b2')], sb=('d', 'z'))
        if F.mono:
            g.strokes.append(self.bar(sx - 0.30 * F.cell, sx + 0.30 * F.cell, self.h))
        return g

    def g_t(self):
        X, F = self.X, self.F
        wd = self.w(0.52, 't')
        sx = 0.34 * wd
        yb = self.bc
        s = Sk((sx, X + 0.24 * X)).L((sx, 0.24 * X)).C((sx, 0.06 * X), (sx + 0.12 * wd, yb), (sx + 0.34 * wd, yb)).C((sx + 0.48 * wd, yb), (0.88 * wd, yb + 0.01 * X), (wd, 0.04 * X))
        return Glyph([St(s, 'T', 'N'), self.bar(0, 0.92 * wd, X - self.h)], sb=('d', 'd'))

    def g_s(self, H=None, key='s', f=0.68):
        X = H or self.X
        wd = self.w(f, key) if H is None else self.cw(f, key)
        yt, yb = self.tc(X), self.bc
        s = (Sk((0.92 * wd, 0.80 * X)).C((0.84 * wd, 0.95 * X), (0.70 * wd, yt), (0.48 * wd, yt))
             .C((0.22 * wd, yt), (0.06 * wd, 0.88 * X), (0.06 * wd, 0.72 * X))
             .C((0.06 * wd, 0.57 * X), (0.28 * wd, 0.53 * X), (0.50 * wd, 0.495 * X))
             .C((0.74 * wd, 0.455 * X), (0.95 * wd, 0.40 * X), (0.95 * wd, 0.25 * X))
             .C((0.95 * wd, 0.09 * X), (0.76 * wd, yb), (0.50 * wd, yb))
             .C((0.26 * wd, yb), (0.10 * wd, 0.06 * X), (0.03 * wd, 0.20 * X)))
        return Glyph([St(s, 'E', 'E')], sb=('o', 'o'))

    def g_v(self, H=None, key='v', f=0.86, caps=False):
        H = H or self.X
        wd = self.cw(f, key) if caps else self.w(f, key)
        lo = self.apex_lo()
        return Glyph([St(line((0, H), (wd / 2, lo)), 'Th', 'A'), St(line((wd / 2, lo), (wd, H)), 'A', 'Th', wmul=self.dt)],
                     [(0, H, 't2s'), (wd, H, 't2s')], sb=('d', 'd'))

    def g_w(self, H=None, caps=False):
        H = H or self.X
        wd = self.cw(1.14, 'W') if caps else self.w(1.28, 'w')
        lo = self.apex_lo()
        mid = H if not self.F.w_low else H * 0.82
        pts = [(0, H), (wd * 0.25, lo), (wd * 0.5, mid), (wd * 0.75, lo), (wd, H)]
        strokes = []
        for i in range(4):
            c0 = 'Th' if i == 0 else 'A'
            c1 = 'Th' if i == 3 else 'A'
            strokes.append(St(line(pts[i], pts[i + 1]), c0, c1, wmul=self.dt if i % 2 else 1.0))
        return Glyph(strokes, [(0, H, 't2s'), (wd, H, 't2s')], sb=('d', 'd'))

    def g_x(self, H=None, caps=False):
        H = H or self.X
        wd = self.cw(0.76, 'X') if caps else self.w(0.82, 'x')
        return Glyph([St(line((0, H), (wd, 0)), 'Th', 'Th'), St(line((wd, H), (0, 0)), 'Th', 'Th', wmul=self.dt)],
                     [(0, H, 't2s'), (wd, H, 't2s'), (0, 0, 'b2s'), (wd, 0, 'b2s')], sb=('d', 'd'))

    def g_y(self):
        X, D, F = self.X, self.D, self.F
        wd = self.w(0.86, 'y')
        lo = 0.0
        apex = (wd * 0.5, lo)
        slope = (wd - apex[0]) / (X - apex[1])
        left = St(line((0, X), apex), 'Th', 'A')
        if F.y_tail == 'curve':
            Db = D - self.o + self.h
            xb = apex[0] - slope * (apex[1] - 0.55 * D)
            s = (Sk((wd, X)).L((xb, 0.55 * D)).C((xb - slope * 0.25 * abs(D), 0.82 * D), (xb - 0.12 * wd, Db), (xb - 0.30 * wd, Db))
                 .L((xb - 0.36 * wd, Db)))
            right = St(s, 'Th', 'K', wmul=self.dt)
        else:
            xe = apex[0] - slope * (apex[1] - D)
            right = St(line((wd, X), (xe, D)), 'Th', 'Th', wmul=self.dt)
        return Glyph([left, right], [(0, X, 't2s'), (wd, X, 't2s')], sb=('d', 'd'))

    def g_z(self, H=None, caps=False):
        H = H or self.X
        wd = self.cw(0.64, 'Z') if caps else self.w(0.72, 'z')
        h = self.h
        return Glyph([self.bar(0.04 * wd, wd, H - h, 'T', 'T'), St(line((wd, H - h), (0, h)), 'A', 'A', wmul=self.dk),
                      self.bar(0, wd, h, 'T', 'T')],
                     [(0.04 * wd, H, 'vD'), (wd, 0, 'vU')], sb=('o', 'o'))

    # ======================= mayúsculas =======================
    def C_A(self):
        Cp = self.Cp
        wd = self.cw(0.80, 'A')
        apex = (wd / 2, Cp + self.o * 0.3)
        yb = 0.28 * Cp
        k = yb / apex[1]
        return Glyph([St(line((0, 0), apex), 'Th', 'A', wmul=self.dt), St(line(apex, (wd, 0)), 'A', 'Th'),
                      self.bar(k * apex[0], wd - k * apex[0], yb, 'J', 'J')],
                     [(0, 0, 'b2s'), (wd, 0, 'b2s')], sb=('d', 'd'))

    def C_B(self):
        Cp, h = self.Cp, self.h
        wd = self.cw(0.62, 'B')
        ym = 0.54 * Cp
        top = (Sk((0, Cp - h)).L((0.50 * wd, Cp - h)).C((0.78 * wd, Cp - h), (0.88 * wd, Cp - 0.06 * Cp), (0.88 * wd, 0.78 * Cp))
               .C((0.88 * wd, 0.62 * Cp), (0.76 * wd, ym), (0.50 * wd, ym)).L((0, ym)))
        bot = (Sk((0.50 * wd, ym)).C((0.82 * wd, ym), (wd, 0.47 * Cp), (wd, 0.28 * Cp))
               .C((wd, 0.09 * Cp), (0.84 * wd, h), (0.54 * wd, h)).L((0, h)))
        return Glyph([self.stem(0, 0, Cp), St(top, 'J', 'J'), St(bot, 'J', 'J')], [(0, Cp, 'tL'), (0, 0, 'bL')], sb=('s', 'r'))

    def C_C(self):
        wd = self.cw(0.78, 'C')
        F = self.F
        return Glyph([self.cshape(wd, self.Cp, F.aperC, 360 - F.aperC, 'E', 'E')], sb=('r', 'o'))

    def C_D(self):
        Cp, h = self.Cp, self.h
        wd = self.cw(0.74, 'D')
        s = (Sk((0, Cp - h)).L((0.40 * wd, Cp - h)).C((0.80 * wd, Cp - h), (wd, 0.78 * Cp), (wd, 0.5 * Cp))
             .C((wd, 0.22 * Cp), (0.80 * wd, h), (0.40 * wd, h)).L((0, h)))
        return Glyph([self.stem(0, 0, Cp), St(s, 'J', 'J')], [(0, Cp, 'tL'), (0, 0, 'bL')], sb=('s', 'r'))

    def C_E(self, F_only=False):
        Cp, h = self.Cp, self.h
        wd = self.cw(0.56, 'E')
        s = [self.stem(0, 0, Cp), self.bar(0, 0.94 * wd, Cp - h, 'J', 'T'), self.bar(0, 0.82 * wd, 0.52 * Cp, 'J', 'T')]
        ser = [(0, Cp, 'tL'), (0.94 * wd, Cp, 'vD'), (0.82 * wd, 0.52 * Cp, 'vB')]
        if F_only:
            return Glyph(s, ser + [(0, 0, 'b2')], sb=('s', 'o'))
        s.append(self.bar(0, wd, h, 'J', 'T'))
        return Glyph(s, ser + [(0, 0, 'bL'), (wd, 0, 'vU')], sb=('s', 'o'))

    def C_F(self):
        return self.C_E(F_only=True)

    def C_G(self):
        Cp, F = self.Cp, self.F
        wd = self.cw(0.82, 'G')
        yt, yb = self.tc(Cp), self.bc
        cy, ry = (yt + yb) / 2, (yt - yb) / 2
        ybar = 0.44 * Cp
        a1 = 360 - math.degrees(math.asin(min(0.99, (cy - ybar) / ry)))
        s = Sk(arc(wd / 2, cy, wd / 2, ry, F.aperC, a1, F.sup)[0])
        s.A(wd / 2, cy, wd / 2, ry, F.aperC, a1, F.sup)
        xe = s.cur[0]
        if F.serif:
            # serifa: la curva termina en la barra; barra con cuerpo y espolón vertical
            g = Glyph([St(s, 'E', 'N'), self.bar(0.52 * wd, xe + self.v, ybar, 'T', 'N'),
                       St(line((xe, ybar), (xe, 0.06 * Cp)), 'N', 'T', wmul=0.9)], sb=('r', 's'))
            g.strokes[1].wmul = 2.0
            return g
        s.L((0.56 * wd, ybar))
        g = Glyph([St(s, 'E', 'T')], sb=('r', 's'))
        if F.G_spur:
            g.strokes.append(self.stem(xe, ybar, 0.04 * Cp, 'J', 'T'))
        return g

    def C_H(self):
        Cp = self.Cp
        wd = self.cw(0.70, 'H')
        return Glyph([self.stem(0, 0, Cp), self.stem(wd, 0, Cp), self.bar(0, wd, 0.50 * Cp, 'J', 'J')],
                     [(0, Cp, 't2'), (0, 0, 'b2'), (wd, Cp, 't2'), (wd, 0, 'b2')])

    def C_I(self):
        Cp, F = self.Cp, self.F
        if F.mono:
            k = 0.30 * F.cell
            return Glyph([self.stem(0, self.h, Cp - self.h, 'N', 'N'), self.bar(-k, k, Cp - self.h), self.bar(-k, k, self.h)])
        return Glyph([self.stem(0, 0, Cp)], [(0, Cp, 't2'), (0, 0, 'b2')])

    def C_J(self):
        Cp = self.Cp
        wd = self.cw(0.50, 'J')
        yb = self.bc
        s = Sk((wd, Cp)).L((wd, 0.30 * Cp)).C((wd, 0.08 * Cp), (0.80 * wd, yb), (0.50 * wd, yb)).C((0.24 * wd, yb), (0.06 * wd, 0.06 * Cp), (0.0, 0.20 * Cp))
        return Glyph([St(s, 'T', 'E')], [(wd, Cp, 't2')], sb=('o', 's'))

    def C_K(self):
        Cp = self.Cp
        wd = self.cw(0.66, 'K')
        top = (wd * 0.96, Cp)
        j = (0, 0.36 * Cp)
        p = lerp(top, j, 0.55)
        return Glyph([self.stem(0, 0, Cp), St(line(top, j), 'Th', 'J', wmul=self.dt), St(line(p, (wd, 0)), 'J', 'Th')],
                     [(0, Cp, 't2'), (0, 0, 'b2'), (top[0], Cp, 't2s'), (wd, 0, 'b2s')], sb=('s', 'd'))

    def C_L(self):
        Cp = self.Cp
        wd = self.cw(0.54, 'L')
        return Glyph([self.stem(0, 0, Cp), self.bar(0, wd, self.h, 'J', 'T')], [(0, Cp, 't2'), (0, 0, 'bL'), (wd, 0, 'vU')], sb=('s', 'o'))

    def C_M(self):
        Cp = self.Cp
        wd = self.cw(0.86, 'M')
        lo = self.apex_lo()
        top = Cp
        ms = St(line((0, 0), (0, top)), 'T', 'T', wmul=self.dt)
        return Glyph([ms, self.stem(wd, 0, top, 'T', 'T'),
                      St(line((0, top), (wd / 2, lo)), 'A', 'A'), St(line((wd / 2, lo), (wd, top)), 'A', 'A', wmul=self.dt)],
                     [(0, 0, 'b2'), (wd, 0, 'b2'), (0, Cp, 'tL'), (wd, Cp, 'tR')])

    def C_N(self):
        Cp = self.Cp
        wd = self.cw(0.72, 'N')
        return Glyph([St(line((0, 0), (0, Cp)), 'T', 'T', wmul=self.dt), St(line((wd, 0), (wd, Cp)), 'T', 'T', wmul=self.dt), St(line((0, Cp), (wd, 0)), 'A', 'A')],
                     [(0, Cp, 'tL'), (0, 0, 'b2'), (wd, Cp, 't2')])

    def C_O(self):
        wd = self.cw(0.86, 'O')
        return Glyph([self.ellipse(wd / 2, self.Cp, wd / 2)], sb=('r', 'r'))

    def C_P(self, R=False):
        Cp, h = self.Cp, self.h
        wd = self.cw(0.62 if not R else 0.62, 'P')
        ym = 0.44 * Cp
        s = (Sk((0, Cp - h)).L((0.50 * wd, Cp - h)).C((0.84 * wd, Cp - h), (wd, Cp * 0.86), (wd, (Cp + ym) / 2))
             .C((wd, ym + 0.08 * Cp), (0.84 * wd, ym), (0.50 * wd, ym)).L((0, ym)))
        g = Glyph([self.stem(0, 0, Cp), St(s, 'J', 'J')], [(0, Cp, 'tL'), (0, 0, 'b2')], sb=('s', 'r'))
        if R:
            g.strokes.append(St(line((0.48 * wd, ym), (wd * 1.02, 0)), 'J', 'Th'))
            g.serifs.append((wd * 1.02, 0, 'b2s'))
            g.sb = ('s', 'd')
        return g

    def C_Q(self):
        wd = self.cw(0.86, 'O')
        g = self.C_O()
        g.strokes.append(St(line((0.56 * wd, 0.18 * self.Cp), (0.98 * wd, -0.14 * self.Cp)), 'J', 'T'))
        return g

    def C_R(self):
        return self.C_P(R=True)

    def C_S(self):
        return self.g_s(H=self.Cp, key='S', f=0.60)

    def C_T(self):
        Cp, h = self.Cp, self.h
        wd = self.cw(0.66, 'T')
        return Glyph([self.bar(0, wd, Cp - h), self.stem(wd / 2, 0, Cp - h, 'T', 'N')],
                     [(wd / 2, 0, 'b2'), (0, Cp, 'vDL'), (wd, Cp, 'vD')], sb=('o', 'o'))

    def C_U(self):
        Cp = self.Cp
        wd = self.cw(0.70, 'U')
        yb = self.bc
        s = (Sk((0, Cp)).L((0, 0.36 * Cp)).C((0, 0.10 * Cp), (0.20 * wd, yb), (0.5 * wd, yb))
             .C((0.80 * wd, yb), (wd, 0.10 * Cp), (wd, 0.36 * Cp)).L((wd, Cp)))
        return Glyph([St(s, 'T', 'T')], [(0, Cp, 't2'), (wd, Cp, 't2')])

    def C_V(self):
        return self.g_v(H=self.Cp, key='V', f=0.80, caps=True)

    def C_W(self):
        return self.g_w(H=self.Cp, caps=True)

    def C_X(self):
        return self.g_x(H=self.Cp, caps=True)

    def C_Y(self):
        Cp = self.Cp
        wd = self.cw(0.76, 'Y')
        j = (wd / 2, 0.44 * Cp)
        return Glyph([St(line((0, Cp), j), 'Th', 'J'), St(line((wd, Cp), j), 'Th', 'J', wmul=self.dt), self.stem(wd / 2, 0, j[1], 'T', 'J')],
                     [(0, Cp, 't2s'), (wd, Cp, 't2s'), (wd / 2, 0, 'b2')], sb=('d', 'd'))

    def C_Z(self):
        return self.g_z(H=self.Cp, caps=True)

    # ======================= cifras =======================
    def dw(self):
        F = self.F
        d = 0.56 * self.Cp * F.W * F.digit_w
        if F.mono:
            d = min(d, F.mono_max)
        return d

    def n0(self):
        dw, Cp = self.dw(), self.Cp
        g = Glyph([self.ellipse(dw / 2, Cp, dw / 2)], tab=True)
        if self.F.mono:
            g.strokes.append(St(line((0.30 * dw, 0.30 * Cp), (0.70 * dw, 0.70 * Cp)), 'T', 'T', wmul=0.85))
        return g

    def n1(self):
        dw, Cp, F = self.dw(), self.Cp, self.F
        sx = 0.56 * dw
        g = Glyph([self.stem(sx, 0, Cp, 'T', 'J'), St(line((sx, Cp), (0.10 * dw, 0.80 * Cp)), 'J', 'T')], tab=True)
        if F.mono or F.serif:
            g.strokes.append(self.bar(0.12 * dw, dw * 0.98, self.h))
        return g

    def n2(self):
        dw, Cp = self.dw(), self.Cp
        yt = self.tc(Cp)
        s = (Sk((0.05 * dw, 0.74 * Cp)).C((0.10 * dw, 0.93 * Cp), (0.30 * dw, yt), (0.50 * dw, yt))
             .C((0.76 * dw, yt), (0.94 * dw, 0.90 * Cp), (0.94 * dw, 0.71 * Cp))
             .C((0.94 * dw, 0.48 * Cp), (0.30 * dw, 0.30 * Cp), (0.02 * dw, self.h)))
        return Glyph([St(s, 'K', 'J'), self.bar(0.02 * dw, dw, self.h, 'J', 'T')], tab=True)

    def n3(self):
        dw, Cp = self.dw(), self.Cp
        yt, yb = self.tc(Cp), self.bc
        ym = 0.55 * Cp
        top = (Sk((0.07 * dw, 0.80 * Cp)).C((0.16 * dw, 0.95 * Cp), (0.30 * dw, yt), (0.50 * dw, yt))
               .C((0.76 * dw, yt), (0.90 * dw, 0.90 * Cp), (0.90 * dw, 0.76 * Cp))
               .C((0.90 * dw, 0.62 * Cp), (0.72 * dw, ym), (0.46 * dw, ym)).L((0.36 * dw, ym)))
        bot = (Sk((0.46 * dw, ym)).C((0.78 * dw, ym), (0.97 * dw, 0.46 * Cp), (0.97 * dw, 0.28 * Cp))
               .C((0.97 * dw, 0.10 * Cp), (0.78 * dw, yb), (0.50 * dw, yb))
               .C((0.26 * dw, yb), (0.08 * dw, 0.07 * Cp), (0.03 * dw, 0.20 * Cp)))
        return Glyph([St(top, 'K', 'T'), St(bot, 'J', 'E')], tab=True)

    def n4(self):
        dw, Cp = self.dw(), self.Cp
        sx = 0.74 * dw
        yb = 0.28 * Cp
        return Glyph([self.stem(sx, 0, Cp, 'T', 'J'), St(line((sx, Cp), (0.0, yb)), 'J', 'J'), self.bar(0, dw, yb, 'J', 'T')], tab=True)

    def n5(self):
        dw, Cp = self.dw(), self.Cp
        yb = self.bc
        h = self.h
        s = (Sk((0.90 * dw, Cp - h)).L((0.18 * dw, Cp - h)).L((0.11 * dw, 0.53 * Cp))
             .C((0.24 * dw, 0.60 * Cp), (0.36 * dw, 0.625 * Cp), (0.50 * dw, 0.625 * Cp))
             .C((0.80 * dw, 0.625 * Cp), (0.97 * dw, 0.48 * Cp), (0.97 * dw, 0.31 * Cp))
             .C((0.97 * dw, 0.11 * Cp), (0.78 * dw, yb), (0.50 * dw, yb))
             .C((0.26 * dw, yb), (0.08 * dw, 0.06 * Cp), (0.03 * dw, 0.19 * Cp)))
        # el quiebro del 5 va en dos trazos para que la esquina quede limpia
        pts = s.pts
        k = next(i for i, p in enumerate(pts) if abs(p[0] - 0.18 * dw) < 1 and abs(p[1] - (Cp - h)) < 1)
        k2 = next(i for i, p in enumerate(pts) if abs(p[0] - 0.11 * dw) < 1 and abs(p[1] - 0.53 * Cp) < 1)
        return Glyph([St(pts[:k + 1], 'T', 'J'), St(pts[k:k2 + 1], 'J', 'J'), St(pts[k2:], 'J', 'E')], tab=True)

    def n6(self):
        dw, Cp = self.dw(), self.Cp
        yt = self.tc(Cp)
        H = 0.64 * Cp
        bowl = self.ellipse(dw / 2, H, dw / 2)
        cyb = (self.tc(H) + self.bc) / 2
        s = (Sk((0, cyb)).C((0, 0.78 * Cp), (0.24 * dw, yt), (0.56 * dw, yt))
             .C((0.72 * dw, yt), (0.84 * dw, 0.95 * Cp), (0.90 * dw, 0.87 * Cp)))
        return Glyph([bowl, St(s, 'J', 'K')], tab=True)

    def n9(self):
        dw, Cp = self.dw(), self.Cp
        g = self.n6()
        return g.mapped(lambda p: (dw - p[0], Cp - p[1]))

    def n7(self):
        dw, Cp = self.dw(), self.Cp
        h = self.h
        s = Sk((dw, Cp - h)).C((0.72 * dw, 0.70 * Cp), (0.42 * dw, 0.36 * Cp), (0.34 * dw, 0))
        return Glyph([self.bar(0.02 * dw, dw, Cp - h, 'T', 'T'), St(s, 'A', 'Th')], tab=True)

    def n8(self):
        dw, Cp = self.dw(), self.Cp
        cyt = 0.765 * Cp
        yt = self.tc(Cp)
        ryt = yt - cyt
        top = St(arc(dw / 2, cyt, 0.43 * dw, ryt, 0, 360, self.F.sup), closed=True)
        bot = self.ellipse(dw / 2, 0.55 * Cp, dw / 2)
        return Glyph([top, bot], tab=True)

    # ======================= signos =======================
    def p_period(self):
        r = self.F.pdot
        return Glyph(dots=[(0, r, r)], sb=('p', 'p'))

    def comma_shape(self, y0):
        r = self.F.pdot
        X = self.X
        s = Sk((0.25 * r, y0 + r * 0.2)).C((0.25 * r, y0 - 0.12 * X), (-0.05 * r, y0 - 0.20 * X), (-0.65 * r, y0 - 0.30 * X))
        return Glyph([St(s, 'N', 'T', fixw=2 * r * 0.92, taper=(1.0, 0.42))], dots=[(0, y0 + r * 0.15, r)], sb=('p', 'p'))

    def p_comma(self):
        return self.comma_shape(self.F.pdot)

    def p_colon(self):
        r = self.F.pdot
        return Glyph(dots=[(0, r, r), (0, self.X - r, r)], sb=('p', 'p'))

    def p_semicolon(self):
        r = self.F.pdot
        g = self.comma_shape(r)
        g.dots.append((0, self.X - r, r))
        return g

    def p_exclam(self):
        Cp = self.Cp
        r = self.F.pdot
        return Glyph([St(line((0, Cp), (0, 0.30 * Cp)), 'T', 'T', taper=(1.0, 0.75))], dots=[(0, r, r)], sb=('p', 'p'))

    def p_question(self):
        Cp = self.Cp
        dw = 0.46 * Cp * self.F.W
        yt = self.tc(Cp)
        r = self.F.pdot
        s = (Sk((0.0, 0.76 * Cp)).C((0.06 * dw, 0.93 * Cp), (0.26 * dw, yt), (0.50 * dw, yt))
             .C((0.80 * dw, yt), (dw, 0.90 * Cp), (dw, 0.73 * Cp))
             .C((dw, 0.55 * Cp), (0.48 * dw, 0.50 * Cp), (0.48 * dw, 0.36 * Cp)).L((0.48 * dw, 0.29 * Cp)))
        return Glyph([St(s, 'K', 'T')], dots=[(0.48 * dw, r, r)], sb=('o', 'o'))

    def inv(self, g):
        X = self.X
        return g.mapped(lambda p: (-p[0], X - p[1]))

    def p_quotesingle(self):
        Cp = self.Cp
        return Glyph([St(line((0, Cp), (0, Cp - 0.26 * Cp)), 'T', 'T', taper=(1.0, 0.7))], sb=('p', 'p'))

    def p_quotedbl(self):
        g = self.p_quotesingle()
        k = self.v * 3.0
        return g.add(shift(self.p_quotesingle(), k))

    def p_rquote(self):
        Cp, r = self.Cp, self.F.pdot
        return shift(self.comma_shape(0), 0, Cp - 2 * r + r * 0.1)

    def p_lquote(self):
        g = self.p_rquote()
        Cp = self.Cp
        r = self.F.pdot
        cy = Cp - 0.16 * self.X - r * 0.4
        return g.mapped(lambda p: (-p[0], 2 * cy - p[1]))

    def pair(self, g):
        k = self.F.pdot * 2.9
        return g.add(shift(Glyph(g.strokes[:], [], g.dots[:], polys=g.polys[:]), k)) if False else self._pair(g, k)

    def _pair(self, g, k):
        h = shift(g, k)
        out = Glyph(g.strokes + h.strokes, [], g.dots + h.dots, sb=g.sb)
        return out

    def p_hyphen(self, f=0.40):
        y = self.X * 0.47
        wd = f * self.X * (1 if f > 0.6 else self.F.W)
        return Glyph([self.bar(0, wd, y)], sb=('o', 'o'))

    def p_endash(self):
        y = self.X * 0.47
        return Glyph([self.bar(0, 500 - 2 * self.F.sb * 0.5, y)], sb=('z', 'z'))

    def p_emdash(self):
        y = self.X * 0.47
        return Glyph([self.bar(0, 1000 - 2 * self.F.sb * 0.4, y)], sb=('z', 'z'))

    def p_paren(self, right=False):
        A, D = self.A + 10, self.D + 20
        cy = (A + D) / 2
        ry = (A - D) / 2
        rx = 0.42 * ry * self.F.W
        g = Glyph([St(arc(rx, cy, rx, ry, 112, 248), 'T', 'T')], sb=('o', 'o'))
        if right:
            return g.mapped(lambda p: (rx * 1.1 - p[0], p[1]))
        return g

    def p_bracket(self, right=False):
        A, D = self.A + 10, self.D + 20
        wd = 0.30 * self.X
        h = self.h
        g = Glyph([self.bar(wd, 0, A - h, 'T', 'J'), self.stem(0, A - h, D + h, 'J', 'J'), self.bar(0, wd, D + h, 'J', 'T')], sb=('s', 'o'))
        if right:
            return g.mapped(lambda p: (wd - p[0], p[1]))
        return g

    def p_brace(self, right=False):
        A, D = self.A + 10, self.D + 20
        ym = (A + D) / 2
        wd = 0.36 * self.X
        h = self.h
        k = wd * 0.45
        top = (Sk((wd, A - h)).C((k, A - h), (k, A - 0.12 * (A - D)), (k, ym + 0.22 * (A - D)))
               .C((k, ym + 0.06 * (A - D)), (k * 0.7, ym), (0, ym)))
        bot = (Sk((0, ym)).C((k * 0.7, ym), (k, ym - 0.06 * (A - D)), (k, ym - 0.22 * (A - D)))
               .C((k, D + 0.12 * (A - D)), (k, D + h), (wd, D + h)))
        g = Glyph([St(top, 'T', 'J'), St(bot, 'J', 'T')], sb=('o', 'o'))
        if right:
            return g.mapped(lambda p: (wd - p[0], p[1]))
        return g

    def p_slash(self, back=False):
        A, D = self.A, self.D * 0.55
        wd = 0.42 * (A - D) * 0.6
        if back:
            return Glyph([St(line((0, A), (wd, D)), 'T', 'T')], sb=('d', 'd'))
        return Glyph([St(line((0, D), (wd, A)), 'T', 'T')], sb=('d', 'd'))

    def p_bar(self):
        return Glyph([self.stem(0, self.D, self.A)])

    def p_underscore(self):
        return Glyph([self.bar(0, 0.55 * self.X * 1.0, self.D * 0.42)], sb=('z', 'z'))

    def p_at(self):
        X, Cp = self.X, self.Cp
        r1 = 0.30 * X
        R = 0.50 * (Cp - self.D * 0.6)
        cx, cy = R, 0.43 * Cp
        inner = St(arc(cx, cy, r1, r1 * 1.05, 0, 360), closed=True)
        stx = cx + r1
        st = (Sk((stx, cy + r1 * 1.05)).L((stx, cy - r1 * 0.6))
              .C((stx, cy - r1 * 1.1), (stx + 0.35 * r1, cy - r1 * 1.15), (stx + 0.55 * r1, cy - r1 * 1.15))
              .C((cx + R * 0.9, cy - r1 * 1.15), (cx + R, cy - 0.4 * R), (cx + R, cy))
              .A(cx, cy, R, R, 0, 290))
        return Glyph([inner, St(st, 'T', 'E')], sb=('r', 'r'))

    def p_amp(self):
        Cp = self.Cp
        wd = 0.70 * Cp * self.F.W
        yt, yb = self.tc(Cp), self.bc
        s = (Sk((wd, 0)).L((0.30 * wd, 0.60 * Cp))
             .C((0.14 * wd, 0.72 * Cp), (0.16 * wd, yt), (0.44 * wd, yt))
             .C((0.66 * wd, yt), (0.72 * wd, 0.88 * Cp), (0.72 * wd, 0.80 * Cp))
             .C((0.72 * wd, 0.66 * Cp), (0.56 * wd, 0.60 * Cp), (0.36 * wd, 0.50 * Cp))
             .C((0.12 * wd, 0.38 * Cp), (0.0, 0.30 * Cp), (0.0, 0.20 * Cp))
             .C((0.0, 0.06 * Cp), (0.16 * wd, yb), (0.40 * wd, yb))
             .C((0.68 * wd, yb), (0.86 * wd, 0.18 * Cp), (0.92 * wd, 0.42 * Cp)))
        return Glyph([St(s, 'Th', 'T')], sb=('r', 'd'))

    def p_percent(self):
        Cp = self.Cp
        wd = 0.80 * Cp * self.F.W
        r = 0.17 * wd
        H = 0.36 * Cp
        a = St(arc(r, Cp - H / 2, r, H / 2 - self.h, 0, 360), closed=True)
        b = St(arc(wd - r, H / 2, r, H / 2 - self.h, 0, 360), closed=True)
        return Glyph([a, b, St(line((0.12 * wd, 0), (0.88 * wd, Cp)), 'T', 'T', wmul=0.9)], sb=('r', 'r'))

    def p_euro(self):
        g = self.C_C()
        wd = self.cw(0.78, 'C')
        Cp = self.Cp
        g.strokes += [self.bar(-0.14 * wd, 0.62 * wd, 0.58 * Cp, 'T', 'T'), self.bar(-0.14 * wd, 0.56 * wd, 0.42 * Cp, 'T', 'T')]
        return g

    def p_dollar(self):
        g = self.C_S()
        wd = self.cw(0.60, 'S')
        Cp = self.Cp
        g.strokes.append(St(line((0.5 * wd, Cp + 0.10 * Cp), (0.5 * wd, -0.10 * Cp)), 'T', 'T', wmul=0.85))
        return g

    def p_hash(self):
        Cp = self.Cp
        wd = 0.62 * Cp * self.F.W
        sk = 0.10 * wd
        return Glyph([St(line((0.30 * wd, 0), (0.30 * wd + sk, Cp * 0.92)), 'T', 'T', wmul=0.85),
                      St(line((0.62 * wd, 0), (0.62 * wd + sk, Cp * 0.92)), 'T', 'T', wmul=0.85),
                      self.bar(0, wd, 0.62 * Cp), self.bar(-0.04 * wd, 0.96 * wd, 0.30 * Cp)], sb=('o', 'o'))

    def p_asterisk(self):
        Cp = self.Cp
        L = 0.17 * Cp
        cy = Cp - L * 1.05
        strokes = []
        for k in range(5):
            a = math.radians(90 + 72 * k)
            strokes.append(St(line((0, cy), (math.cos(a) * L, cy + math.sin(a) * L)), 'J', 'T', wmul=0.75))
        return Glyph(strokes, sb=('o', 'o'))

    def math_y(self):
        return self.X * 0.50

    def p_plus(self):
        y = self.math_y()
        k = 0.30 * self.X
        return Glyph([self.bar(-k, k, y), St(line((0, y - k), (0, y + k)), 'T', 'T')], sb=('o', 'o'))

    def p_equal(self):
        y = self.math_y()
        k = 0.30 * self.X
        d = 0.15 * self.X
        return Glyph([self.bar(-k, k, y + d), self.bar(-k, k, y - d)], sb=('o', 'o'))

    def p_less(self, gt=False):
        y = self.math_y()
        k = 0.30 * self.X
        pts = [(k, y + k), (-k, y), (k, y - k)]
        g = Glyph([St(line(pts[0], pts[1]), 'T', 'J'), St(line(pts[1], pts[2]), 'J', 'T')], sb=('o', 'o'))
        if gt:
            return g.mapped(lambda p: (-p[0], p[1]))
        return g

    def p_tilde(self):
        y = self.math_y()
        k = 0.32 * self.X
        s = Sk((-k, y - 0.03 * self.X)).C((-k * 0.6, y + 0.14 * self.X), (-0.2 * k, y + 0.10 * self.X), (0, y)).C((0.2 * k, y - 0.10 * self.X), (0.6 * k, y - 0.14 * self.X), (k, y + 0.03 * self.X))
        return Glyph([St(s, 'T', 'T')], sb=('o', 'o'))

    def p_caret(self):
        Cp = self.Cp
        k = 0.24 * self.X
        return Glyph([St(line((-k, Cp - 0.34 * Cp), (0, Cp)), 'T', 'J'), St(line((0, Cp), (k, Cp - 0.34 * Cp)), 'J', 'T')], sb=('o', 'o'))

    def p_grave(self):
        g = self.mark_acute(1.0)
        return shift(g.mapped(lambda p: (-p[0], p[1])), 0, 0)

    def p_ellipsis(self):
        r = self.F.pdot
        k = r * 3.4
        return Glyph(dots=[(0, r, r), (k, r, r), (2 * k, r, r)], sb=('p', 'p'))

    def p_arrow(self):
        y = self.math_y()
        wd = 0.95 * self.X
        k = 0.24 * self.X
        return Glyph([self.bar(0, wd, y, 'T', 'J'), St(line((wd - k, y + k), (wd, y)), 'T', 'J'), St(line((wd, y), (wd - k, y - k)), 'J', 'T')], sb=('o', 'o'))

    def p_middot(self):
        r = self.F.pdot
        return Glyph(dots=[(0, self.X * 0.5, r)], sb=('p', 'p'))

    def p_guill(self, right=False):
        y = self.X * 0.5
        k = 0.17 * self.X
        def chev(dx):
            return [St(line((dx + k, y + k), (dx, y)), 'T', 'J', wmul=0.9), St(line((dx, y), (dx + k, y - k)), 'J', 'T', wmul=0.9)]
        g = Glyph(chev(0) + chev(k * 1.5), sb=('o', 'o'))
        if right:
            return g.mapped(lambda p: (-p[0], p[1]))
        return g

    def p_degree(self):
        Cp = self.Cp
        r = 0.13 * Cp
        return Glyph([St(arc(r, Cp - r, r, r, 0, 360), closed=True, wmul=0.75)], sb=('o', 'o'))

    def p_times(self):
        y = self.math_y()
        k = 0.22 * self.X
        return Glyph([St(line((-k, y - k), (k, y + k)), 'T', 'T'), St(line((-k, y + k), (k, y - k)), 'T', 'T')], sb=('o', 'o'))

    # ======================= acentos =======================
    def mark_acute(self, sy):
        X = self.X
        return Glyph([St(line((-0.10 * X, 0), (0.10 * X, 0.20 * X * sy)), 'T', 'T', wmul=0.9, taper=(0.75, 1.05))])

    def mark_circ(self, sy):
        X = self.X
        k = 0.17 * X
        return Glyph([St(line((-k, 0), (0, 0.19 * X * sy)), 'T', 'J', wmul=0.85), St(line((0, 0.19 * X * sy), (k, 0)), 'J', 'T', wmul=0.85)])

    def mark_dier(self, sy):
        X = self.X
        r = self.F.dot * 0.95
        return Glyph(dots=[(-0.17 * X, r, r), (0.17 * X, r, r)])

    def mark_tilde(self, sy):
        X = self.X
        k = 0.20 * X
        a = 0.07 * X * sy
        s = Sk((-k, a * 0.2)).C((-k * 0.6, a * 2.2), (-0.25 * k, a * 1.6), (0, a)).C((0.25 * k, a * 0.4), (0.6 * k, -a * 0.2), (k, a * 1.8))
        return Glyph([St(s, 'T', 'T', wmul=0.85)])

    def mark_ring(self, sy):
        X = self.X
        r = 0.11 * X
        return Glyph([St(arc(0, r, r, r, 0, 360), closed=True, wmul=0.75)])

    def mark_cedilla(self):
        X = self.X
        s = Sk((0, 0.02 * X)).L((0, -0.08 * X)).C((0.16 * X, -0.08 * X), (0.18 * X, -0.26 * X), (0.02 * X, -0.28 * X)).L((-0.10 * X, -0.27 * X))
        return Glyph([St(s, 'J', 'T', wmul=0.7)])
