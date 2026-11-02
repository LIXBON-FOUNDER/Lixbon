"""Genera el paquete Lixbon Brand: Sans (propia) y Serif (derivada de Fraunces, OFL 1.1).

Uso:  python package.py            -> fonts/, css/ y dist/lixbon-brand-fonts-<versión>.zip
Requisitos: requirements.txt (fonttools, skia-pathops, brotli).
"""
import os
import shutil
import sys
import zipfile

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from build import VERSION, build_font, sans_a  # noqa: E402

SANS_WEIGHTS = [(300, 'Light', 66), (400, 'Regular', 81), (500, 'Medium', 93), (600, 'SemiBold', 106),
                (700, 'Bold', 120)]
SERIF_WEIGHTS = [(300, 'Light'), (400, 'Regular'), (500, 'Medium'), (600, 'SemiBold'), (700, 'Bold')]
SERIF_SRC = os.path.join(HERE, 'vendor', 'fraunces-latin.woff2')
SERIF_OPSZ = 72  # tamaño óptico de titular, como en founder.lixbon.com
FRAUNCES_CR = 'Copyright 2020 The Fraunces Project Authors (https://github.com/undercasetype/Fraunces).'


def sans():
    out = os.path.join(ROOT, 'fonts', 'sans')
    os.makedirs(out, exist_ok=True)
    for wt, style, stem in SANS_WEIGHTS:
        F = sans_a(stem, family='Lixbon Brand Sans', style=style, weight=wt)
        p = os.path.join(out, 'LixbonBrandSans-%s.ttf' % style)
        build_font(F, p)
        print('sans', style)


def _serif_names(font, family, style, variable=False):
    name = font['name']
    for rec in list(name.names):
        if rec.nameID in (0, 1, 2, 3, 4, 5, 6, 13, 14, 16, 17, 25) or rec.nameID >= 256:
            name.removeNames(nameID=rec.nameID)
    ribbi = style in ('Regular', 'Bold')
    ps = family.replace(' ', '') + '-' + style.replace(' ', '')
    rows = {
        0: FRAUNCES_CR + ' Modified by Lixbon (2026): fixed optical size, renamed.',
        1: family if ribbi else family + ' ' + style,
        2: style if ribbi else 'Regular',
        3: '%s;%s;LXBN' % (VERSION, ps),
        4: family + ' ' + style,
        5: 'Version ' + VERSION,
        6: ps,
        8: 'Lixbon',
        13: 'This Font Software is licensed under the SIL Open Font License, Version 1.1. '
            'This license is available with a FAQ at: https://openfontlicense.org',
        14: 'https://openfontlicense.org',
    }
    if not ribbi:
        rows[16], rows[17] = family, style
    if variable:
        rows[25] = family.replace(' ', '')
    for nid, val in rows.items():
        name.setName(val, nid, 3, 1, 0x409)
        name.setName(val, nid, 1, 0, 0)


def serif():
    out = os.path.join(ROOT, 'fonts', 'serif')
    os.makedirs(out, exist_ok=True)
    fam = 'Lixbon Brand Serif'
    for wt, style in SERIF_WEIGHTS:
        f = TTFont(SERIF_SRC)
        f.flavor = None
        st = instancer.instantiateVariableFont(f, {'opsz': SERIF_OPSZ, 'wght': wt}, updateFontNames=False)
        if 'STAT' in st:
            del st['STAT']
        _serif_names(st, fam, style)
        os2 = st['OS/2']
        os2.achVendID = 'LXBN'
        os2.usWeightClass = wt
        os2.fsSelection = (os2.fsSelection & ~0x61) | (0x20 if style == 'Bold' else 0x40 if style == 'Regular' else 0)
        st['head'].macStyle = 1 if style == 'Bold' else 0
        p = os.path.join(out, 'LixbonBrandSerif-%s.ttf' % style)
        st.save(p)
        st.flavor = 'woff2'
        st.save(p.replace('.ttf', '.woff2'))
        print('serif', style)
    # variable en peso (300–700), tamaño óptico fijo
    f = TTFont(SERIF_SRC)
    f.flavor = None
    vf = instancer.instantiateVariableFont(f, {'opsz': SERIF_OPSZ, 'wght': (300, 400, 700)}, updateFontNames=False)
    if 'STAT' in vf:
        del vf['STAT']
    _serif_names(vf, fam, 'Regular', variable=True)
    vf['fvar'].instances = []  # sin instancias con nombre: los pesos estáticos ya van aparte
    vf['OS/2'].achVendID = 'LXBN'
    vf['OS/2'].usWeightClass = 400
    p = os.path.join(out, 'LixbonBrandSerif[wght].ttf')
    vf.save(p)
    vf.flavor = 'woff2'
    vf.save(p.replace('.ttf', '.woff2'))
    print('serif variable')


def css():
    out = os.path.join(ROOT, 'css')
    os.makedirs(out, exist_ok=True)

    def face(fam, file, wt):
        return ("@font-face {\n  font-family: '%s';\n  font-style: normal;\n  font-weight: %s;\n  font-display: swap;\n"
                "  src: url('../fonts/%s.woff2') format('woff2'),\n       url('../fonts/%s.ttf') format('truetype');\n}\n"
                % (fam, wt, file, file))

    s = ''.join(face('Lixbon Brand Sans', 'sans/LixbonBrandSans-' + st, wt) for wt, st, _ in SANS_WEIGHTS)
    r = ''.join(face('Lixbon Brand Serif', 'serif/LixbonBrandSerif-' + st, wt) for wt, st in SERIF_WEIGHTS)
    v = ("@font-face {\n  font-family: 'Lixbon Brand Serif';\n  font-style: normal;\n  font-weight: 300 700;\n"
         "  font-display: swap;\n  src: url('../fonts/serif/LixbonBrandSerif[wght].woff2') format('woff2-variations'),\n"
         "       url('../fonts/serif/LixbonBrandSerif[wght].woff2') format('woff2');\n}\n")
    tokens = (":root {\n  --lixbon-font-sans: 'Lixbon Brand Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;\n"
              "  --lixbon-font-serif: 'Lixbon Brand Serif', 'Iowan Old Style', Georgia, serif;\n}\n")
    head = '/* Lixbon Brand %s. Generado por source/package.py: no editar a mano. */\n'
    open(os.path.join(out, 'sans.css'), 'w', encoding='utf-8').write(head % 'Sans' + s)
    open(os.path.join(out, 'serif.css'), 'w', encoding='utf-8').write(head % 'Serif (estáticas)' + r)
    open(os.path.join(out, 'serif-variable.css'), 'w', encoding='utf-8').write(head % 'Serif (variable)' + v)
    open(os.path.join(out, 'tokens.css'), 'w', encoding='utf-8').write(head % 'tokens' + tokens)
    open(os.path.join(out, 'lixbon-brand.css'), 'w', encoding='utf-8').write(
        head % 'completo' + "@import './sans.css';\n@import './serif.css';\n@import './tokens.css';\n")


def zip_dist():
    dist = os.path.join(ROOT, 'dist')
    os.makedirs(dist, exist_ok=True)
    z = os.path.join(dist, 'lixbon-brand-fonts-%s.zip' % VERSION)
    with zipfile.ZipFile(z, 'w', zipfile.ZIP_DEFLATED) as zf:
        for sub in ('fonts', 'css'):
            for dp, _, files in os.walk(os.path.join(ROOT, sub)):
                for fn in files:
                    full = os.path.join(dp, fn)
                    zf.write(full, os.path.join('lixbon-brand-fonts', os.path.relpath(full, ROOT)))
        for fn in ('README.md', 'LICENSE.md', 'OFL.txt'):
            zf.write(os.path.join(ROOT, fn), os.path.join('lixbon-brand-fonts', fn))
    print('zip', z)


if __name__ == '__main__':
    for sub in ('fonts',):
        shutil.rmtree(os.path.join(ROOT, sub), ignore_errors=True)
    sans()
    serif()
    css()
    zip_dist()
