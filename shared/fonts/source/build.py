"""Construye las fuentes prototipo de Lixbon Brand (TTF + WOFF2)."""
import math
import os
import sys
from copy import deepcopy

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from pathops import Path, PathOp, op

from geo import union_all, circle
from glyphs import Lib, Glyph, shift

OUT = os.path.join(os.path.dirname(__file__), 'out')


class Fam:
    def __init__(self, **kw):
        d = dict(xh=520, cap=700, asc=745, desc=-225, W=1.0, wv=80, wh=72, nib=0.0, cp=1.0, ov=11, sup=2.0,
                 geo=False, aj=0.70, am=0.53, bj_hi=0.78, bj_lo=0.20, aper=44, eaper=40, aperC=42, a2=True,
                 g2=False, l_tail=False, y_tail='straight', w_low=False, G_spur=False, a_bar=0.54,
                 caps={}, sb=56, digit_w=1.0, dot=None, pdot=None, ball=40, flare=0.0, flare_len=100,
                 serif=None, mono=False, cell=600, mono_max=440, mono_min=360, wov={}, space=250,
                 jthin=1.0, jlen=90, family='X', style='Regular', weight=400)
        d.update(kw)
        self.__dict__.update(d)
        if self.dot is None:
            self.dot = self.wv * 0.62
        if self.pdot is None:
            self.pdot = self.wv * 0.64

    def width(self, tx, ty):
        th = math.atan2(ty, tx)
        s = abs(math.sin(th - self.nib))
        return self.wh + (self.wv - self.wh) * s ** self.cp

    def capstyle(self, code):
        if code == 'J':
            return 'round'
        if code == 'N':
            return 'butt'
        if code == 'A':
            return 'hcut'
        return self.caps.get(code, 'butt')


TXT = {'T': 'butt', 'Th': 'hcut', 'K': 'butt', 'E': 'butt'}


def sans_a(stem, **kw):
    # Humanista sobria: terminales en ángulo, aberturas generosas, uniones afinadas
    return Fam(xh=518, cap=700, asc=742, desc=-200, W=0.92, wv=stem, wh=stem * 0.80, nib=0.18, cp=1.0, ov=10,
               sup=2.30, rw=0.90, rwC=0.95, aj=0.66, am=0.54, bj_hi=0.78, bj_lo=0.20, aper=40, eaper=36, aperC=40, a2=True,
               y_tail='straight', caps=TXT, jthin=0.52, jlen=92, sb=8 + stem * 0.52, a_bar=0.55,
               dot=stem * 0.64, pdot=stem * 0.68, **kw)


def sans_b(stem, **kw):
    stem += 2
    # Grotesca de producto: ojo alto, curvas tensas, cortes horizontales
    return Fam(xh=536, cap=712, asc=748, desc=-198, W=0.93, wv=stem, wh=stem * 0.82, nib=0.0, ov=10, sup=2.45, rw=0.88, rwC=0.94,
               aj=0.70, am=0.52, bj_hi=0.80, bj_lo=0.18, aper=30, eaper=26, aperC=32, a2=True, G_spur=True,
               caps={'T': 'butt', 'Th': 'hcut', 'K': 'hcut', 'E': 'hcut'}, jthin=0.55, jlen=96,
               sb=8 + stem * 0.52, a_bar=0.54, dot=stem * 0.64, pdot=stem * 0.68, **kw)


def sans_c(stem, **kw):
    # Neogrotesca editorial: estrecha, ascendentes largas, g de dos pisos
    return Fam(xh=500, cap=690, asc=752, desc=-212, W=0.88, wv=stem, wh=stem * 0.78, nib=0.08, ov=10, sup=2.36, rw=0.88, rwC=0.94,
               aj=0.68, am=0.55, bj_hi=0.78, bj_lo=0.20, aper=36, eaper=34, aperC=38, a2=True, g2=True,
               y_tail='curve', caps={'T': 'butt', 'Th': 'hcut', 'K': 'butt', 'E': 'hcut'}, jthin=0.50, jlen=90,
               sb=7 + stem * 0.52, a_bar=0.55, dot=stem * 0.64, pdot=stem * 0.68, **kw)


def mono(base, stem, **kw):
    f = base(stem, mono=True, **kw)
    f.mono_max = 600 - 2 * 50 - stem
    f.mono_min = 600 - 2 * 96 - stem
    f.W = f.W * 1.02
    f.space = 600
    return f


def serif_d(**kw):
    # Transicional de titular: eje vertical, contraste claro, remates con ménsula firme, terminales de gota
    return Fam(xh=482, cap=690, asc=742, desc=-226, W=0.92, wv=94, wh=24, nib=0.0, cp=1.6, ov=11, aj=0.66,
               am=0.55, aper=50, eaper=42, aperC=40, a2=True, g2=True, y_tail='curve', diag_thin=0.50, jthin_s=0.45,
               caps={'T': 'butt', 'Th': 'hcut', 'K': 'ball', 'E': 'butt'}, sb=30, ball=41, dot=50, pdot=52,
               jthin=0.80, jlen=84, serif=dict(ts=26, ls=43, bh=40, bw=40, rnd=False, tv=34, lv=78), space=220,
               wov={'O': 0.90, 'C': 0.80, 'G': 0.84, 'E': 0.56, 'F': 0.54, 'S': 0.56, 'M': 0.94}, **kw)


def serif_e(**kw):
    # Editorial de alto contraste: astas firmes, perfiles muy finos, remates afilados
    return Fam(xh=462, cap=690, asc=744, desc=-228, W=0.90, wv=100, wh=15, nib=0.0, cp=1.9, ov=11, aj=0.64,
               am=0.55, aper=52, eaper=44, aperC=42, a2=True, g2=True, y_tail='curve', diag_thin=0.36, jthin_s=0.35,
               caps={'T': 'butt', 'Th': 'hcut', 'K': 'ball', 'E': 'butt'}, sb=28, ball=44, dot=52, pdot=54,
               jthin=0.72, jlen=90, serif=dict(ts=19, ls=46, bh=28, bw=32, rnd=False, tv=24, lv=84), space=215,
               wov={'O': 0.90, 'C': 0.80, 'G': 0.84, 'E': 0.54, 'F': 0.52, 'S': 0.54, 'M': 0.94}, **kw)


def serif_f(**kw):
    # Glífica sin remates: trazos que se abren al final, como letra grabada
    return Fam(xh=476, cap=692, asc=742, desc=-226, W=0.92, wv=90, wh=34, nib=0.0, cp=1.4, ov=11, aj=0.68,
               am=0.54, aper=44, eaper=40, aperC=42, a2=True, g2=False, y_tail='straight', diag_thin=0.62, jthin_s=0.55,
               caps={'T': 'butt', 'Th': 'hcut', 'K': 'butt', 'E': 'butt'}, flare=0.13, flare_len=120,
               jthin=0.80, jlen=84, sb=32, dot=48, pdot=50, space=225,
               wov={'O': 0.90, 'E': 0.54, 'F': 0.52, 'M': 0.94}, **kw)


def serif_g(**kw):
    # Old-style de titular, en la línea de founder: cálida, contraste alto, gotas marcadas, espaciado justo
    return Fam(xh=492, cap=692, asc=752, desc=-232, W=0.95, wv=102, wh=22, nib=0.0, cp=1.7, ov=12, aj=0.64,
               am=0.55, aper=50, eaper=46, aperC=46, a2=True, g2=True, y_tail='curve', diag_thin=0.34,
               jthin_s=0.36, rw=0.97, rwC=0.97, sup=2.0, a_bar=0.52,
               caps={'T': 'butt', 'Th': 'hcut', 'K': 'ball', 'E': 'butt'}, sb=27, ball=46, dot=54, pdot=56,
               jthin=0.66, jlen=96, serif=dict(ts=24, ls=48, bh=44, bw=42, rnd=False, tv=28, lv=86, slant=16), space=210,
               wov={'O': 0.90, 'C': 0.80, 'G': 0.84, 'E': 0.56, 'F': 0.54, 'S': 0.56, 'M': 0.94}, **kw)


# ---------------------------------------------------------------- serifas
def capsule(x0, x1, yc, r):
    if x1 - x0 < 2 * r:
        x1 = x0 + 2 * r
    pts = []
    n = 12
    for i in range(n + 1):
        a = math.pi / 2 + math.pi * i / n
        pts.append((x0 + r + math.cos(a) * r, yc + math.sin(a) * r))
    for i in range(n + 1):
        a = -math.pi / 2 + math.pi * i / n
        pts.append((x1 - r + math.cos(a) * r, yc + math.sin(a) * r))
    return pts


def vcapsule(xc, y0, y1, r):
    return [(yx[1], yx[0]) for yx in capsule(y0, y1, xc, r)][::-1]


def bracket(xs, ys, dx, dy):
    """Ménsula cóncava entre el asta (x=xs) y la serifa (y=ys)."""
    pts = [(xs, ys + dy)]
    for i in range(1, 12):
        t = i / 12
        # cuadrática con control en la esquina (xs, ys)
        x = (1 - t) ** 2 * xs + 2 * (1 - t) * t * xs + t * t * (xs + dx)
        y = (1 - t) ** 2 * (ys + dy) + 2 * (1 - t) * t * ys + t * t * ys
        pts.append((x, y))
    pts.append((xs + dx, ys))
    pts.append((xs, ys))
    return pts


def serif_polys(F, serifs):
    S = F.serif
    out = []
    for (x, y, kind) in serifs:
        diag = kind.endswith('s')
        k = kind.rstrip('s')
        sw = F.wv / 2 * (1.0 if not diag else 0.95)
        L = S['ls'] * (1.0 if not diag else 0.9)
        ts = S['ts']
        if k[0] in 'bt':
            side = k[1]
            xl = x - sw - (L if side in '2L' else 0)
            xr = x + sw + (L if side in '2R' else 0)
            if k[0] == 'b':
                y0, y1 = y, y + ts
                ys, sgn = y1, 1
            else:
                y0, y1 = y - ts, y
                ys, sgn = y0, -1
            if S['rnd']:
                out.append(capsule(xl, xr, (y0 + y1) / 2, ts / 2))
            elif k == 'tL' and S.get('slant'):
                # remate de cabeza inclinado (old-style): sube hacia el asta
                s = S['slant']
                out.append([(xl, y0), (x + sw, y0), (x + sw, y1 + s), (xl, y1 - ts * 0.15)])
            else:
                out.append([(xl, y0), (xr, y0), (xr, y1), (xl, y1)])
            if side in '2L':
                out.append(bracket(x - sw, ys, -S['bw'], sgn * S['bh']))
            if side in '2R':
                out.append(bracket(x + sw, ys, S['bw'], sgn * S['bh']))
        elif k[0] == 'v':
            tv, lv = S['tv'], S['lv']
            if k == 'vDL':
                x0, x1 = x, x + tv
            else:
                x0, x1 = x - tv, x
            if k.startswith('vD'):
                y0, y1 = y - lv, y
            elif k == 'vU':
                y0, y1 = y, y + lv
            else:
                y0, y1 = y - lv * 0.45, y + lv * 0.45
            if S['rnd']:
                out.append(vcapsule((x0 + x1) / 2, y0, y1, tv / 2))
            else:
                out.append([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])
    return out


# ---------------------------------------------------------------- mapa
def charmap(L):
    m = {}
    for c in 'abcdefghijklmnopqrstuvwxyz':
        m[c] = getattr(L, 'g_' + c)
    for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ':
        m[c] = getattr(L, 'C_' + c)
    for i, c in enumerate('0123456789'):
        m[c] = getattr(L, 'n' + c)
    m.update({
        '.': L.p_period, ',': L.p_comma, ':': L.p_colon, ';': L.p_semicolon, '!': L.p_exclam,
        '?': L.p_question, '¡': lambda: L.inv(L.p_exclam()), '¿': lambda: L.inv(L.p_question()),
        "'": L.p_quotesingle, '"': L.p_quotedbl, '’': L.p_rquote, '‘': L.p_lquote,
        '”': lambda: L._pair(L.p_rquote(), L.F.pdot * 2.6), '“': lambda: L._pair(L.p_lquote(), L.F.pdot * 2.6),
        '-': L.p_hyphen, '–': L.p_endash, '—': L.p_emdash, '(': L.p_paren, ')': lambda: L.p_paren(True),
        '[': L.p_bracket, ']': lambda: L.p_bracket(True), '{': L.p_brace, '}': lambda: L.p_brace(True),
        '/': L.p_slash, '\\': lambda: L.p_slash(True), '|': L.p_bar, '_': L.p_underscore, '@': L.p_at,
        '&': L.p_amp, '%': L.p_percent, '€': L.p_euro, '$': L.p_dollar, '#': L.p_hash, '*': L.p_asterisk,
        '+': L.p_plus, '=': L.p_equal, '<': L.p_less, '>': lambda: L.p_less(True), '~': L.p_tilde,
        '^': L.p_caret, '`': L.p_grave, '…': L.p_ellipsis, '→': L.p_arrow, '·': L.p_middot,
        '«': L.p_guill, '»': lambda: L.p_guill(True), '°': L.p_degree, '×': L.p_times, 'ı': L.g_dotlessi,
    })
    return m


ACC = {'́': 'acute', '̀': 'grave', '̂': 'circ', '̈': 'dier', '̃': 'tilde', '̊': 'ring'}
COMPOSED = {}
for base in 'aeiouAEIOU':
    for mk in ('́', '̀', '̂', '̈'):
        COMPOSED[__import__('unicodedata').normalize('NFC', base + mk)] = (base, mk)
for base in 'anoANO':
    COMPOSED[__import__('unicodedata').normalize('NFC', base + '̃')] = (base, '̃')
COMPOSED['å'] = ('a', '̊')
COMPOSED['Å'] = ('A', '̊')
for base in 'yY':
    for mk in ('́', '̈'):
        COMPOSED[__import__('unicodedata').normalize('NFC', base + mk)] = (base, mk)


def glyph_path(F, g):
    extra = [circle(cx, cy, r) for (cx, cy, r) in g.dots]
    if F.serif:
        extra += serif_polys(F, g.serifs)
    extra += g.polys
    return union_all(F, g.strokes, extra)


def mark_glyph(L, kind, caps):
    sy = 0.78 if caps else 1.0
    if kind == 'acute':
        return L.mark_acute(sy)
    if kind == 'grave':
        return L.mark_acute(sy).mapped(lambda p: (-p[0], p[1]))
    if kind == 'circ':
        return L.mark_circ(sy)
    if kind == 'dier':
        return L.mark_dier(sy)
    if kind == 'tilde':
        return L.mark_tilde(sy)
    if kind == 'ring':
        return L.mark_ring(sy)


SBK = {'s': 1.0, 'r': 0.72, 'o': 0.62, 'd': 0.22, 'p': 0.9, 'z': -0.45}


def build_font(F, path_ttf):
    L = Lib(F)
    cm = charmap(L)
    paths = {}
    meta = {}
    for ch, fn in cm.items():
        g = fn()
        paths[ch] = glyph_path(F, g)
        meta[ch] = g
    # compuestos
    for ch, (base, mk) in COMPOSED.items():
        caps = base.isupper()
        bch = 'ı' if base == 'i' else base
        bp = paths[bch]
        x0, y0, x1, y1 = paths[base].bounds if base != 'i' else bp.bounds
        cx = (x0 + x1) / 2
        kind = ACC[mk]
        m = mark_glyph(L, kind, caps)
        if caps:
            dy = F.cap + 0.085 * F.cap
        else:
            dy = F.xh + 0.13 * F.xh
        if kind == 'dier':
            dy = (F.cap + 0.10 * F.cap) if caps else (L.idot() - F.dot * 0.95)
        if kind == 'ring' and caps:
            dy = F.cap + 0.05 * F.cap
        mp = glyph_path(F, shift(m, cx, dy))
        paths[ch] = op(bp, mp, PathOp.UNION, fix_winding=True)
        meta[ch] = meta[bch]
    for ch, base in (('ç', 'c'), ('Ç', 'C')):
        bp = paths[base]
        x0, y0, x1, y1 = bp.bounds
        mp = glyph_path(F, shift(L.mark_cedilla(), (x0 + x1) / 2 + (8 if base == 'c' else 10), 0))
        paths[ch] = op(bp, mp, PathOp.UNION, fix_winding=True)
        meta[ch] = meta[base]

    # métricas
    digit_w = max(paths[d].bounds[2] - paths[d].bounds[0] for d in '0123456789')
    dig_adv = digit_w + 2 * F.sb * 0.78
    order = ['.notdef', 'space', 'uni00A0']
    cmap = {32: 'space', 0xA0: 'uni00A0'}
    glyf = {}
    hmtx = {}

    def put(name, p, adv, dx):
        pen = TTGlyphPen(None)
        tp = TransformPen(pen, (1, 0, 0, 1, dx, 0))
        p.draw(tp)
        glyf[name] = pen.glyph()
        b = p.bounds
        hmtx[name] = (int(round(adv)), int(round(b[0] + dx)))

    empty = TTGlyphPen(None).glyph()
    glyf['.notdef'] = empty
    hmtx['.notdef'] = (500, 0)
    sp = F.space if not F.mono else F.cell
    for nm in ('space', 'uni00A0'):
        glyf[nm] = TTGlyphPen(None).glyph()
        hmtx[nm] = (int(sp), 0)
    for ch, p in paths.items():
        name = 'uni%04X' % ord(ch)
        order.append(name)
        cmap[ord(ch)] = name
        x0, y0, x1, y1 = p.bounds
        g = meta[ch]
        if F.mono:
            adv = F.cell
            dx = (adv - (x1 - x0)) / 2 - x0
        elif g.tab:
            adv = dig_adv
            dx = (adv - (x1 - x0)) / 2 - x0
        elif ch == 'j':
            # el gancho cuelga bajo la letra anterior: el espaciado lo marca el asta
            dx = F.sb + F.wv / 2 + 0.35 * max(0, -x0 - F.wv / 2)
            adv = dx + x1 + F.sb
        else:
            sl = F.sb * SBK[g.sb[0]]
            sr = F.sb * SBK[g.sb[1]]
            adv = (x1 - x0) + sl + sr
            dx = sl - x0
        put(name, p, adv, dx)

    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyf)
    fb.setupHorizontalMetrics(hmtx)
    asc, desc = 940, -250
    fb.setupHorizontalHeader(ascent=asc, descent=desc, lineGap=0)
    ps = (F.family + '-' + F.style).replace(' ', '')
    ribbi = F.style in ('Regular', 'Bold')
    names = {
        'copyright': 'Copyright (c) 2026 Lixbon. Todos los derechos reservados.',
        'familyName': F.family if ribbi else F.family + ' ' + F.style,
        'styleName': F.style if ribbi else 'Regular',
        'uniqueFontIdentifier': '%s;%s;LXBN' % (VERSION, ps),
        'fullName': F.family + ' ' + F.style,
        'version': 'Version ' + VERSION,
        'psName': ps,
        'manufacturer': 'Lixbon',
        'licenseDescription': 'Fuente propiedad de Lixbon. Uso permitido solo en productos y materiales de Lixbon.',
    }
    if not ribbi:
        names['typographicFamily'] = F.family
        names['typographicSubfamily'] = F.style
    fb.setupNameTable(names)
    sel = 0x80 | (0x20 if F.style == 'Bold' else 0x40 if F.style == 'Regular' else 0)
    fb.setupOS2(version=4, sTypoAscender=asc, sTypoDescender=desc, sTypoLineGap=0, usWinAscent=asc, usWinDescent=-desc,
                sxHeight=int(F.xh), sCapHeight=int(F.cap), usWeightClass=F.weight, achVendID='LXBN',
                fsSelection=sel, ulUnicodeRange1=0b11, ulCodePageRange1=0b1)
    fb.setupPost(underlinePosition=-120, underlineThickness=int(F.wh * 0.75))
    if F.style == 'Bold':
        fb.font['head'].macStyle = 1
    fb.font['head'].fontRevision = float(VERSION.rsplit('.', 1)[0])
    if not F.mono:
        add_kerning(fb.font, F)
    fb.save(path_ttf)
    f = TTFont(path_ttf)
    f.flavor = 'woff2'
    f.save(path_ttf.replace('.ttf', '.woff2'))
    return path_ttf


VERSION = '0.1.0'

# Kerning de clases para las parejas que el espaciado por lados no resuelve.
KERN_CLASSES = {
    'LC_round': 'a c d e g o q s á à â ä ã å é è ê ë ó ò ô ö õ ç',
    'LC_x': 'm n p r u v w x y z ú ù û ü ñ',
    'UC_T': 'T', 'UC_V': 'V W', 'UC_Y': 'Y', 'UC_A': 'A Á À Â Ä Ã Å', 'UC_L': 'L', 'UC_PF': 'P F',
    'UC_O': 'O Q C G D Ó Ò Ô Ö Õ', 'LC_vwy': 'v w y', 'LC_r': 'r', 'LC_f': 'f',
    'PUNCT': '. , …', 'QUOTE': '’ ‘ ” “ \' "',
}
KERN_PAIRS = [  # (izquierda, derecha, valor en unidades de 1000 a peso Regular)
    ('UC_T', 'LC_round', -80), ('UC_T', 'LC_x', -60), ('UC_T', 'UC_A', -55), ('UC_T', 'PUNCT', -80),
    ('UC_V', 'LC_round', -50), ('UC_V', 'UC_A', -45), ('UC_V', 'PUNCT', -70),
    ('UC_Y', 'LC_round', -75), ('UC_Y', 'UC_A', -55), ('UC_Y', 'PUNCT', -80),
    ('UC_A', 'UC_T', -55), ('UC_A', 'UC_V', -45), ('UC_A', 'UC_Y', -55), ('UC_A', 'QUOTE', -60),
    ('UC_L', 'UC_T', -80), ('UC_L', 'UC_V', -70), ('UC_L', 'UC_Y', -80), ('UC_L', 'QUOTE', -90),
    ('UC_PF', 'PUNCT', -90), ('UC_PF', 'UC_A', -40), ('UC_O', 'PUNCT', -20),
    ('LC_vwy', 'PUNCT', -50), ('LC_r', 'PUNCT', -55), ('LC_f', 'PUNCT', -30), ('LC_f', 'QUOTE', 40),
    ('QUOTE', 'UC_A', -60), ('QUOTE', 'LC_round', -30),
]


def add_kerning(font, F):
    from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
    cmap = font.getBestCmap()
    k = F.wv / 81  # escala con el peso
    cls = []
    for name, chars in KERN_CLASSES.items():
        gl = [cmap[ord(c)] for c in chars.split() if ord(c) in cmap]
        cls.append('@%s = [%s];' % (name, ' '.join(gl)))
    rules = ['pos @%s @%s %d;' % (a, b, round(v * min(k, 1.15))) for a, b, v in KERN_PAIRS]
    fea = '\n'.join(cls) + '\nfeature kern {\n' + '\n'.join(rules) + '\n} kern;\n'
    addOpenTypeFeaturesFromString(font, fea)


def families():
    fams = []
    for key, base, name in (('a', sans_a, 'Lixbon Brand Sans A'), ('b', sans_b, 'Lixbon Brand Sans B'),
                            ('c', sans_c, 'Lixbon Brand Sans C')):
        for wt, style, stem in ((400, 'Regular', 81), (500, 'Medium', 93), (600, 'SemiBold', 106)):
            fams.append(('sans-%s-%d' % (key, wt), base(stem, family=name, style=style, weight=wt)))
        fams.append(('mono-%s' % key, mono(base, 76, family=name.replace('Sans', 'Mono'), style='Regular', weight=400)))
    fams.append(('serif-a', serif_g(family='Lixbon Brand Serif A')))
    fams.append(('serif-b', serif_e(family='Lixbon Brand Serif B')))
    fams.append(('serif-c', serif_f(family='Lixbon Brand Serif C')))
    return fams


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    only = sys.argv[1:]
    for key, F in families():
        if only and not any(key.startswith(o) for o in only):
            continue
        build_font(F, os.path.join(OUT, key + '.ttf'))
        print('ok', key)
