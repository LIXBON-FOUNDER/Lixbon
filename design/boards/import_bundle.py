import base64
import gzip
import hashlib
import html
import json
import os
from pathlib import Path
import re

import argparse
from datetime import date

parser = argparse.ArgumentParser(description='Extrae tableros de las exportaciones HTML de Claude, sin ejecutar JavaScript.')
parser.add_argument('--ide', required=True, type=Path)
parser.add_argument('--ade', required=True, type=Path)
parser.add_argument('--mobile', required=True, type=Path)
parser.add_argument('--export-date', default=date.today().isoformat())
parser.add_argument('--version', default='Exportación actual; contiene cambios v116/v117. No es una copia histórica v111.')
args = parser.parse_args()
DEST = Path(__file__).resolve().parent
ROOT = DEST.parents[1]
catalog = json.loads((DEST / 'manifest.json').read_text(encoding='utf-8'))
names = {b['title']: Path(b['path']).name for b in catalog['boards']}
issues = {Path(b['path']).name: b['issues'] for b in catalog['boards']}

def section(source, kind):
    return json.loads(re.search(r'<script type="__bundler/' + kind + r'">(.*?)</script>', source, re.S)[1])

def decode(value):
    data = base64.b64decode(value['data'], validate=True)
    return gzip.decompress(data) if value.get('compressed') else data

def sha(data):
    return hashlib.sha256(data).hexdigest()

font_paths = {sha(p.read_bytes()): p for p in (ROOT / 'shared/fonts/fonts').rglob('*.woff2')}
manifest = []
for source_path, bundle, page in [(args.ide, 'ide.html', '06-ide'), (args.ade, 'ade.html', '05-ade'), (args.mobile, 'lixbon-design.html', '07-mobile')]:
    raw = source_path.read_bytes()
    outer = section(raw.decode('utf-8'), 'manifest')
    for value in outer.values():
        source = decode(value).decode('utf-8')
        title = html.unescape(re.search(r'<title>(.*?)</title>', source, re.S)[1])
        if 'hoy' in title.lower():
            continue
        if title not in names:
            raise ValueError(f'Tablero sin nombre conocido: {title}')
        name = names[title]
        folder = DEST / page
        folder.mkdir(exist_ok=True)
        template = section(source, 'template').replace('\r\n', '\n')
        assets = section(source, 'manifest')
        for key, asset in assets.items():
            data = decode(asset)
            digest = sha(data)
            if digest in font_paths:
                target = font_paths[digest]
                # La raíz del worktree conserva la misma estructura de shared/fonts.
                target = DEST.parents[1] / target.relative_to(ROOT)
            else:
                ext = {'font/woff2': '.woff2', 'text/javascript': '.js', 'image/svg+xml': '.svg', 'text/css': '.css'}.get(asset['mime'])
                if ext is None:
                    raise ValueError(f'Recurso inesperado: {asset["mime"]}')
                target = DEST / 'assets' / (digest[:16] + ext)
                target.parent.mkdir(exist_ok=True)
                target.write_bytes(data)
            template = template.replace(key, Path(os.path.relpath(target, folder)).as_posix())
        # El primer bloque es el ds.css común, embebido por el exportador de Claude.
        common = re.search(r'<style>(.*?)</style>', template, re.S)
        css = common[1]
        # Las URLs de fuentes deben resolverse desde design/boards, no desde la página.
        css = css.replace('../../../shared/', '../../shared/').replace('../assets/', 'assets/')
        css_path = DEST / 'ds.css'
        if css_path.exists() and css_path.read_text(encoding='utf-8') != css:
            css_path = DEST / ('ds-' + sha(css.encode())[:12] + '.css')
        css_path.write_text(css, encoding='utf-8', newline='\n')
        template = template[:common.start()] + '<link rel="stylesheet" href="../' + css_path.name + '">' + template[common.end():]
        (folder / name).write_text(template, encoding='utf-8', newline='\n')
        manifest.append({'title': title, 'path': page + '/' + name, 'issues': sorted(issues.get(name, [])), 'sourceBundle': bundle, 'sourceSha256': sha(raw), 'boardSha256': sha(template.encode())})
if len(manifest) != len(catalog['boards']) or len({b['path'] for b in manifest}) != len(manifest):
    raise ValueError('La exportación no contiene exactamente los 43 tableros del catálogo')
(DEST / 'manifest.json').write_text(json.dumps({'exportDate': args.export_date, 'source': 'https://claude.ai/artifact/NvpgXNKNQGsnQ3Kb5wKdEB', 'version': args.version, 'boards': manifest}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{len(manifest)} tableros exportados')
