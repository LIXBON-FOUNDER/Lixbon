"""Geometría: esqueletos de trazo -> contornos rellenos (pathops)."""
import math
from pathops import Path, PathOp, op

STEP = 7.0


def lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def line(p0, p1):
    d = math.dist(p0, p1)
    n = max(2, int(d / STEP) + 1)
    return [lerp(p0, p1, i / (n - 1)) for i in range(n)]


def cubic(p0, p1, p2, p3):
    L = math.dist(p0, p1) + math.dist(p1, p2) + math.dist(p2, p3)
    n = max(4, int(L / STEP) + 1)
    out = []
    for i in range(n):
        t = i / (n - 1)
        m = 1 - t
        out.append((m ** 3 * p0[0] + 3 * m * m * t * p1[0] + 3 * m * t * t * p2[0] + t ** 3 * p3[0],
                    m ** 3 * p0[1] + 3 * m * m * t * p1[1] + 3 * m * t * t * p2[1] + t ** 3 * p3[1]))
    return out


def arc(cx, cy, rx, ry, a0, a1, sup=2.0):
    L = abs(a1 - a0) / 360 * 2 * math.pi * max(rx, ry)
    n = max(8, int(L / STEP) + 1)
    e = 2.0 / sup
    out = []
    for i in range(n):
        a = math.radians(a0 + (a1 - a0) * i / (n - 1))
        c, s = math.cos(a), math.sin(a)
        out.append((cx + rx * math.copysign(abs(c) ** e, c), cy + ry * math.copysign(abs(s) ** e, s)))
    return out


class Sk:
    """Constructor encadenado de esqueletos."""

    def __init__(self, p):
        self.pts = [tuple(p)]

    @property
    def cur(self):
        return self.pts[-1]

    def L(self, p):
        self.pts += line(self.cur, p)[1:]
        return self

    def C(self, c1, c2, p):
        self.pts += cubic(self.cur, c1, c2, p)[1:]
        return self

    def A(self, cx, cy, rx, ry, a0, a1, sup=2.0):
        pts = arc(cx, cy, rx, ry, a0, a1, sup)
        self.pts += pts[1:] if math.dist(pts[0], self.cur) < 1.5 else pts
        return self


class St:
    """Un trazo. c0/c1: código de terminal (T, Th, K, E, J, N)."""

    def __init__(self, pts, c0='J', c1='J', closed=False, wmul=1.0, taper=None, fixw=None):
        if isinstance(pts, Sk):
            pts = pts.pts
        self.pts = list(pts)
        self.c0, self.c1 = c0, c1
        self.closed = closed
        self.wmul = wmul
        self.taper = taper
        self.fixw = fixw

    def mapped(self, fn):
        s = St([fn(p) for p in self.pts], self.c0, self.c1, self.closed, self.wmul, self.taper, self.fixw)
        return s


def dedupe(pts, closed=False):
    out = [pts[0]]
    for p in pts[1:]:
        if math.dist(p, out[-1]) > 0.4:
            out.append(p)
    if closed and len(out) > 2 and math.dist(out[0], out[-1]) < 0.4:
        out.pop()
    return out


def area(poly):
    a = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        a += x0 * y1 - x1 * y0
    return a / 2


def orient(poly, positive=True):
    if (area(poly) > 0) != positive:
        poly = poly[::-1]
    return poly


def circle(cx, cy, r, n=None):
    n = n or max(24, int(2 * math.pi * r / STEP))
    return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]


def trim(pts, d, at_end):
    """Recorta d unidades de longitud por un extremo."""
    if d <= 0:
        return pts
    seq = pts[::-1] if at_end else pts[:]
    acc = 0.0
    for i in range(1, len(seq)):
        seg = math.dist(seq[i - 1], seq[i])
        if acc + seg >= d:
            t = (d - acc) / seg
            p = lerp(seq[i - 1], seq[i], t)
            res = [p] + seq[i:]
            return res[::-1] if at_end else res
        acc += seg
    return pts


def halfplane(P, nrm, B=6000, D=None):
    """Rectángulo que cubre {q : (q-P)·nrm > 0}, limitado a ±B a los lados y D de fondo."""
    ux, uy = -nrm[1], nrm[0]
    D = D or B
    return [(P[0] + ux * B, P[1] + uy * B), (P[0] + ux * B + nrm[0] * D, P[1] + uy * B + nrm[1] * D),
            (P[0] - ux * B + nrm[0] * D, P[1] - uy * B + nrm[1] * D), (P[0] - ux * B, P[1] - uy * B)]


def to_path(polys):
    p = Path()
    for poly in polys:
        if len(poly) < 3:
            continue
        p.moveTo(*poly[0])
        for q in poly[1:]:
            p.lineTo(*q)
        p.close()
    return p


def stroke_polys(F, st):
    """Devuelve (polígonos positivos, polígonos negativos/agujeros, cortes) de un trazo."""
    pts = dedupe(st.pts, st.closed)
    n = len(pts)
    if n < 2:
        return [], [], []

    def tangent_raw(i):
        if st.closed:
            a, b = pts[(i - 1) % n], pts[(i + 1) % n]
        else:
            a, b = pts[max(i - 1, 0)], pts[min(i + 1, n - 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy) or 1.0
        return dx / L, dy / L

    caps = [F.capstyle(st.c0), F.capstyle(st.c1)]
    # Recorte para terminales redondos, para que el trazo no crezca.
    if not st.closed:
        w0 = F.width(*tangent_raw(0)) * st.wmul if st.fixw is None else st.fixw
        w1 = F.width(*tangent_raw(n - 1)) * st.wmul if st.fixw is None else st.fixw
        if caps[0] == 'round' and st.c0 != 'J':
            pts = trim(pts, w0 / 2, False)
        if caps[1] == 'round' and st.c1 != 'J':
            pts = trim(pts, w1 / 2, True)
        # Prolongar los cortes horizontales para que el corte cruce todo el ancho.
        cutP = {0: pts[0], 1: pts[-1]}
        if caps[0] == 'hcut':
            t = tangent_raw(0)
            pts = [(pts[0][0] - t[0] * w0 * 1.0, pts[0][1] - t[1] * w0 * 1.0)] + pts
        if caps[1] == 'hcut':
            t = tangent_raw(n - 1)
            pts = pts + [(pts[-1][0] + t[0] * w1 * 1.0, pts[-1][1] + t[1] * w1 * 1.0)]
        pts = dedupe(pts)
        n = len(pts)

    tans = [tangent_raw(i) for i in range(n)]
    # Longitud acumulada para remates abocinados y afinados.
    cum = [0.0]
    for i in range(1, n):
        cum.append(cum[-1] + math.dist(pts[i - 1], pts[i]))
    total = cum[-1] or 1.0
    # Las curvas que entran en un asta (unión J) se afinan al llegar, como en
    # una fuente de texto. Los trazos rectos (barras, diagonales) no.
    def local_turn(end):
        # giro acumulado en los primeros 1.5·jlen desde ese extremo
        idx = range(1, n) if end == 0 else range(n - 1, 0, -1)
        t = 0.0
        for i in idx:
            d0 = cum[i] if end == 0 else total - cum[i]
            if d0 > F.jlen * 1.5:
                break
            a0 = math.atan2(tans[i - 1][1], tans[i - 1][0])
            a1 = math.atan2(tans[i][1], tans[i][0])
            t += abs((a1 - a0 + math.pi) % (2 * math.pi) - math.pi)
        return t

    jthin = getattr(F, 'jthin', 1.0)
    thin_ends = []
    jthin_s = getattr(F, 'jthin_s', 1.0)
    if not st.closed and st.fixw is None:
        for end, code in ((0, st.c0), (1, st.c1)):
            if code != 'J':
                continue
            if local_turn(end) > math.radians(20):
                if jthin < 1.0:
                    thin_ends.append((end, jthin))
            elif jthin_s < 1.0:
                thin_ends.append((end, jthin_s))
    widths = []
    for i in range(n):
        w = (F.width(*tans[i]) if st.fixw is None else st.fixw) * st.wmul
        for end, jt in thin_ends:
            d = cum[i] if end == 0 else total - cum[i]
            if d < F.jlen:
                k = 1 - d / F.jlen
                w *= 1 - (1 - jt) * (k * k * (3 - 2 * k))
        if not st.closed and F.flare:
            Lf = F.flare_len
            for end, code in ((0, st.c0), (1, st.c1)):
                if code in ('T', 'Th', 'K', 'E'):
                    d = cum[i] if end == 0 else total - cum[i]
                    if d < Lf:
                        k = 1 - d / Lf
                        w *= 1 + F.flare * k * k
        if st.taper:
            a, b = st.taper
            w *= a + (b - a) * (cum[i] / total)
        widths.append(w)

    left = [(p[0] - t[1] * w / 2, p[1] + t[0] * w / 2) for p, t, w in zip(pts, tans, widths)]
    right = [(p[0] + t[1] * w / 2, p[1] - t[0] * w / 2) for p, t, w in zip(pts, tans, widths)]

    if st.closed:
        a = orient(left, True)
        b = orient(right, True)
        outer, inner = (a, b) if abs(area(a)) > abs(area(b)) else (b, a)
        return [outer], [inner[::-1]], []

    def capfan(p, t, w, start):
        # semicírculo en sentido horario desde la izquierda hasta la derecha (fin)
        nx, ny = -t[1], t[0]
        base = math.atan2(ny, nx)
        if start:
            base += math.pi
        k = max(8, int(math.pi * w / 2 / STEP))
        return [(p[0] + math.cos(base - math.pi * j / k) * w / 2, p[1] + math.sin(base - math.pi * j / k) * w / 2)
                for j in range(1, k)]

    poly = list(left)
    if caps[1] in ('round',):
        poly += capfan(pts[-1], tans[-1], widths[-1], False)
    poly += right[::-1]
    if caps[0] in ('round',):
        poly += capfan(pts[0], tans[0], widths[0], True)
    polys = [orient(poly, True)]
    cuts = []
    for end, cap in ((0, caps[0]), (1, caps[1])):
        idx = 0 if end == 0 else n - 1
        t = tans[idx]
        tout = (-t[0], -t[1]) if end == 0 else t
        if cap == 'ball':
            rb = F.ball
            P = pts[idx]
            c = (P[0] - tout[0] * rb * 0.35, P[1] - tout[1] * rb * 0.35)
            polys.append(orient(circle(c[0], c[1], rb), True))
        if cap == 'hcut':
            # el punto real de corte es el extremo original (antes de prolongar)
            P = cutP[end]
            if abs(tout[1]) > 0.35:
                nrm = (0.0, math.copysign(1.0, tout[1]))
            else:
                nrm = tout
            w = widths[idx]
            # El corte solo actúa junto al terminal: la prolongación sobresale
            # como mucho 1.5w, así que basta una caja de ese tamaño.
            cuts.append((P, nrm, w))
    return polys, [], cuts


def union_all(F, strokes, extra_polys=()):
    """Une todos los trazos de un glifo en un único Path."""
    result = Path()
    for st in strokes:
        pos, neg, cuts = stroke_polys(F, st)
        p = to_path(pos + neg)
        p.simplify(fix_winding=True)
        for (P, nrm, w) in cuts:
            hp = to_path([orient(halfplane(P, nrm), True)])
            disc = to_path([orient(circle(P[0], P[1], w * 1.25), True)])
            region = op(hp, disc, PathOp.INTERSECTION, fix_winding=True)
            p = op(p, region, PathOp.DIFFERENCE, fix_winding=True)
        result = op(result, p, PathOp.UNION, fix_winding=True)
    if extra_polys:
        e = to_path([orient(x, True) for x in extra_polys])
        e.simplify(fix_winding=True)
        result = op(result, e, PathOp.UNION, fix_winding=True)
    return result
